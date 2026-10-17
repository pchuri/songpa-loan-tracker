# splib.py

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import inspect
import logging
import re
import unicodedata
from collections import defaultdict
from datetime import datetime
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup

from songpa_core.config import INDEX_URL, LOAN_URL, INTERLIBRARY_LOAN_URL, RESERVATION_URL, DOORAE_STATUS
from songpa_core.http_utils import SessionError, login, fetch, parse_cookie_header
from songpa_core.splib_utils import abbreviate_library_name, parse_index_content


USER_FETCH_TIMEOUT_SECONDS = 30

logger = logging.getLogger(__name__)

LOAN_PATH = urlparse(LOAN_URL).path
INTERLIBRARY_PATH = urlparse(INTERLIBRARY_LOAN_URL).path


ROW_CLASS = 'myArticle-list'


def _iter_boxes_in_document_order(soup):
    """행 래퍼가 없는 페이지용 예비 경로. infoBox/statusBox를 문서 순서로 짝짓는다."""
    pending = None
    for element in soup.find_all('div', class_=['infoBox', 'statusBox']):
        if 'infoBox' in element.get('class', []):
            if pending is not None:
                yield pending, None
            pending = element
        elif pending is not None:
            yield pending, element
            pending = None
    if pending is not None:
        yield pending, None


def _iter_rows(soup):
    """(infoBox, statusBox)를 행 단위로 짝지어 내놓는다.

    대출·상호대차·예약 세 페이지 모두 행마다 .myArticle-list 래퍼를 두고 그 안에
    infoBox와 statusBox를 하나씩 담는다(실측 확인). 래퍼 안에서 짝지으면 목록 밖의
    statusBox를 끌어오거나 한쪽이 빠진 행 때문에 이후 행이 밀리는 일이 구조적으로
    불가능해진다. statusBox가 없는 행은 (infoBox, None)으로 내놓는다.

    래퍼를 못 찾으면 문서 순서로 짝짓는 쪽으로 물러난다. 클래스 이름이 바뀌었을 때
    목록 전체가 조용히 비어버리는 것보다는 낫다.
    """
    rows = soup.find_all(class_=ROW_CLASS)
    if not rows:
        yield from _iter_boxes_in_document_order(soup)
        return
    for row in rows:
        info_box = row.find('div', class_='infoBox')
        if info_box is not None:
            yield info_box, row.find('div', class_='statusBox')


def _row_count(soup) -> int:
    """파싱 전 행 수. 파싱된 행이 이보다 적으면 일부 행을 읽지 못한 것이다."""
    rows = soup.find_all(class_=ROW_CLASS)
    if rows:
        return len(rows)
    return len(soup.find_all('div', class_='infoBox'))


CHECKBOX_PARTS = 5
RETURN_DELAY_FN = re.compile(r"fnReturnDelayProc\(([^)]+)\)")


def _clean_arg(text):
    return text.strip().strip("'\"")


def _copy_ids(container):
    """행 안의 체크박스 값(recKey^regNo^manageCode^...)이나 반납연기 링크에서 식별자를 읽는다.

    읽기 전용 식별(같은 권 판정·중복 제거)에만 쓴다. 없으면 빈 문자열.
    """
    rec_key = reg_no = manage_code = ""
    if container is None:
        return rec_key, reg_no, manage_code
    chk = container.find("input", {"name": "check"})
    if chk is not None and chk.has_attr("value"):
        parts = chk["value"].split("^", CHECKBOX_PARTS - 1)
        if len(parts) == CHECKBOX_PARTS:
            rec_key, reg_no, manage_code = parts[0].strip(), parts[1].strip(), parts[2].strip()
    if not rec_key:
        for element in container.find_all(["a", "button"]):
            match = RETURN_DELAY_FN.search(element.get("onclick", "") or "")
            if match:
                args = [_clean_arg(x) for x in match.group(1).split(",")]
                if len(args) >= 3:
                    rec_key, reg_no, manage_code = args[0], args[1], args[2]
                break
    return rec_key, reg_no, manage_code


def _row_container(info_box):
    parent = info_box.find_parent(class_=ROW_CLASS)
    return parent if parent is not None else info_box


