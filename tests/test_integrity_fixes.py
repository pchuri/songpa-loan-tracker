"""무결성 수정 회귀 테스트 (합성 데이터만, 네트워크·실계정·OS 알림 없음).

- 같은 아이디 중복 거부 (로그인·키체인 접근 전에)
- fetch: 최종 URL·로그인 화면·세션 쿠키 교체 검사, 세션 오류는 재시도하지 않음
- 3쪽 이상 페이지, 반복 페이지·빈 쪽·쪽수 상한에서 partial
- 같은 제목 두 권 유지, 대출과 같은 제목의 입수 상호대차 유지(+경고), 등록번호+제공 도서관으로만 묶음
- 계정 간 같은 세션·조회 중 회원 표시 변경은 오류
- 보고서: 예약 ID 유지, 실패 계정은 "모름"(partial), 합계 미확정 표시
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from urllib.parse import urlparse

import pytest

from songpa_cli.accounts import AccountError, AccountStore
from songpa_cli.report import build_report, incomplete_notice, normalize_reservation
from songpa_cli.text import render_text
from songpa_core import http_utils, splib
from songpa_core.config import INDEX_URL, INTERLIBRARY_LOAN_URL, LOAN_URL, RESERVATION_URL
from songpa_core.http_utils import FetchError, SessionError

FOOTER = "<!-- footer -->"
LOAN_PATH = urlparse(LOAN_URL).path
ILL_PATH = urlparse(INTERLIBRARY_LOAN_URL).path


# ---------------------------------------------------------------- 합성 HTML

def page(body: str, paging: str = "") -> str:
    return f"<html><body>{body}{paging}{FOOTER}</body></html>"


def paging_links(last: int) -> str:
    links = "".join(f'<a href="?currentPageNo={n}">{n}</a>' for n in range(1, last + 1))
    return f'<div class="paging">{links}</div>'


def loan_row(title, due="2026.10.20", rec="", reg="", manage="MA", library="가상중앙도서관", status="대출중"):
    check = f'<input type="checkbox" name="check" value="{rec}^{reg}^{manage}^BO^0">' if rec else ""
    return (
        '<div class="myArticle-list"><div class="infoBox">'
        f'<div class="title">{title}</div>'
        f'<div class="info"><span><strong>{library}</strong></span></div>'
        f'<div class="info"><span>대출일 : 2026.10.01</span><span>반납예정일 : {due}</span></div>'
        f'</div><div class="statusBox">{status}{check}</div></div>'
    )


def ill_row(title, status="입수", provider="가상서쪽도서관", receiver="가상중앙도서관", reg=""):
    reg_span = f"<span>등록번호 : {reg}</span>" if reg else ""
    return (
        '<div class="myArticle-list"><div class="infoBox">'
        f'<div class="title">{title}</div>'
        f'<div class="info"><span>수령도서관 : {receiver}</span><span>제공도서관 : {provider}</span>{reg_span}</div>'
        f'</div><div class="statusBox">{status}</div></div>'
    )


def reservation_row(title, rid):
    return (
        '<div class="myArticle-list"><div class="infoBox">'
        f'<div class="title">{title}</div>'
        '<div class="info"><span><strong>가상중앙도서관</strong></span><span>일반자료실</span></div>'
        '<div class="info"><span>예약일 : 2026.10.01</span><span>예약순번 : 2 (3명 예약)</span></div>'
        f'</div><div class="statusBox"><a onclick="fnLoanReservationCancelProc({rid})">취소</a></div></div>'
    )


def index_page(name="테스트회원", loans=0, ill=0):
    return page(
        f'<div class="barcodeInfo">{name}<span>회원증</span></div>'
        f'<a href="{LOAN_PATH}"><span>{loans}</span></a>'
        f'<a href="{ILL_PATH}"><span>{ill}</span></a>'
    )


# ---------------------------------------------------------------- 가짜 HTTP

class FakeResponse:
    def __init__(self, text, status=200, url="", cookies=None):
        self._text, self.status, self.url, self.cookies = text, status, url, cookies or {}

    async def text(self):
        return self._text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """fetch가 쓰는 session.get만 흉내 낸다. 리다이렉트를 따라가지 않도록 요청했는지 매번 확인한다."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0
        self.requests = []

    def get(self, url, timeout=None, allow_redirects=True):
        # aiohttp 기본값은 True이므로 fetch가 명시적으로 False를 넘겨야 한다.
        assert allow_redirects is False, "fetch는 리다이렉트를 따라가면 안 된다"
        assert timeout is not None
        self.calls += 1
        self.requests.append((url, allow_redirects))
        return self.responses.pop(0)


