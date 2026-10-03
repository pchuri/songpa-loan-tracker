from urllib.parse import urlparse

from bs4 import BeautifulSoup

from core.config import LOAN_URL, INTERLIBRARY_LOAN_URL
from core.http_utils import AuthError


# 지역에서 통하는 이름이 정식 명칭과 다른 분관들.
LIBRARY_ALIASES = {
    "송파어린이영어도서관": "영어도서관",
    "송파스마트도서관(잠실나루역)": "스마트도서관",
    "송파어린이도서관": "엘스도서관",
}


def abbreviate_library_name(library_name):
    """도서관 이름을 카드에 들어갈 짧은 형태로 줄인다.

    대출·상호대차·예약이 각자 다르게 줄이면 같은 분관이 화면마다 다른 이름으로
    보이므로(송파어린이도서관 -> 어린이 / 엘스도서관 / 엘스) 이 함수 하나만 쓴다.
    """
    if not library_name:
        return library_name
    aliased = LIBRARY_ALIASES.get(library_name, library_name)
    shortened = aliased.replace('송파', '').replace('도서관', '').strip()
    # '송파도서관'처럼 접미사만으로 이루어진 이름은 통째로 사라지므로 원본을 남긴다.
    return shortened or aliased


def parse_index_content(content):
    LOAN_PATH = urlparse(LOAN_URL).path
    INTERLIBRARY_PATH = urlparse(INTERLIBRARY_LOAN_URL).path

    soup = BeautifulSoup(content, 'html.parser')
    barcode_info_div = soup.find('div', {'class': 'barcodeInfo'})
    if not barcode_info_div or not barcode_info_div.contents:
        raise AuthError("로그인 세션이 유효하지 않습니다 (페이지에 사용자 정보 없음).")
    name = barcode_info_div.contents[0].strip()

    loan_status_link = soup.find('a', href=LOAN_PATH)
    interlibrary_status_link = soup.find('a', href=INTERLIBRARY_PATH)
    if not loan_status_link or not interlibrary_status_link:
        raise AuthError("로그인 세션이 유효하지 않습니다 (페이지에 대출 메뉴 없음).")

    loan_status_span = loan_status_link.find('span')
    interlibrary_status_span = interlibrary_status_link.find('span')
    num_loans = int(loan_status_span.text.strip()) if loan_status_span else 0
    num_interlibrary_loans = int(interlibrary_status_span.text.strip()) if interlibrary_status_span else 0

    return name, num_loans, num_interlibrary_loans