def parse_loan_rows(content):
    """대출현황 페이지를 행 dict 리스트로. (rows, 원래 행 수)를 돌려준다.

    같은 제목의 두 권도 각각 남긴다. 식별자(rec_key/reg_no/manage_code)는 있으면 담는다.
    """
    soup = BeautifulSoup(content, 'html.parser')
    rows = []
    for info_box, status_box in _iter_rows(soup):
        title_div = info_box.find('div', class_='title')
        info_divs = info_box.find_all('div', class_='info')
        if not title_div or len(info_divs) < 2:
            continue
        first_span = info_divs[0].find('span')
        library_div = first_span.find('strong') if first_span else None
        date_info = info_divs[1].find_all('span')
        if not (library_div and date_info and len(date_info) == 2):
            continue
        rec_key, reg_no, manage_code = _copy_ids(_row_container(info_box))
        rows.append({
            "title": title_div.get_text(strip=True),
            "library": abbreviate_library_name(library_div.get_text(strip=True)),
            "loan_date": date_info[0].get_text(strip=True).replace('대출일 : ', ''),
            "due_date": date_info[1].get_text(strip=True).replace('반납예정일 : ', '').replace('반납일 : ', ''),
            "is_booksole": status_box is not None and "책솔이" in status_box.text,
            "rec_key": rec_key,
            "reg_no": reg_no,
            "manage_code": manage_code,
        })
    return rows, _row_count(soup)


def parse_loan_status(content):
    """예전 반환 형식(6-튜플)을 유지하는 호환 함수. 새 코드는 parse_loan_rows를 쓴다.

    마지막 값 books는 제목을 키로 하는 dict라 같은 제목 두 권이 하나로 합쳐진다.
    호환을 위해서만 남겨 두며 이 모듈의 집계에는 쓰지 않는다.
    """
    rows, _ = parse_loan_rows(content)
    book_titles = [r["title"] for r in rows]
    library_names = [r["library"] for r in rows]
    loan_dates = [r["loan_date"] for r in rows]
    due_dates = [r["due_date"] for r in rows]
    are_interlibrary_loans = [r["is_booksole"] for r in rows]
    books = {}
    for r in rows:
        books[r["title"]] = {
            "library": r["library"],
            "loan_date": r["loan_date"],
            "due_date": r["due_date"],
            "is_booksole": r["is_booksole"],
        }
    return book_titles, library_names, loan_dates, due_dates, are_interlibrary_loans, books


def extract_library_field(info_divs, label):
    for info_div in info_divs:
        spans = info_div.find_all('span')
        for span in spans:
            if label in span.get_text():
                return span.get_text(strip=True).split(':')[-1].strip()
    return None

# 아직 끝나지 않은 상호대차. 완료·복귀중·신청취소는 지난 기록이라 뺀다.
# Scriptable(scriptable/songpa-loan-tracker.js)의 ACTIVE_DOO_STATUSES와 같아야 한다.
ACTIVE_DOORAE_STATUSES = (
    DOORAE_STATUS.OBTAINED.value,
    DOORAE_STATUS.SENDING.value,
    DOORAE_STATUS.REQUESTED.value,
    DOORAE_STATUS.APPLIED.value,
)


CANCEL_BUTTON_TEXT = "신청취소"


def _doorae_status(status_box):
    """statusBox의 상태 낱말 하나를 돌려준다.

    신청 중인 건은 상태 칸에 취소 버튼 글자가 붙는다("요청중 신청취소", 공백 없이
    "요청중신청취소"). 첫 낱말에서 버튼 글자만 떼고, 나머지는 손대지 않는다.
    모르는 상태(예: 입수취소)를 아는 상태로 잘못 맞추지 않으려고 앞부분 일치는 쓰지 않는다.
    """
    text = status_box.get_text(" ", strip=True) if status_box else ""
    first = text.split()[0] if text else ""
    if first != CANCEL_BUTTON_TEXT and first.endswith(CANCEL_BUTTON_TEXT):
        first = first[: -len(CANCEL_BUTTON_TEXT)]
    return first


REG_NO_LABEL = "등록번호"