@pytest.fixture
def no_sleep(monkeypatch):
    async def instant(_seconds):
        return None
    monkeypatch.setattr(http_utils.asyncio, "sleep", instant)


# ---------------------------------------------------------------- 계정 중복

class ExplodingKeyring:
    """중복 검사가 키체인보다 먼저인지 확인한다. 읽기를 시도하면 실패."""

    def get_password(self, *_):
        raise AssertionError("키체인을 읽으면 안 된다")

    def set_password(self, *_):
        raise AssertionError("쓰기 없음")


def write_accounts(tmp_path, accounts):
    import json
    (tmp_path / "accounts.json").write_text(json.dumps({"accounts": accounts}), encoding="utf-8")


def test_duplicate_normalized_user_ids_rejected_before_keyring(tmp_path):
    write_accounts(tmp_path, [
        {"label": "별칭1", "userId": "user01", "password_store": "keyring"},
        {"label": "별칭2", "userId": " USER01 ", "password_store": "keyring"},
        {"label": "별칭3", "userId": "user03", "password": "pw3"},
    ])
    store = AccountStore(tmp_path, keyring_module=ExplodingKeyring())
    with pytest.raises(AccountError) as err:
        store.credentials()
    message = str(err.value)
    assert "별칭1" in message and "별칭2" in message
    assert "user01" not in message.lower()  # 아이디는 오류 문구에 넣지 않는다
    # 필터를 줘도 중복이 있는 설정은 거부한다(어느 쪽으로 로그인할지 모호하므로)
    with pytest.raises(AccountError):
        store.credentials(["별칭3"])
    # 목록 보기·삭제로 고칠 수 있어야 한다
    assert len(store.entries()) == 3


def test_credentials_filter_and_optional_identity_without_duplicates(tmp_path):
    write_accounts(tmp_path, [
        {"label": "별칭1", "userId": "user01", "password": "pw1", "expected_name": "가상회원"},
        {"label": "별칭2", "userId": "user02", "password": "pw2"},
    ])
    store = AccountStore(tmp_path, use_keyring=False)
    assert [c["label"] for c in store.credentials()] == ["별칭1", "별칭2"]
    picked = store.credentials(["user02"])
    assert picked == [{"label": "별칭2", "userId": "user02", "password": "pw2"}]
    assert store.credentials(["별칭1"])[0]["expected_name"] == "가상회원"


def test_add_rejects_case_variant_of_existing_id(tmp_path):
    store = AccountStore(tmp_path, use_keyring=False)
    store.add("별칭1", "user01", "pw")
    with pytest.raises(AccountError):
        store.add("별칭2", "USER01", "pw")
    assert store.add("별칭1", "user01", "pw2") is True  # 같은 아이디 바꾸기는 그대로


# ---------------------------------------------------------------- fetch 검증

def test_fetch_accepts_valid_page():
    session = FakeSession([FakeResponse(page("ok"), url=LOAN_URL)])
    assert "ok" in asyncio.run(http_utils.fetch(LOAN_URL, session))
    assert session.requests == [(LOAN_URL, False)]


def test_fetch_never_asks_session_to_follow_redirects(no_sleep):
    session = FakeSession([
        FakeResponse("<html>no footer</html>", url=LOAN_URL),
        FakeResponse(page("ok"), url=LOAN_URL),
    ])
    asyncio.run(http_utils.fetch(LOAN_URL, session))
    assert [allow for _, allow in session.requests] == [False, False]  # 재시도에서도 같다


def test_fetch_rejects_redirect_to_other_path_without_retry(no_sleep):
    session = FakeSession([FakeResponse(page("x"), url="https://splib.or.kr/intro/index.do")] * 5)
    with pytest.raises(SessionError):
        asyncio.run(http_utils.fetch(LOAN_URL, session))
    assert session.calls == 1


def test_fetch_rejects_login_form_even_with_footer(no_sleep):
    login_html = page('<form action="/intro/program/memberLoginProc.do"><input type="password" name="password"></form>')
    session = FakeSession([FakeResponse(login_html, url=LOAN_URL)] * 5)
    with pytest.raises(SessionError):
        asyncio.run(http_utils.fetch(LOAN_URL, session))
    assert session.calls == 1


def test_fetch_rejects_session_cookie_rotation():
    session = FakeSession([FakeResponse(page("ok"), url=LOAN_URL, cookies={"JSESSIONID": "rotated"})])
    with pytest.raises(SessionError):
        asyncio.run(http_utils.fetch(LOAN_URL, session, pinned_cookies={"JSESSIONID": "orig"}))


