from datetime import datetime, timedelta

import pytest

from songpa_core.splib import MAX_PAGES, parse_max_page, parse_reservation_status
from src.reservation_status import compute_reservation_status, group_key, is_ready_for_pickup


def _row(reservation_id, title, library, room, reserved_date, rank, waiting,
         due_date="", expiry_date=""):
    expiry_markup = (
        f'<span>예약만기일<br/><em>{expiry_date}</em></span>' if expiry_date else ""
    )
    return f"""
    <div class="myArticle-list">
      <div class="numBox">1</div>
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info">
          <span><strong>{library}</strong></span>
          <span>{room}</span>
        </div>
        <div class="info">
          <span>예약일 : {reserved_date}</span>
          <span>예약순번 : {rank}번째
                    ({waiting}명 예약)</span>
        </div>
        <div class="info">
          <span>도서현황  :
                    대출중</span>
          <span>반납예정일 :{due_date}</span>
        </div>
      </div>
      <div class="statusBox">
        {expiry_markup}
        <a class="status cncl" href="#btn"
           onclick="javascript:fnLoanReservationCancelProc({reservation_id}); return false;">예약취소</a>
      </div>
    </div>
    """


def _page(rows, paging='<p class="paging"><span class="current">1</span></p>'):
    return f'<div class="myArticleWrap">{"".join(rows)}</div>{paging}<!-- footer -->'


SAME_BOOK_AT_FOUR_LIBRARIES = _page([
    _row("100001", "물결의 이름", "거마도서관", "거마 4층 종합자료실", "2026.08.23", 3, 5,
         due_date="2026.09.05"),
    _row("100002", "물결의 이름", "돌마리도서관", "돌마리_해맑음", "2026.08.23", 4, 5,
         due_date="2026.09.06"),
    _row("100003", "물결의  이름", "송파위례도서관", "송파위례_4층_아동자료실", "2026.08.23", 1, 3,
         expiry_date="2026.08.29"),
    _row("100004", "(아주 긴 부제가 달린)물결의 이름 : 부제", "송파어린이도서관",
         "송파어린이 어린이책나라 2층", "2026.08.23", 5, 5),
])


def test_same_title_at_different_libraries_stays_separate():
    """같은 책을 여러 도서관에 걸어둔 예약은 서버상 별개 건이므로 합쳐지면 안 된다."""
    reservations = parse_reservation_status(SAME_BOOK_AT_FOUR_LIBRARIES)

    assert len(reservations) == 4
    assert len({r["reservation_id"] for r in reservations}) == 4
    assert [r["library"] for r in reservations] == ["거마", "돌마리", "위례", "엘스"]


def test_fields_are_parsed():
    first = parse_reservation_status(SAME_BOOK_AT_FOUR_LIBRARIES)[0]

    assert first == {
        "reservation_id": "100001",
        "title": "물결의 이름",
        "library": "거마",
        "room": "거마 4층 종합자료실",
        "reserved_date": "2026.08.23",
        "rank": 3,
        "waiting_count": 5,
        "book_status": "대출중",
        "due_date": "2026.09.05",
        "expiry_date": "",
    }


def test_expiry_date_marks_only_the_pickup_row():
    """도서현황은 전 건이 '대출중'이라, 수령 대기는 예약만기일 유무로만 구분된다."""
    reservations = parse_reservation_status(SAME_BOOK_AT_FOUR_LIBRARIES)

    assert {r["book_status"] for r in reservations} == {"대출중"}
    ready = [r for r in reservations if is_ready_for_pickup(r)]
    assert [r["reservation_id"] for r in ready] == ["100003"]
    assert ready[0]["expiry_date"] == "2026.08.29"


def test_missing_due_date_is_empty_not_garbage():
    last = parse_reservation_status(SAME_BOOK_AT_FOUR_LIBRARIES)[3]
    assert last["due_date"] == ""


def test_empty_page_yields_no_reservations():
    assert parse_reservation_status(_page([])) == []


def test_max_page_defaults_to_one():
    assert parse_max_page(SAME_BOOK_AT_FOUR_LIBRARIES) == 1
    assert parse_max_page("<html><body>no paging</body></html>") == 1


def test_max_page_reads_the_highest_page_link():
    paging = (
        '<p class="paging"><span class="current">1</span>'
        '<a href="#">2</a><a href="#">3</a><a href="#">다음</a></p>'
    )
    assert parse_max_page(_page([], paging=paging)) == 3


def test_group_key_folds_whitespace_only():
    """같은 책을 도서관마다 띄어쓰기만 달리 적는 경우가 있어 그것만 흡수한다."""
    assert group_key("검은 눈물 석유") == group_key("검은눈물 석유")
    assert group_key("타마르의 숲") == group_key("타마르의숲")