def parse_doorae_rows(content):
    """상호대차 페이지의 모든 행(지난 기록 포함). (entries, returning_count, 원래 행 수)."""
    soup = BeautifulSoup(content, 'html.parser')
    entries = []
    returning_count = 0

    for info_box, status_box in _iter_rows(soup):
        status = _doorae_status(status_box)
        # 복귀중 집계는 제목 유무와 무관하다. 제목 없는 행에서 빠지면
        # active_interlibrary_loans가 과다 보고된다.
        if status == DOORAE_STATUS.RETURNING.value:
            returning_count += 1

        title_div = info_box.find('div', class_='title')
        if not title_div:
            continue

        info_divs = info_box.find_all('div', class_='info')
        receiving_library = extract_library_field(info_divs, "수령도서관 :")
        providing_library = extract_library_field(info_divs, "제공도서관 :")
        _, reg_no, manage_code = _copy_ids(_row_container(info_box))
        if not reg_no:
            reg_no = extract_library_field(info_divs, REG_NO_LABEL) or ""

        entries.append({
            'title': title_div.get_text(strip=True),
            'status': status,
            'receiving_library': abbreviate_library_name(receiving_library),
            'providing_library': abbreviate_library_name(providing_library),
            'reg_no': reg_no,
            'manage_code': manage_code,
        })

    return entries, returning_count, _row_count(soup)


def parse_doorae_status(content):
    """상호대차 현황 페이지를 이송 중인 건 리스트로 파싱한다.

    같은 제목을 두 도서관에서 받는 중일 수 있어 제목으로 묶지 않는다. 제목을 dict
    키로 쓰면 두 건이 한 건으로 합쳐져 카드 한 장이 조용히 사라진다.
    """
    entries, returning_count, _ = parse_doorae_rows(content)
    in_transit = [
        {k: entry[k] for k in ('title', 'status', 'receiving_library', 'providing_library')}
        for entry in entries if entry['status'] in ACTIVE_DOORAE_STATUSES
    ]
    return in_transit, returning_count


RESERVATION_ID_PATTERN = re.compile(r"fnLoanReservationCancelProc\((\d+)\)")
DATE_PATTERN = re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})")
RANK_PATTERN = re.compile(r"예약순번\s*:\s*(\d+)")
WAITING_COUNT_PATTERN = re.compile(r"\((\d+)\s*명\s*예약\)")
PAGE_NUMBER_PATTERN = re.compile(r"^\d+$")
PAGE_LINK_PATTERN = re.compile(r"currentPageNo=(\d+)")
PAGE_CALL_PATTERN = re.compile(r"\(\s*['\"]?(\d+)['\"]?\s*\)")
MAX_PAGES = 20
# 한 목록에서 따라갈 최대 쪽수. 이보다 많으면 멈추고 partial로 알린다(조용히 자르지 않음).
MAX_LIST_PAGES = 50


def _squash(text):
    return re.sub(r"\s+", " ", text or "").strip()


def _find_date(text):
    """첫 날짜를 YYYY.MM.DD로 정규화해 돌려준다.

    페이지가 2026.8.29처럼 zero-pad 없이 내보내도 받아들이고, 반환은 항상
    zero-pad로 맞춘다. 날짜를 문자열로 정렬하는 곳이 있어서 표기가 섞이면
    2026.8.29가 2026.08.30보다 뒤로 가버린다.
    """
    match = DATE_PATTERN.search(text or "")
    if not match:
        return ""
    year, month, day = match.groups()
    return f"{year}.{int(month):02d}.{int(day):02d}"


def _labelled_span(info_divs, label):
    for info_div in info_divs:
        for span in info_div.find_all('span'):
            text = _squash(span.get_text())
            if text.startswith(label):
                return text
    return ""


EXPIRY_LABEL = "예약만기일"


def _expiry_date(status_box):
    """statusBox에서 예약만기일을 읽는다. 없으면 빈 문자열.

    라벨 뒤쪽만 훑는다. statusBox 전체에서 첫 날짜를 집으면 앞에 놓인 다른
    날짜(예약일 등)를 만기일로 오인한다. span 단위로 찾지 않는 이유는 라벨과
    날짜가 서로 다른 span에 담겨 있을 수 있어서다.
    """
    text = _squash(status_box.get_text(" "))
    if EXPIRY_LABEL not in text:
        return ""
    return _find_date(text.split(EXPIRY_LABEL, 1)[1])