def test_fetch_retries_truncated_page_then_succeeds(no_sleep):
    session = FakeSession([
        FakeResponse("<html>no footer</html>", url=LOAN_URL),
        FakeResponse(page("ok"), url=LOAN_URL),
    ])
    assert "ok" in asyncio.run(http_utils.fetch(LOAN_URL, session))
    assert session.calls == 2


def test_fetch_gives_up_after_retries(no_sleep):
    session = FakeSession([FakeResponse("", status=500, url=LOAN_URL)] * 2)
    with pytest.raises(FetchError):
        asyncio.run(http_utils.fetch(LOAN_URL, session, max_retries=2))


# ---------------------------------------------------------------- 페이지 수집

def run_collect(pages_by_number, parse=splib.parse_loan_rows, key=splib._loan_key, max_pages=50):
    requested = []

    async def fetch_page(n):
        requested.append(n)
        return pages_by_number(n)

    items, warnings, partial = asyncio.run(
        splib.collect_pages(fetch_page, parse, key, kind="대출", max_pages=max_pages))
    return items, warnings, partial, requested


def test_collect_follows_three_pages():
    pages = {
        1: page(loan_row("책1", rec="R1") + loan_row("책2", rec="R2"), paging_links(3)),
        2: page(loan_row("책3", rec="R3"), paging_links(3)),
        3: page(loan_row("책4", rec="R4"), paging_links(3)),
    }
    items, warnings, partial, requested = run_collect(pages.__getitem__)
    assert [i["title"] for i in items] == ["책1", "책2", "책3", "책4"]
    assert requested == [1, 2, 3]
    assert partial is False and warnings == []


def test_collect_follows_moving_page_window():
    """페이지 표시가 2쪽까지만 보이다가 2쪽에서 '다음' 링크로 3쪽이 드러나는 경우."""
    pages = {
        1: page(loan_row("책1", rec="R1"), paging_links(2)),
        2: page(loan_row("책2", rec="R2"), '<div class="paging"><a href="?currentPageNo=3">다음</a></div>'),
        3: page(loan_row("책3", rec="R3")),
    }
    items, _, partial, requested = run_collect(pages.__getitem__)
    assert requested == [1, 2, 3] and len(items) == 3 and partial is False


def test_collect_stops_on_repeated_page_and_never_duplicates_rows():
    # 서버가 범위 밖 쪽에 앞 쪽을 다시 주는 경우
    p2 = page(loan_row("책2", rec="R2"), paging_links(4))
    pages = {1: page(loan_row("책1", rec="R1"), paging_links(4)), 2: p2, 3: p2, 4: p2}
    items, warnings, partial, requested = run_collect(pages.__getitem__)
    assert [i["rec_key"] for i in items] == ["R1", "R2"]
    assert partial is True and any("반복" in w for w in warnings)
    assert requested == [1, 2, 3]


def test_collect_marks_partial_on_empty_middle_page_and_max_pages():
    pages = {1: page(loan_row("책1", rec="R1"), paging_links(3)), 2: page("", paging_links(3))}
    _, warnings, partial, _ = run_collect(pages.__getitem__)
    assert partial is True and warnings

    many = lambda n: page(loan_row(f"책{n}", rec=f"R{n}"), paging_links(9))  # noqa: E731
    items, warnings, partial, requested = run_collect(many, max_pages=3)
    assert requested == [1, 2, 3] and len(items) == 3 and partial is True


def test_collect_reports_unparseable_rows_instead_of_zero_books():
    broken = page('<div class="myArticle-list"><div class="infoBox"><div class="title">책</div></div></div>')
    items, warnings, partial, _ = run_collect(lambda n: broken)
    assert items == [] and partial is True and warnings


def test_parse_last_page_is_not_capped():
    assert splib.parse_last_page(page("", paging_links(25))) == 25
    assert splib.parse_max_page(page("", paging_links(25))) == splib.MAX_PAGES


# ---------------------------------------------------------------- 제목 병합 금지

def test_two_same_title_loans_are_both_kept():
    rows, raw = splib.parse_loan_rows(page(
        loan_row("같은제목", due="2026.10.20", rec="R1", reg="REG1")
        + loan_row("같은제목", due="2026.10.25", rec="R2", reg="REG2")))
    assert raw == 2 and len(rows) == 2
    books, _, _ = splib.merge_loans_and_interlibrary(rows, [])
    assert sorted(b["due_date"] for b in books) == ["2026.10.20", "2026.10.25"]
    # 호환 함수도 두 권을 리스트에 유지한다
    titles, *_ = splib.parse_loan_status(page(loan_row("같은제목", rec="R1") + loan_row("같은제목", rec="R2")))
    assert titles == ["같은제목", "같은제목"]