@pytest.mark.parametrize("first, second", [
    ("토지 (1)", "토지 (2)"),
    ("해리 포터 : 마법사의 돌", "해리 포터 : 비밀의 방"),
    ("코스모스 : 상", "코스모스 : 하"),
    ("셜록 홈즈 전집 : 주홍색 연구", "셜록 홈즈 전집 : 네 사람의 서명"),
])
def test_group_key_keeps_series_volumes_apart(first, second):
    """한국 도서관 목록은 시리즈 권을 괄호와 ':' 부제로 구분한다.

    그걸 지우면 서로 다른 책이 한 그룹이 되고, 카드가 "같은 책 N곳"으로
    틀린 숫자를 말한다. 묶이지 않는 편이 틀리게 묶는 편보다 낫다.
    """
    assert group_key(first) != group_key(second)


def test_group_key_does_not_overfold_a_title_that_merely_shares_a_prefix():
    assert group_key("물결의 이름") != group_key("물결의 이름과 다른 이야기")


def _in_days(days):
    return (datetime.now().date() + timedelta(days=days)).strftime("%Y.%m.%d")


def test_pickup_deadline_drives_the_tier():
    assert compute_reservation_status({"expiry_date": _in_days(-1)}) == ("urgent", "만기 경과")
    assert compute_reservation_status({"expiry_date": _in_days(0)}) == ("urgent", "수령 D-Day")
    assert compute_reservation_status({"expiry_date": _in_days(1)}) == ("urgent", "수령 D-1")
    assert compute_reservation_status({"expiry_date": _in_days(3)}) == ("approaching", "수령 D-3")


def test_rank_drives_the_tier_when_not_ready_for_pickup():
    assert compute_reservation_status({"rank": 1, "waiting_count": 3}) == ("approaching", "1순위")
    assert compute_reservation_status({"rank": 4, "waiting_count": 5}) == ("normal", "4순위")
    assert compute_reservation_status({}) == ("normal", "예약중")


def test_unparseable_expiry_date_still_counts_as_pickup_waiting():
    assert compute_reservation_status({"expiry_date": "곧"}) == ("urgent", "수령 대기")


def test_max_page_is_capped_so_a_bad_page_list_cannot_flood_requests():
    paging = '<p class="paging"><span class="current">1</span><a href="#">2026</a></p>'
    assert parse_max_page(_page([], paging=paging)) == MAX_PAGES


def _row_with_status(status_markup):
    return _page([f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">어떤 책</div>
        <div class="info"><span><strong>거마도서관</strong></span><span>자료실</span></div>
        <div class="info"><span>예약일 : 2026.08.23</span><span>예약순번 : 1번째 (3명 예약)</span></div>
        <div class="info"><span>도서현황 : 대출중</span><span>반납예정일 :</span></div>
      </div>
      <div class="statusBox">{status_markup}<a class="status cncl" href="#btn"
         onclick="javascript:fnLoanReservationCancelProc(1); return false;">예약취소</a></div>
    </div>"""])


def test_a_date_that_is_not_the_pickup_deadline_is_not_read_as_one():
    """도서현황은 전 건이 '대출중'이라, statusBox의 다른 날짜를 만기일로 오인하면 안 된다."""
    reservation = parse_reservation_status(
        _row_with_status("<span>신청일<br/><em>2026.08.23</em></span>")
    )[0]

    assert reservation["expiry_date"] == ""
    assert not is_ready_for_pickup(reservation)


def test_the_pickup_deadline_is_read_from_its_own_label_not_the_first_date():
    """예약만기일보다 앞에 다른 날짜가 있어도 만기일을 집어야 한다."""
    reservation = parse_reservation_status(_row_with_status(
        "<span>예약일<br/><em>2026.08.23</em></span>"
        "<span>예약만기일<br/><em>2026.08.29</em></span>"
    ))[0]

    assert reservation["expiry_date"] == "2026.08.29"


@pytest.mark.parametrize("printed, normalized", [
    ("2026.08.29", "2026.08.29"),
    ("2026.8.29", "2026.08.29"),
    ("2026.8.9", "2026.08.09"),
])
def test_dates_are_normalized_so_string_sorting_stays_correct(printed, normalized):
    """zero-pad 없이 찍혀도 받아들이고, 반환은 항상 zero-pad로 맞춘다.

    만기일과 예약일을 문자열로 정렬하는 곳이 있어서 표기가 섞이면
    2026.8.29가 2026.08.30보다 뒤로 간다.
    """
    reservation = parse_reservation_status(
        _row_with_status(f"<span>예약만기일<br/><em>{printed}</em></span>")
    )[0]

    assert reservation["expiry_date"] == normalized
    assert is_ready_for_pickup(reservation)


def test_the_deadline_is_found_when_label_and_date_are_in_separate_spans():
    reservation = parse_reservation_status(_row_with_status(
        "<span>예약만기일</span><span>2026.08.29</span>"
    ))[0]

    assert reservation["expiry_date"] == "2026.08.29"