def parse_reservation_status(content):
    """예약 현황 페이지를 예약 건 리스트로 파싱한다.

    같은 책을 여러 도서관에 걸어둔 예약은 서버에서도 각각 다른 예약 ID를 가진 별개 건이므로
    제목으로 묶지 않고 그대로 유지한다.
    """
    soup = BeautifulSoup(content, 'html.parser')
    reservations = []

    for info_box, status_box in _iter_rows(soup):
        title_div = info_box.find('div', class_='title')
        if not title_div:
            continue

        info_divs = info_box.find_all('div', class_='info')
        library = ""
        room = ""
        if info_divs:
            strong = info_divs[0].find('strong')
            if strong:
                library = abbreviate_library_name(_squash(strong.get_text()))
            spans = info_divs[0].find_all('span')
            if len(spans) > 1:
                room = _squash(spans[1].get_text())

        rank_text = _labelled_span(info_divs, "예약순번")
        rank_match = RANK_PATTERN.search(rank_text)
        waiting_match = WAITING_COUNT_PATTERN.search(rank_text)
        book_status = _labelled_span(info_divs, "도서현황")

        reservation_id = ""
        expiry_date = ""
        if status_box:
            cancel_link = status_box.find('a', onclick=True)
            if cancel_link:
                id_match = RESERVATION_ID_PATTERN.search(cancel_link['onclick'])
                if id_match:
                    reservation_id = id_match.group(1)
            # 수령 대기 여부는 도서현황(항상 "대출중")이 아니라 예약만기일 유무로만 판별된다.
            # 날짜는 그 라벨이 담긴 span 안에서만 찾는다. statusBox 전체에서 첫 날짜를
            # 집으면 앞에 놓인 다른 날짜(예약일 등)를 만기일로 오인한다.
            expiry_date = _expiry_date(status_box)

        reservations.append({
            "reservation_id": reservation_id,
            "title": _squash(title_div.get_text()),
            "library": library,
            "room": room,
            "reserved_date": _find_date(_labelled_span(info_divs, "예약일")),
            "rank": int(rank_match.group(1)) if rank_match else 0,
            "waiting_count": int(waiting_match.group(1)) if waiting_match else 0,
            "book_status": _squash(book_status.split(':')[-1]) if book_status else "",
            "due_date": _find_date(_labelled_span(info_divs, "반납예정일")),
            "expiry_date": expiry_date,
        })

    return reservations


def parse_last_page(content):
    """페이지 목록에 보이는 가장 큰 쪽 번호(상한 없음). 페이지 표시가 없으면 1.

    숫자 글자뿐 아니라 '다음/마지막' 링크의 currentPageNo=N, fnXxx(N) 호출도 본다.
    페이지 목록이 10쪽 단위 창으로만 보여도 다음 창으로 넘어가며 다시 읽는다.
    """
    soup = BeautifulSoup(content, 'html.parser')
    paging = soup.find(class_='paging')
    if not paging:
        return 1
    pages = [int(text) for text in paging.stripped_strings if PAGE_NUMBER_PATTERN.match(text)]
    for element in paging.find_all(["a", "button"]):
        for attr in ("href", "onclick"):
            value = element.get(attr) or ""
            pages.extend(int(m) for m in PAGE_LINK_PATTERN.findall(value))
            pages.extend(int(m) for m in PAGE_CALL_PATTERN.findall(value))
    pages = [p for p in pages if p >= 1]
    return max(pages) if pages else 1


def parse_max_page(content):
    """페이지 목록에서 마지막 페이지 번호를 읽는다. 페이지 표시가 없으면 1.

    페이지 표기가 예상과 다를 때 수백 번씩 요청하는 일이 없도록 상한을 둔다.
    (호환용. 이 모듈의 수집은 collect_pages가 상한 도달을 partial로 알린다.)
    """
    soup = BeautifulSoup(content, 'html.parser')
    paging = soup.find(class_='paging')
    if not paging:
        return 1
    pages = [int(text) for text in paging.stripped_strings if PAGE_NUMBER_PATTERN.match(text)]
    if not pages:
        return 1
    last_page = max(pages)
    if last_page > MAX_PAGES:
        logger.warning("Page list reported %d pages, capping at %d", last_page, MAX_PAGES)
        return MAX_PAGES
    return last_page


def page_url(base_url: str, page: int) -> str:
    return base_url if page == 1 else f"{base_url}?currentPageNo={page}"


