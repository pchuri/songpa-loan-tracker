import asyncio

import pytest

from songpa_core import splib
from songpa_core.config import INDEX_URL, INTERLIBRARY_LOAN_URL, LOAN_URL, RESERVATION_URL

INDEX_HTML = f"""
<div class="barcodeInfo">테스터<span>12345</span></div>
<a href="{splib.LOAN_PATH}"><span>1</span></a>
<a href="{splib.INTERLIBRARY_PATH}"><span>2</span></a>
"""


def _row(title, info_html, status):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        {info_html}
      </div>
      <div class="statusBox">{status}</div>
    </div>"""


LOAN_HTML = _row(
    "빌린 책",
    '<div class="info"><span><strong>거마도서관</strong></span></div>'
    '<div class="info"><span>대출일 : 2026.08.01</span><span>반납예정일 : 2026.09.01</span></div>',
    "연장",
)

# 같은 제목을 두 도서관에서 이송 중
DOORAE_HTML = _row(
    "오는 책",
    '<div class="info"><span>수령도서관 : 거마도서관</span></div>'
    '<div class="info"><span>제공도서관 : 송파위례도서관</span></div>',
    "입수",
) + _row(
    "오는 책",
    '<div class="info"><span>수령도서관 : 돌마리도서관</span></div>'
    '<div class="info"><span>제공도서관 : 송파글마루도서관</span></div>',
    "발송",
)

EMPTY = '<div class="myArticleWrap"></div><p class="paging"><span class="current">1</span></p>'

PAGES = {
    INDEX_URL: INDEX_HTML,
    LOAN_URL: LOAN_HTML,
    f"{LOAN_URL}?currentPageNo=2": EMPTY,
    INTERLIBRARY_LOAN_URL: DOORAE_HTML,
    f"{INTERLIBRARY_LOAN_URL}?currentPageNo=2": EMPTY,
    RESERVATION_URL: EMPTY,
}


@pytest.fixture
def stub_site(monkeypatch):
    async def fake_login(user_id, password, timeout=10):
        return "SESSION=stub"

    async def fake_fetch(url, session, max_retries=5, timeout=10):
        return PAGES[url]

    monkeypatch.setattr(splib, "login", fake_login)
    monkeypatch.setattr(splib, "fetch", fake_fetch)


def test_same_title_in_transit_from_two_libraries_yields_two_cards(stub_site):
    """상호대차 두 건이 같은 제목이어도 카드 두 장이 나와야 한다."""
    info = asyncio.run(splib._fetch_user_info("user", "pw"))

    in_transit = [b for b in info["books"] if b["due_date"] in ("입수", "발송")]
    assert len(in_transit) == 2
    assert {b["due_date"] for b in in_transit} == {"입수", "발송"}
    assert {b["library"] for b in in_transit} == {"거마", "돌마리"}
    assert all(b["is_interlibrary"] for b in in_transit)


def test_loaned_book_is_kept_alongside_in_transit_ones(stub_site):
    info = asyncio.run(splib._fetch_user_info("user", "pw"))

    assert info["name"] == "테스터"
    titles = [b["title"] for b in info["books"]]
    assert titles.count("빌린 책") == 1
    assert titles.count("오는 책") == 2
    assert info["reservations"] == []


PAGING_THREE = (
    '<p class="paging"><span class="current">1</span>'
    '<a href="#">2</a><a href="#">3</a><a href="#">다음</a></p>'
)


def _reservation_row(title):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info"><span><strong>거마도서관</strong></span><span>자료실</span></div>
        <div class="info"><span>예약일 : 2026.08.23</span><span>예약순번 : 1번째 (1명 예약)</span></div>
        <div class="info"><span>도서현황 : 대출중</span><span>반납예정일 :</span></div>
      </div>
      <div class="statusBox"><a class="status cncl" href="#btn"
         onclick="javascript:fnLoanReservationCancelProc(9); return false;">예약취소</a></div>
    </div>"""


def test_reservation_pages_beyond_the_first_are_fetched_and_no_further(monkeypatch):
    """페이지 목록이 알린 만큼만 가져온다."""
    pages = dict(PAGES)
    pages[RESERVATION_URL] = _reservation_row("1페이지 책") + PAGING_THREE
    pages[f"{RESERVATION_URL}?currentPageNo=2"] = _reservation_row("2페이지 책") + PAGING_THREE
    pages[f"{RESERVATION_URL}?currentPageNo=3"] = _reservation_row("3페이지 책") + PAGING_THREE
    requested = []

    async def fake_login(user_id, password, timeout=10):
        return "SESSION=stub"

    async def fake_fetch(url, session, max_retries=5, timeout=10):
        requested.append(url)
        return pages[url]

    monkeypatch.setattr(splib, "login", fake_login)
    monkeypatch.setattr(splib, "fetch", fake_fetch)

    info = asyncio.run(splib._fetch_user_info("user", "pw"))

    assert [r["title"] for r in info["reservations"]] == ["1페이지 책", "2페이지 책", "3페이지 책"]
    assert f"{RESERVATION_URL}?currentPageNo=4" not in requested


DOORAE_SAME_TITLE_AS_LOAN = _row(
    "빌린 책",
    '<div class="info"><span>수령도서관 : 돌마리도서관</span></div>'
    '<div class="info"><span>제공도서관 : 송파위례도서관</span></div>',
    "입수",
)


def test_a_loan_that_is_also_in_transit_is_one_card_carrying_the_interlibrary_detail(monkeypatch):
    """제목이 겹치면 카드를 하나로 두되, 상호대차 정보를 얹는다."""
    pages = dict(PAGES)
    pages[INTERLIBRARY_LOAN_URL] = DOORAE_SAME_TITLE_AS_LOAN

    async def fake_login(user_id, password, timeout=10):
        return "SESSION=stub"

    async def fake_fetch(url, session, max_retries=5, timeout=10):
        return pages[url]

    monkeypatch.setattr(splib, "login", fake_login)
    monkeypatch.setattr(splib, "fetch", fake_fetch)

    info = asyncio.run(splib._fetch_user_info("user", "pw"))

    assert [b["title"] for b in info["books"]] == ["빌린 책"]
    book = info["books"][0]
    assert book["is_interlibrary"] is True
    assert book["library"] == "돌마리"
    assert book["providing_library"] == "위례"
    assert book["due_date"] == "2026.09.01"
