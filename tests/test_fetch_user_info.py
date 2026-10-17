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


def _reservation_row(title, reservation_id):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info"><span><strong>거마도서관</strong></span><span>자료실</span></div>
        <div class="info"><span>예약일 : 2026.08.23</span><span>예약순번 : 1번째 (1명 예약)</span></div>
        <div class="info"><span>도서현황 : 대출중</span><span>반납예정일 :</span></div>
      </div>
      <div class="statusBox"><a class="status cncl" href="#btn"
         onclick="javascript:fnLoanReservationCancelProc({reservation_id}); return false;">예약취소</a></div>
    </div>"""


def _run_with_pages(monkeypatch, pages, requested=None):
    async def fake_login(user_id, password, timeout=10):
        return "SESSION=stub"

    async def fake_fetch(url, session, max_retries=5, timeout=10):
        if requested is not None:
            requested.append(url)
        return pages[url]

    monkeypatch.setattr(splib, "login", fake_login)
    monkeypatch.setattr(splib, "fetch", fake_fetch)
    return asyncio.run(splib._fetch_user_info("user", "pw"))


def test_reservation_pages_beyond_the_first_are_fetched_and_no_further(monkeypatch):
    """페이지 목록이 알린 만큼만 가져온다. 쪽마다 서로 다른 예약 ID."""
    pages = dict(PAGES)
    pages[RESERVATION_URL] = _reservation_row("1페이지 책", 101) + PAGING_THREE
    pages[f"{RESERVATION_URL}?currentPageNo=2"] = _reservation_row("2페이지 책", 102) + PAGING_THREE
    pages[f"{RESERVATION_URL}?currentPageNo=3"] = _reservation_row("3페이지 책", 103) + PAGING_THREE
    requested = []

    info = _run_with_pages(monkeypatch, pages, requested)

    assert [r["title"] for r in info["reservations"]] == ["1페이지 책", "2페이지 책", "3페이지 책"]
    assert [r["reservation_id"] for r in info["reservations"]] == ["101", "102", "103"]
    assert f"{RESERVATION_URL}?currentPageNo=2" in requested
    assert f"{RESERVATION_URL}?currentPageNo=3" in requested
    assert f"{RESERVATION_URL}?currentPageNo=4" not in requested
    assert "partial" not in info


def test_next_page_repeating_a_reservation_id_with_a_different_title_is_incomplete(monkeypatch):
    """2쪽이 1쪽과 같은 예약 ID를 다른 제목으로 내놓으면 모순이다. 합치지 않고 불완전으로 알린다."""
    pages = dict(PAGES)
    pages[RESERVATION_URL] = _reservation_row("1페이지 책", 9) + PAGING_THREE
    pages[f"{RESERVATION_URL}?currentPageNo=2"] = _reservation_row("2페이지 책", 9) + PAGING_THREE
    pages[f"{RESERVATION_URL}?currentPageNo=3"] = _reservation_row("3페이지 책", 10) + PAGING_THREE
    requested = []

    info = _run_with_pages(monkeypatch, pages, requested)

    assert [r["title"] for r in info["reservations"]] == ["1페이지 책"]
    assert info["partial"] is True
    assert any("예약" in w and "반복" in w for w in info["warnings"])
    assert f"{RESERVATION_URL}?currentPageNo=3" not in requested


def test_same_reservation_id_with_different_content_on_one_page_is_incomplete(monkeypatch):
    pages = dict(PAGES)
    pages[RESERVATION_URL] = _reservation_row("가 책", 9) + _reservation_row("나 책", 9) + EMPTY

    info = _run_with_pages(monkeypatch, pages)

    assert [r["title"] for r in info["reservations"]] == ["가 책"]
    assert info["partial"] is True
    assert any("서로 다른 내용" in w for w in info["warnings"])


def test_exactly_repeated_reservation_row_is_counted_once_without_partial(monkeypatch):
    pages = dict(PAGES)
    pages[RESERVATION_URL] = _reservation_row("가 책", 9) + _reservation_row("가 책", 9) + EMPTY

    info = _run_with_pages(monkeypatch, pages)

    assert [r["title"] for r in info["reservations"]] == ["가 책"]
    assert "partial" not in info
    assert any("한 번만" in w for w in info["warnings"])


DOORAE_SAME_TITLE_AS_LOAN = _row(
    "빌린 책",
    '<div class="info"><span>수령도서관 : 돌마리도서관</span></div>'
    '<div class="info"><span>제공도서관 : 송파위례도서관</span></div>',
    "입수",
)


def test_a_loan_and_an_in_transit_row_sharing_only_a_title_stay_two_cards_with_a_warning(monkeypatch):
    """제목만 같으면 같은 권이라는 근거가 없다. 두 카드를 모두 남기고 경고한다."""
    pages = dict(PAGES)
    pages[INTERLIBRARY_LOAN_URL] = DOORAE_SAME_TITLE_AS_LOAN

    info = _run_with_pages(monkeypatch, pages)

    assert [b["title"] for b in info["books"]] == ["빌린 책", "빌린 책"]
    loan, transit = info["books"]
    assert loan["is_interlibrary"] is False
    assert loan["library"] == "거마"
    assert loan["due_date"] == "2026.09.01"
    assert "possible_duplicate" not in loan
    assert transit["is_interlibrary"] is True
    assert transit["library"] == "돌마리"
    assert transit["providing_library"] == "위례"
    assert transit["due_date"] == "입수"
    assert transit["possible_duplicate"] is True
    assert any("제목이 같은 진행 중 상호대차" in w for w in info["warnings"])


def _loan_row_with_copy(title, library, reg_no):
    return _row(
        title,
        f'<input type="checkbox" name="check" value="REC1^{reg_no}^MA^x^y">'
        f'<div class="info"><span><strong>{library}</strong></span></div>'
        '<div class="info"><span>대출일 : 2026.08.01</span><span>반납예정일 : 2026.09.01</span></div>',
        "연장",
    )


def _doorae_row_with_copy(title, provider, reg_no):
    return _row(
        title,
        f'<input type="checkbox" name="check" value="REC2^{reg_no}^MA^x^y">'
        '<div class="info"><span>수령도서관 : 돌마리도서관</span></div>'
        f'<div class="info"><span>제공도서관 : {provider}</span></div>',
        "입수",
    )


def test_loan_and_in_transit_with_same_provider_and_copy_id_join_into_one_card(monkeypatch):
    """제공 도서관과 등록번호가 양쪽에서 같으면 같은 권이다. 카드 하나에 상호대차 정보를 얹는다."""
    pages = dict(PAGES)
    pages[LOAN_URL] = _loan_row_with_copy("빌린 책", "송파위례도서관", "REG100")
    pages[INTERLIBRARY_LOAN_URL] = _doorae_row_with_copy("빌린 책", "송파위례도서관", "REG100")

    info = _run_with_pages(monkeypatch, pages)

    assert [b["title"] for b in info["books"]] == ["빌린 책"]
    book = info["books"][0]
    assert book["is_interlibrary"] is True
    assert book["library"] == "돌마리"
    assert book["providing_library"] == "위례"
    assert book["due_date"] == "2026.09.01"
    assert "possible_duplicate" not in book


def test_same_copy_id_from_a_different_provider_is_not_joined(monkeypatch):
    pages = dict(PAGES)
    pages[LOAN_URL] = _loan_row_with_copy("빌린 책", "송파위례도서관", "REG100")
    pages[INTERLIBRARY_LOAN_URL] = _doorae_row_with_copy("빌린 책", "송파글마루도서관", "REG100")

    info = _run_with_pages(monkeypatch, pages)

    assert len(info["books"]) == 2
    assert info["books"][1]["possible_duplicate"] is True
    assert info["books"][1]["providing_library"] == "글마루"
    assert any("제목이 같은 진행 중 상호대차" in w for w in info["warnings"])