async def collect_pages(fetch_page, parse_page, key_of, *, kind: str, max_pages: int = MAX_LIST_PAGES):
    """목록을 끝까지 따라가 모은다. (items, warnings, partial).

    - fetch_page(page) -> 검증된 HTML (fetch가 URL·로그인 화면·footer를 검사)
    - parse_page(html) -> (items, 원래 행 수)
    - key_of(item) -> (stable 여부, 키). 안정 식별자가 같은 행은 한 번만 담는다.

    멈추는 조건: 페이지 표시상 마지막 쪽 도달 / 앞 페이지와 같은 행만 반복(반복 페이지) /
    마지막 쪽 전인데 빈 쪽 / max_pages 도달. 마지막 셋은 partial=True와 경고를 남긴다.
    읽지 못한 행이 있으면 0건·완료로 보지 않고 경고와 partial을 남긴다.
    """
    items, warnings = [], []
    partial = False
    seen_keys = set()
    seen_items = {}
    seen_pages = set()
    last_page = 1
    page = 1
    while True:
        content = await fetch_page(page)
        page_items, raw_rows = parse_page(content)
        if raw_rows > len(page_items):
            warnings.append(f"{kind} {page}쪽: {raw_rows - len(page_items)}개 행을 읽지 못했습니다")
            partial = True
        keys = [key_of(item) for item in page_items]
        fingerprint = tuple(k for _, k in keys)
        if page > 1 and page_items and (
            fingerprint in seen_pages or all(k in seen_keys for _, k in keys)
        ):
            warnings.append(f"{kind}: {page}쪽이 앞 쪽과 같은 행을 반복합니다. 여기서 멈춥니다")
            partial = True
            break
        seen_pages.add(fingerprint)
        for item, (stable, key) in zip(page_items, keys):
            if stable and key in seen_keys:
                if seen_items.get(key) != item:
                    # 같은 식별자인데 내용이 다르다: 어느 쪽이 맞는지 알 수 없으니 완전한 결과로 보지 않는다.
                    warnings.append(f"{kind}: 같은 식별자의 행이 서로 다른 내용으로 나왔습니다. 결과가 불완전할 수 있습니다")
                    partial = True
                else:
                    warnings.append(f"{kind}: 같은 식별자의 행이 두 번 나와 한 번만 셉니다")
                continue
            seen_keys.add(key)
            if stable:
                seen_items[key] = item
            items.append(item)
        last_page = max(last_page, parse_last_page(content))
        if page >= last_page:
            break
        if not page_items:
            warnings.append(f"{kind}: {page}쪽이 비어 있지만 페이지 표시는 {last_page}쪽까지입니다")
            partial = True
            break
        if page >= max_pages:
            warnings.append(f"{kind}: {max_pages}쪽에서 멈췄습니다 (표시된 마지막 쪽 {last_page})")
            partial = True
            break
        page += 1
    return items, warnings, partial


def _loan_key(row):
    if row.get("rec_key"):
        return True, ("rec", row["rec_key"])
    if row.get("reg_no") and row.get("manage_code"):
        return True, ("reg", row["manage_code"], row["reg_no"])
    return False, ("row", row["title"], row["library"], row["loan_date"], row["due_date"])


def _doorae_key(entry):
    return False, ("row", entry["title"], entry["status"], entry["receiving_library"] or "",
                   entry["providing_library"] or "", entry.get("reg_no") or "")


def _reservation_key(reservation):
    if reservation.get("reservation_id"):
        return True, ("id", reservation["reservation_id"])
    return False, ("row", reservation["title"], reservation["library"], reservation["reserved_date"],
                   reservation["rank"], reservation["expiry_date"])


def count_books_by_library(book_titles: list, library_names: list) -> dict:
    if len(book_titles) != len(library_names):
        raise ValueError("The list of book titles and library names must be the same length.")

    summary = defaultdict(int)
    for title, library_name in zip(book_titles, library_names):
        summary[library_name] += 1
    return summary


GREEN_COLOR = "#008000"
BLUE_COLOR = "#000080"


def build_books_sorted_by_due_date(book_titles, library_names, loan_dates, due_dates, is_booksoles):
    if len(book_titles) == 0:
        return [], 0

    def is_due_soon(due_date_str):
        try:
            due_date = datetime.strptime(due_date_str, "%Y.%m.%d")
            return (due_date - datetime.now()).days <= 1
        except ValueError:
            return False

    combined_data = list(zip(book_titles, library_names, loan_dates, due_dates, is_booksoles))
    sorted_data = sorted(combined_data, key=lambda x: x[3])
    book_list = []
    booksole_count = 0
    for book in sorted_data:
        due_soon = is_due_soon(book[3])
        title_color = GREEN_COLOR if book[4] else "#000000"
        color = "#FF0000" if due_soon else "#000000"
        weight = "bold" if due_soon else "regular"
        if book[4]:
            booksole_count += 1
        book_list.append({
            "title": book[0],
            "title_color": title_color,
            "weight": weight,
            "library": book[1],
            "loan_date": book[2],
            "due_date": book[3],
            "due_date_color": color,
            "is_booksole": book[4]
        })
    return book_list, booksole_count


