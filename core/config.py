from enum import Enum


LOGIN_URL = "https://splib.or.kr/intro/program/memberLoginProc.do"
INDEX_URL = "https://splib.or.kr/intro/index.do"
LOAN_URL = "https://splib.or.kr/intro/program/mypage/loanStatusList.do"
INTERLIBRARY_LOAN_URL = "https://splib.or.kr/intro/program/mypage/dooraeLillStatusList.do"
RESERVATION_URL = "https://splib.or.kr/intro/program/mypage/reservationStatusList.do"
CT = "application/x-www-form-urlencoded"


class DOORAE_STATUS(Enum):
    SENDING = "발송"
    OBTAINED = "입수"
    RETURNING = "복귀중"
    REQUESTED_RAW = "요청중신청취소"
    REQUESTED = "요청중"
