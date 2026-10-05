import pytest

from songpa_core.splib import parse_doorae_status, parse_loan_status, parse_reservation_status
from songpa_core.splib_utils import abbreviate_library_name


@pytest.mark.parametrize("full_name, expected", [
    ("거마도서관", "거마"),
    ("돌마리도서관", "돌마리"),
    ("송파위례도서관", "위례"),
    ("송파글마루도서관", "글마루"),
    ("송파어린이도서관", "엘스"),
    ("송파어린이영어도서관", "영어"),
    ("송파스마트도서관(잠실나루역)", "스마트"),
    ("잠실본동", "잠실본동"),
])
def test_abbreviations(full_name, expected):
    assert abbreviate_library_name(full_name) == expected


def test_a_name_made_only_of_stripped_parts_keeps_something_readable():
    """'송파'와 '도서관'만으로 된 이름은 통째로 사라져 카드에 '-'가 찍힌다."""
    assert abbreviate_library_name("송파도서관") == "송파도서관"


@pytest.mark.parametrize("value", ["", None])
def test_missing_name_passes_through(value):
    assert abbreviate_library_name(value) == value


LIBRARY = "송파어린이도서관"


def _loan_page():
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">어떤 책</div>
        <div class="info"><span><strong>{LIBRARY}</strong></span></div>
        <div class="info"><span>대출일 : 2026.08.01</span><span>반납예정일 : 2026.09.01</span></div>
      </div>
      <div class="statusBox">연장</div>
    </div>"""


def _doorae_page():
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">오는 책</div>
        <div class="info"><span>수령도서관 : {LIBRARY}</span></div>
        <div class="info"><span>제공도서관 : {LIBRARY}</span></div>
      </div>
      <div class="statusBox">입수</div>
    </div>"""


def _reservation_page():
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">예약한 책</div>
        <div class="info"><span><strong>{LIBRARY}</strong></span><span>자료실</span></div>
        <div class="info"><span>예약일 : 2026.08.01</span><span>예약순번 : 1번째 (1명 예약)</span></div>
        <div class="info"><span>도서현황 : 대출중</span><span>반납예정일 :</span></div>
      </div>
      <div class="statusBox">
        <a class="status cncl" href="#btn"
           onclick="javascript:fnLoanReservationCancelProc(1); return false;">예약취소</a>
      </div>
    </div>"""


def test_every_page_renders_the_same_library_the_same_way():
    """같은 분관이 대출·상호대차·예약에서 모두 같은 이름으로 나와야 한다."""
    _, loan_libraries, _, _, _, _ = parse_loan_status(_loan_page())
    doorae_entries, _ = parse_doorae_status(_doorae_page())
    reservations = parse_reservation_status(_reservation_page())

    seen = {
        loan_libraries[0],
        doorae_entries[0]["receiving_library"],
        doorae_entries[0]["providing_library"],
        reservations[0]["library"],
    }

    assert seen == {"엘스"}