def _copy_join_key(copy_id, provider):
    if not copy_id or not provider:
        return None
    return copy_id, provider


def merge_loans_and_interlibrary(loan_rows, doorae_entries):
    """대출 행과 진행 중 상호대차를 합친다. (books, booksole_count, warnings).

    - 제목만 같다고 숨기거나 고쳐 쓰지 않는다. 같은 제목의 대출 두 권, 대출과 같은 제목의
      입수(찾아올 책)도 각각 남긴다.
    - 상호대차 건을 대출 행에 붙이는(같은 권으로 보는) 경우는 등록번호(reg_no)와 제공
      도서관이 양쪽에서 모두 확인되고, 그 조합이 양쪽 목록에서 하나뿐일 때만이다.
    - 붙이지 못한 같은 제목 건은 possible_duplicate 표시와 경고를 남긴다.
    """
    warnings = []
    loan_index = defaultdict(list)
    for i, row in enumerate(loan_rows):
        key = _copy_join_key(row.get("reg_no"), row.get("library"))
        if key:
            loan_index[key].append(i)
    entry_index = defaultdict(list)
    for j, entry in enumerate(doorae_entries):
        key = _copy_join_key(entry.get("reg_no"), entry.get("providing_library"))
        if key:
            entry_index[key].append(j)

    joined = {}  # loan index -> entry index
    for key, entry_ids in entry_index.items():
        loan_ids = loan_index.get(key, [])
        if len(entry_ids) == 1 and len(loan_ids) == 1:
            joined[loan_ids[0]] = entry_ids[0]
        elif loan_ids:
            warnings.append("같은 등록번호 건이 여러 개라 상호대차와 대출을 묶지 않았습니다")
    joined_entries = set(joined.values())

    books_data = []
    booksole_count = 0
    loan_titles = defaultdict(int)
    for i, row in enumerate(loan_rows):
        loan_titles[row["title"]] += 1
        is_booksole = row["is_booksole"] or i in joined
        if is_booksole:
            booksole_count += 1
        book = {
            "title": row["title"],
            "title_color": GREEN_COLOR if is_booksole else "#000000",
            "weight": "regular",
            "library": row["library"],
            "loan_date": row["loan_date"],
            "due_date": row["due_date"],
            "due_date_color": "#000000",
            "is_booksole": is_booksole,
        }
        if i in joined:
            entry = doorae_entries[joined[i]]
            if entry.get("receiving_library"):
                book["receiving_library"] = entry["receiving_library"]
            if entry.get("providing_library"):
                book["providing_library"] = entry["providing_library"]
        books_data.append(book)
    books_data.sort(key=lambda b: b["due_date"])

    collisions = 0
    for j, entry in enumerate(doorae_entries):
        if j in joined_entries:
            continue
        book = {
            "title": entry['title'],
            "receiving_library": entry['receiving_library'],
            "providing_library": entry['providing_library'],
            "title_color": BLUE_COLOR,
            "weight": "bold",
            "library": "",
            "loan_date": "",
            "due_date": entry['status'],
            "due_date_color": BLUE_COLOR,
            "is_booksole": True,
        }
        if loan_titles.get(entry['title']):
            book["possible_duplicate"] = True
            collisions += 1
        books_data.append(book)
    if collisions:
        warnings.append(
            f"대출 중인 책과 제목이 같은 진행 중 상호대차 {collisions}건을 따로 표시했습니다 "
            "(같은 권인지 사이트에서 확인 필요)"
        )
    return books_data, booksole_count, warnings


def normalize_identity(name) -> str:
    return unicodedata.normalize("NFC", re.sub(r"\s+", "", str(name or ""))).casefold()


def _session_digest(cookies: str) -> str:
    values = sorted(f"{k}={v}" for k, v in parse_cookie_header(cookies).items())
    return hashlib.sha256("\n".join(values).encode()).hexdigest()


def _accepts_pinned(fetch_fn) -> bool:
    """fetch가 pinned_cookies를 받는지. 예전 형태(url, session)로 바꿔 끼운 fetch와도 호환한다."""
    try:
        params = inspect.signature(fetch_fn).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(p.name == "pinned_cookies" or p.kind is inspect.Parameter.VAR_KEYWORD for p in params)