def ill_entries(html):
    entries, _, _ = splib.parse_doorae_rows(html)
    return [e for e in entries if e["status"] in splib.ACTIVE_DOORAE_STATUSES]


def test_active_pickup_with_same_title_as_loan_is_kept_with_warning():
    loans, _ = splib.parse_loan_rows(page(loan_row("같은제목", rec="R1", reg="REG1")))
    entries = ill_entries(page(ill_row("같은제목", status="입수")))
    books, booksole_count, warnings = splib.merge_loans_and_interlibrary(loans, entries)
    assert len(books) == 2
    loaned = [b for b in books if b["due_date"] == "2026.10.20"]
    pickup = [b for b in books if b["due_date"] == "입수"]
    assert loaned and loaned[0]["is_booksole"] is False  # 제목만으로 상호대차로 바꾸지 않는다
    assert pickup and pickup[0]["possible_duplicate"] is True
    assert booksole_count == 0 and warnings

    report = build_report([{"label": "별칭"}], [{"name": "n", "books": [
        {"title": b["title"], "due_date": b["due_date"], "is_interlibrary": b["is_booksole"],
         "library": b["library"], "possible_duplicate": b.get("possible_duplicate", False)}
        for b in books], "reservations": []}], now=datetime(2026, 10, 10))
    statuses = sorted(b["status"] for b in report["accounts"][0]["books"])
    assert statuses == ["loaned", "ready_for_pickup"]
    assert report["accounts"][0]["ready_for_pickup_count"] == 1


def test_join_only_with_unique_copy_id_and_provider():
    loans, _ = splib.parse_loan_rows(page(
        loan_row("책솔이책", rec="R1", reg="REG9", library="가상서쪽도서관", status="책솔이 대출중")))
    same = ill_entries(page(ill_row("책솔이책", status="입수", provider="가상서쪽도서관", reg="REG9")))
    books, _, warnings = splib.merge_loans_and_interlibrary(loans, same)
    assert len(books) == 1 and books[0]["receiving_library"] == "가상중앙"
    assert not warnings

    other_provider = ill_entries(page(ill_row("책솔이책", status="입수", provider="가상동쪽도서관", reg="REG9")))
    books, _, warnings = splib.merge_loans_and_interlibrary(loans, other_provider)
    assert len(books) == 2 and warnings

    ambiguous = ill_entries(page(
        ill_row("책솔이책", status="입수", provider="가상서쪽도서관", reg="REG9")
        + ill_row("책솔이책", status="발송", provider="가상서쪽도서관", reg="REG9")))
    books, _, _ = splib.merge_loans_and_interlibrary(loans, ambiguous)
    assert len(books) == 3  # 유일하지 않으면 묶지 않는다


# ---------------------------------------------------------------- 계정 조회 흐름

class FakeSite:
    """URL별 합성 페이지. 계정마다 다른 회원 표시를 돌려준다."""

    def __init__(self, names_by_cookie, index_changes=None):
        self.names_by_cookie = names_by_cookie
        self.index_changes = index_changes or {}
        self.index_calls = {}

    async def fetch(self, url, session, pinned_cookies=None, **_):
        cookie = ";".join(f"{k}={v}" for k, v in sorted(pinned_cookies.items()))
        if url == INDEX_URL:
            n = self.index_calls[cookie] = self.index_calls.get(cookie, 0) + 1
            names = self.index_changes.get(cookie)
            name = names[min(n, len(names)) - 1] if names else self.names_by_cookie[cookie]
            return index_page(name, loans=2)
        if url.startswith(LOAN_URL):
            return page(loan_row("책A", rec="R1") + loan_row("책A", rec="R2"))
        if url.startswith(INTERLIBRARY_LOAN_URL):
            return page(ill_row("책A", status="입수"))
        if url.startswith(RESERVATION_URL):
            return page(reservation_row("예약책", 1234))
        raise AssertionError("예상하지 못한 주소")


def patch_site(monkeypatch, site, cookies_by_user, login_calls=None):
    async def fake_login(user_id, password, timeout=10):
        if login_calls is not None:
            login_calls.append(user_id)
        return cookies_by_user[user_id]
    monkeypatch.setattr(splib, "login", fake_login)
    monkeypatch.setattr(splib, "fetch", site.fetch)


