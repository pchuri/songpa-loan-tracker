# splib.py

import asyncio
import logging
import re
from collections import defaultdict
from datetime import datetime
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup

from core.config import INDEX_URL, LOAN_URL, INTERLIBRARY_LOAN_URL, RESERVATION_URL, DOORAE_STATUS
from core.http_utils import login, fetch
from core.splib_utils import abbreviate_library_name, parse_index_content


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


def parse_loan_status(content):
    soup = BeautifulSoup(content, 'html.parser')
    books = {}
    book_titles = []
    library_names = []
    loan_dates = []
    due_dates = []
    are_interlibrary_loans = []

    def extract_info(info_box):
        title_div = info_box.find('div', class_='title')
        library_div = info_box.find('div', class_='info').find('span').find('strong')
        date_info = info_box.find_all('div', class_='info')[1].find_all('span')
        return title_div, library_div, date_info

    for info_box, status_box in _iter_rows(soup):
        title_div, library_div, date_info = extract_info(info_box)
        if not (title_div and library_div and date_info and len(date_info) == 2):
            continue
        book_titles.append(title_div.get_text(strip=True))
        library_names.append(abbreviate_library_name(library_div.get_text(strip=True)))
        loan_dates.append(date_info[0].get_text(strip=True).replace('대출일 : ', ''))
        due_dates.append(date_info[1].get_text(strip=True).replace('반납예정일 : ', '').replace('반납일 : ', ''))
        are_interlibrary_loans.append(status_box is not None and "책솔이" in status_box.text)

    for title, library, loan_date, due_date, is_booksole in zip(book_titles, library_names, loan_dates, due_dates, are_interlibrary_loans):
        books[title] = {
            "library": library,
            "loan_date": loan_date,
            "due_date": due_date,
            "is_booksole": is_booksole
        }

    return book_titles, library_names, loan_dates, due_dates, are_interlibrary_loans, books

def extract_library_field(info_divs, label):
    for info_div in info_divs:
        spans = info_div.find_all('span')
        for span in spans:
            if label in span.get_text():
                return span.get_text(strip=True).split(':')[-1].strip()
    return None

def parse_doorae_status(content):
    """상호대차 현황 페이지를 이송 중인 건 리스트로 파싱한다.

    같은 제목을 두 도서관에서 받는 중일 수 있어 제목으로 묶지 않는다. 제목을 dict
    키로 쓰면 두 건이 한 건으로 합쳐져 카드 한 장이 조용히 사라진다.
    """
    soup = BeautifulSoup(content, 'html.parser')
    entries = []
    returning_count = 0

    for info_box, status_box in _iter_rows(soup):
        status = status_box.get_text(strip=True) if status_box else ""
        if status == DOORAE_STATUS.REQUESTED_RAW.value:
            status = DOORAE_STATUS.REQUESTED.value
        # 복귀중 집계는 제목 유무와 무관하다. 제목 없는 행에서 빠지면
        # active_interlibrary_loans가 과다 보고된다.
        if DOORAE_STATUS.RETURNING.value in status:
            returning_count += 1

        title_div = info_box.find('div', class_='title')
        if not title_div:
            continue

        info_divs = info_box.find_all('div', class_='info')
        receiving_library = extract_library_field(info_divs, "수령도서관 :")
        providing_library = extract_library_field(info_divs, "제공도서관 :")

        entries.append({
            'title': title_div.get_text(strip=True),
            'status': status,
            'receiving_library': abbreviate_library_name(receiving_library),
            'providing_library': abbreviate_library_name(providing_library),
        })

    in_transit = [
        entry for entry in entries
        if entry['status'] in (
            DOORAE_STATUS.SENDING.value,
            DOORAE_STATUS.OBTAINED.value,
            DOORAE_STATUS.REQUESTED.value,
        )
    ]

    return in_transit, returning_count


RESERVATION_ID_PATTERN = re.compile(r"fnLoanReservationCancelProc\((\d+)\)")
DATE_PATTERN = re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})")
RANK_PATTERN = re.compile(r"예약순번\s*:\s*(\d+)")
WAITING_COUNT_PATTERN = re.compile(r"\((\d+)\s*명\s*예약\)")
PAGE_NUMBER_PATTERN = re.compile(r"^\d+$")
MAX_PAGES = 20


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