# 한 번의 get_infos_async 실행 안에서 계정 간 세션 겹침을 보기 위한 상태.
# _fetch_user_info의 기존 호출 형태(user_id, password)를 바꾸지 않으려고 컨텍스트 변수로 넘긴다.
_RUN_CONTEXT: contextvars.ContextVar = contextvars.ContextVar("songpa_run_context", default=None)


async def _fetch_user_info(user_id: str, password: str) -> dict:
    run = _RUN_CONTEXT.get()
    cookies = await login(user_id, password)
    if run is not None:
        digest = _session_digest(cookies)
        other = run["sessions"].get(digest)
        if other is not None and other != run["index"]:
            run["collisions"].add(other)
            raise SessionError("다른 계정과 같은 세션을 받았습니다. 두 계정 결과를 모두 쓰지 않습니다.")
        run["sessions"][digest] = run["index"]
    pinned = parse_cookie_header(cookies)
    headers = {"Cookie": cookies}
    warnings = []
    partial = False

    # 서버가 보낸 Set-Cookie를 조용히 합치지 않도록 쿠키 저장소를 쓰지 않는다(세션 고정).
    fetch_kwargs = {"pinned_cookies": pinned} if _accepts_pinned(fetch) else {}

    async with aiohttp.ClientSession(headers=headers, cookie_jar=aiohttp.DummyCookieJar()) as session:
        async def get(url):
            return await fetch(url, session, **fetch_kwargs)

        index_content = await get(INDEX_URL)
        name, total_borrowed_books, interlibrary_loans = parse_index_content(index_content)
        if not normalize_identity(name):
            # 빈 회원 표시끼리는 시작·끝 비교에서 "같다"가 되므로 신원 확인으로 쓰지 않는다.
            raise SessionError("사이트의 회원 표시가 비어 있습니다 (로그인 세션 아님). 결과를 쓰지 않습니다.")
        expected = run.get("expected_name") if run else None
        if expected and normalize_identity(expected) != normalize_identity(name):
            raise SessionError("사이트에 표시된 회원이 설정한 신원과 다릅니다. 결과를 쓰지 않습니다.")

        loan_rows, w, p = await collect_pages(
            lambda page: get(page_url(LOAN_URL, page)), parse_loan_rows, _loan_key, kind="대출")
        warnings += w
        partial |= p

        doorae_all = []
        returning_holder = {"count": 0}

        def parse_doorae_page(content):
            entries, returning, raw = parse_doorae_rows(content)
            returning_holder["count"] += returning
            return entries, raw

        doorae_all, w, p = await collect_pages(
            lambda page: get(page_url(INTERLIBRARY_LOAN_URL, page)), parse_doorae_page, _doorae_key,
            kind="상호대차")
        warnings += w
        partial |= p
        interlibrary_loans_to_return = returning_holder["count"]

        reservations, w, p = await collect_pages(
            lambda page: get(page_url(RESERVATION_URL, page)),
            lambda content: (parse_reservation_status(content), _row_count(BeautifulSoup(content, 'html.parser'))),
            _reservation_key, kind="예약")
        warnings += w
        partial |= p

        # 처음 본 회원과 끝날 때의 회원이 같은지 다시 본다(도중에 세션이 다른 계정으로 바뀌는 경우).
        end_name, _, _ = parse_index_content(await get(INDEX_URL))
        if not normalize_identity(end_name) or normalize_identity(end_name) != normalize_identity(name):
            raise SessionError("조회 도중 사이트의 회원 표시가 바뀌었습니다. 결과를 쓰지 않습니다.")

    if len(loan_rows) < total_borrowed_books:
        warnings.append(f"첫 화면의 대출 {total_borrowed_books}권보다 목록이 적습니다 ({len(loan_rows)}권)")
        partial = True

    doorae_entries = [e for e in doorae_all if e['status'] in ACTIVE_DOORAE_STATUSES]
    books_data, booksole_count, merge_warnings = merge_loans_and_interlibrary(loan_rows, doorae_entries)
    warnings += merge_warnings

    active_interlibrary_loans = interlibrary_loans - interlibrary_loans_to_return
    # 첫 화면 숫자에서 뺀 추정치다. 실제 찾아올 책은 상태가 '입수'인 행으로 판단한다.
    pending_interlibrary_pickups = interlibrary_loans - interlibrary_loans_to_return - booksole_count

    books = []
    for book in books_data:
        item = {
            "title": book["title"],
            "due_date": book["due_date"],
            "is_interlibrary": book["is_booksole"],
            "library": book.get("receiving_library") if book["is_booksole"] and book.get("receiving_library")
            else book["library"],
            "providing_library": book.get("providing_library"),
        }
        if book.get("possible_duplicate"):
            item["possible_duplicate"] = True
        books.append(item)

    result = {
        "name": name,
        "books": books,
        "reservations": reservations,
        "total_borrowed_books": total_borrowed_books,
        "active_interlibrary_loans": active_interlibrary_loans,
        "pending_interlibrary_pickups": pending_interlibrary_pickups,
    }
    if warnings:
        result["warnings"] = warnings
    if partial:
        result["partial"] = True
    return result