def test_get_infos_reads_accounts_and_keeps_same_title_rows(monkeypatch):
    site = FakeSite({"JSESSIONID=s1": "회원갑", "JSESSIONID=s2": "회원을"})
    patch_site(monkeypatch, site, {"u1": "JSESSIONID=s1", "u2": "JSESSIONID=s2"})
    infos = asyncio.run(splib.get_infos_async([
        {"userId": "u1", "password": "p"}, {"userId": "u2", "password": "p"}]))
    assert [i.get("error") for i in infos] == [None, None]
    assert len(infos[0]["books"]) == 3  # 같은 제목 대출 2 + 같은 제목 입수 1
    assert infos[0]["reservations"][0]["reservation_id"] == "1234"
    assert infos[0]["warnings"]


def test_duplicate_ids_fail_before_login(monkeypatch):
    calls = []
    site = FakeSite({"JSESSIONID=s3": "회원병"})
    patch_site(monkeypatch, site, {"u3": "JSESSIONID=s3"}, login_calls=calls)
    infos = asyncio.run(splib.get_infos_async([
        {"userId": "dup", "password": "p"}, {"userId": " DUP", "password": "p"}, {"userId": "u3", "password": "p"}]))
    assert infos[0]["error"] == infos[1]["error"] == splib.DUPLICATE_ACCOUNT_ERROR
    assert "error" not in infos[2]
    assert calls == ["u3"]


def test_identical_session_across_accounts_quarantines_both(monkeypatch):
    site = FakeSite({"JSESSIONID=same": "회원갑"})
    patch_site(monkeypatch, site, {"u1": "JSESSIONID=same", "u2": "JSESSIONID=same"})
    infos = asyncio.run(splib.get_infos_async([
        {"userId": "u1", "password": "p"}, {"userId": "u2", "password": "p"}]))
    assert all(i.get("error") for i in infos)
    assert infos[0]["books"] == [] and infos[1]["books"] == []


def test_identity_change_during_read_is_an_error(monkeypatch):
    site = FakeSite({}, index_changes={"JSESSIONID=s1": ["회원갑", "회원을"]})
    patch_site(monkeypatch, site, {"u1": "JSESSIONID=s1"})
    infos = asyncio.run(splib.get_infos_async([{"userId": "u1", "password": "p"}]))
    assert infos[0].get("error")


def test_configured_identity_mismatch_is_an_error(monkeypatch):
    site = FakeSite({"JSESSIONID=s1": "회원갑"})
    patch_site(monkeypatch, site, {"u1": "JSESSIONID=s1"})
    infos = asyncio.run(splib.get_infos_async([{"userId": "u1", "password": "p", "expected_name": "다른회원"}]))
    assert infos[0].get("error")
    ok = asyncio.run(splib.get_infos_async([{"userId": "u1", "password": "p", "expected_name": "회원 갑"}]))
    assert not ok[0].get("error")


def test_failed_fetch_error_does_not_log_user_id(monkeypatch, caplog):
    async def failing_login(user_id, password, timeout=10):
        raise http_utils.AuthError("로그인 실패")
    monkeypatch.setattr(splib, "login", failing_login)
    infos = asyncio.run(splib.get_infos_async([{"userId": "secret-id-123", "password": "p"}]))
    assert infos[0]["error"]
    assert "secret-id-123" not in caplog.text


# ---------------------------------------------------------------- 보고서

def test_report_keeps_reservation_id_and_marks_unknown_counts():
    assert normalize_reservation({"reservation_id": "77", "title": "t"})["reservation_id"] == "77"
    assert normalize_reservation({"title": "t"})["reservation_id"] is None
    infos = [
        {"name": "n", "books": [], "reservations": [], "warnings": ["대출: 3쪽에서 멈췄습니다"], "partial": True},
        {"name": "x", "books": [], "reservations": [], "error": "조회 시간이 초과되었습니다"},
        {"name": "y", "books": [], "reservations": []},
    ]
    report = build_report([{"label": "a"}, {"label": "b"}, {"label": "c"}], infos, now=datetime(2026, 10, 10))
    a, b, c = report["accounts"]
    assert a["partial"] is True and a["warnings"]
    assert b["partial"] is True
    assert "partial" not in c
    assert report["complete"] is False
    notice = incomplete_notice(report)
    assert "확정치가 아닙니다" in notice
    text = render_text(report, columns=120)
    assert notice in text and "권수 모름" in text and "3쪽에서 멈췄습니다" in text


def test_complete_report_has_no_notice():
    report = build_report([{"label": "a"}], [{"name": "n", "books": [], "reservations": []}],
                          now=datetime(2026, 10, 10))
    assert report["complete"] is True and incomplete_notice(report) is None