def parse_max_page(content):
    """페이지 목록에서 마지막 페이지 번호를 읽는다. 페이지 표시가 없으면 1.

    페이지 표기가 예상과 다를 때 수백 번씩 요청하는 일이 없도록 상한을 둔다.
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


async def _fetch_user_info(user_id: str, password: str) -> dict:
    cookies = await login(user_id, password)
    headers = {"Cookie": cookies}

    async with aiohttp.ClientSession(headers=headers) as session:
        index_content = await fetch(INDEX_URL, session)
        name, total_borrowed_books, interlibrary_loans = parse_index_content(index_content)

        loan_status_content = await fetch(LOAN_URL, session)
        book_titles, library_names, loan_dates, due_dates, is_booksoles, loan_books = parse_loan_status(loan_status_content)

        loan_status_content2 = await fetch(f"{LOAN_URL}?currentPageNo=2", session)
        book_titles2, library_names2, loan_dates2, due_dates2, is_booksoles2, loan_books2 = parse_loan_status(
            loan_status_content2)

        book_titles.extend(book_titles2)
        library_names.extend(library_names2)
        loan_dates.extend(loan_dates2)
        due_dates.extend(due_dates2)
        is_booksoles.extend(is_booksoles2)
        loan_books = loan_books | loan_books2

        doorae_status_content = await fetch(INTERLIBRARY_LOAN_URL, session)
        doorae_entries, interlibrary_loans_to_return = parse_doorae_status(doorae_status_content)

        doorae_status_content2 = await fetch(f"{INTERLIBRARY_LOAN_URL}?currentPageNo=2", session)
        doorae_entries2, interlibrary_loans_to_return2 = parse_doorae_status(doorae_status_content2)

        doorae_entries += doorae_entries2
        interlibrary_loans_to_return += interlibrary_loans_to_return2

        reservation_content = await fetch(RESERVATION_URL, session)
        reservations = parse_reservation_status(reservation_content)
        for page in range(2, parse_max_page(reservation_content) + 1):
            page_content = await fetch(f"{RESERVATION_URL}?currentPageNo={page}", session)
            reservations.extend(parse_reservation_status(page_content))

    books_data, booksole_count = build_books_sorted_by_due_date(
        book_titles, library_names, loan_dates, due_dates, is_booksoles
    )

    # 이미 대출된 책에 상호대차 정보를 얹을 때만 제목으로 찾는다. 같은 제목이 여러 건이면
    # 먼저 나온 건을 쓴다 — 어느 쪽을 골라도 도서관 표기만 달라진다.
    doorae_by_title = {}
    for entry in doorae_entries:
        doorae_by_title.setdefault(entry['title'], entry)

    for book in books_data:
        if book['is_booksole'] or book['title'] in doorae_by_title:
            book['is_booksole'] = True
            doorae_info = doorae_by_title.get(book['title'], {})
            if doorae_info.get('receiving_library'):
                book['receiving_library'] = doorae_info['receiving_library']
            if doorae_info.get('providing_library'):
                book['providing_library'] = doorae_info['providing_library']

    for entry in doorae_entries:
        if entry['title'] in loan_books:
            continue
        books_data.append({
            "title": entry['title'],
            "receiving_library": entry['receiving_library'],
            "providing_library": entry['providing_library'],
            "title_color": BLUE_COLOR,
            "weight": "bold",
            "library": "",
            "loan_date": "",
            "due_date": entry['status'],
            "due_date_color": BLUE_COLOR,
            "is_booksole": True
        })

    active_interlibrary_loans = interlibrary_loans - interlibrary_loans_to_return
    pending_interlibrary_pickups = interlibrary_loans - interlibrary_loans_to_return - booksole_count

    books = [{
        "title": book["title"],
        "due_date": book["due_date"],
        "is_interlibrary": book["is_booksole"],
        "library": book.get("receiving_library") if book["is_booksole"] else book["library"],
        "providing_library": book.get("providing_library"),
    } for book in books_data]

    return {
        "name": name,
        "books": books,
        "reservations": reservations,
        "total_borrowed_books": total_borrowed_books,
        "active_interlibrary_loans": active_interlibrary_loans,
        "pending_interlibrary_pickups": pending_interlibrary_pickups,
    }


async def _fetch_user_info_with_timeout(user_id: str, password: str) -> dict:
    return await asyncio.wait_for(
        _fetch_user_info(user_id, password),
        timeout=USER_FETCH_TIMEOUT_SECONDS,
    )


async def get_infos_async(credentials: list[dict]) -> list[dict]:
    """Fetch status for each credential. Failed users are returned as error entries instead of aborting the batch."""
    tasks = [_fetch_user_info_with_timeout(c["userId"], c["password"]) for c in credentials]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    infos = []
    for credential, result in zip(credentials, results):
        if isinstance(result, Exception):
            error_message = "조회 시간이 초과되었습니다" if isinstance(result, asyncio.TimeoutError) else str(result)
            logger.warning("Failed to fetch status for user %s: %s", credential.get("userId"), result)
            infos.append({
                "name": credential.get("userId", "?"),
                "books": [],
                "reservations": [],
                "total_borrowed_books": 0,
                "active_interlibrary_loans": 0,
                "pending_interlibrary_pickups": 0,
                "error": error_message,
            })
        else:
            infos.append(result)
    return infos