async def _fetch_user_info_with_timeout(user_id: str, password: str) -> dict:
    return await asyncio.wait_for(
        _fetch_user_info(user_id, password),
        timeout=USER_FETCH_TIMEOUT_SECONDS,
    )


DUPLICATE_ACCOUNT_ERROR = "같은 아이디가 두 번 등록돼 있어 조회하지 않았습니다. 계정 설정을 정리해 주세요."
SESSION_COLLISION_ERROR = "다른 계정과 같은 세션이 감지돼 이 계정 결과를 쓰지 않습니다."
SAME_NAME_WARNING = (
    "다른 계정과 사이트 회원 표시가 같습니다. 동명이인인지 세션 혼선인지 구별할 수 없어 합계를 확정하지 않습니다"
)


def normalize_user_id(user_id) -> str:
    return str(user_id or "").strip().casefold()


def _error_entry(credential, message):
    return {
        "name": credential.get("userId", "?"),
        "books": [],
        "reservations": [],
        "total_borrowed_books": 0,
        "active_interlibrary_loans": 0,
        "pending_interlibrary_pickups": 0,
        "error": message,
    }


async def get_infos_async(credentials: list[dict]) -> list[dict]:
    """Fetch status for each credential. Failed users are returned as error entries instead of aborting the batch.

    계정은 한 번에 하나씩 조회한다(같은 서버에 동시 세션을 만들지 않으려고). 같은 아이디가
    두 번 있으면 로그인 전에 둘 다 오류로 돌려준다. 계정끼리 같은 세션을 받으면 둘 다 오류다.
    credential에 expected_name이 있으면 사이트의 회원 표시와 대조한다.
    """
    counts = defaultdict(int)
    for c in credentials:
        counts[normalize_user_id(c.get("userId"))] += 1

    run = {"sessions": {}, "collisions": set(), "index": None, "expected_name": None}
    infos = []
    for index, credential in enumerate(credentials):
        if counts[normalize_user_id(credential.get("userId"))] > 1:
            infos.append(_error_entry(credential, DUPLICATE_ACCOUNT_ERROR))
            continue
        run["index"] = index
        run["expected_name"] = credential.get("expected_name")
        token = _RUN_CONTEXT.set(run)
        try:
            result = await _fetch_user_info_with_timeout(credential["userId"], credential["password"])
        except Exception as exc:  # noqa: BLE001 - 계정 하나의 실패가 전체를 막지 않게
            result = exc
        finally:
            _RUN_CONTEXT.reset(token)
        if isinstance(result, Exception):
            error_message = "조회 시간이 초과되었습니다" if isinstance(result, asyncio.TimeoutError) else str(result)
            # 아이디·쿠키는 로그에 남기지 않는다.
            logger.warning("Failed to fetch status for account #%d: %s", index + 1, type(result).__name__)
            infos.append(_error_entry(credential, error_message))
        else:
            infos.append(result)

    for index in run["collisions"]:
        infos[index] = _error_entry(credentials[index], SESSION_COLLISION_ERROR)

    # 서로 다른 계정이 같은 회원 표시를 보이면 동명이인인지, 서버 쪽 세션 혼선으로 한 계정의 목록을 두 번 받은
    # 것인지 이름만으로는 구별할 수 없다(expected_name 대조도 이름 비교라 마찬가지). 그래서 그 계정들을
    # partial로 두어 합계를 확정치로 보지 않게 한다(목록은 그대로 보여 준다).
    names = defaultdict(list)
    for index, info in enumerate(infos):
        if not info.get("error") and info.get("name"):
            names[normalize_identity(info["name"])].append(index)
    for indexes in names.values():
        if len(indexes) > 1:
            for index in indexes:
                infos[index].setdefault("warnings", []).append(SAME_NAME_WARNING)
                infos[index]["partial"] = True
    return infos
