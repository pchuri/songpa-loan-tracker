from datetime import datetime


PICKUP_LABEL = "입수"
STATUS_WAITING_LABELS = {"입수", "발송", "요청중", "신청중", "복귀중"}


def compute_book_status(book: dict) -> tuple[str, str]:
    """반납일 → (tier, 배지 라벨). tier ∈ {urgent, approaching, normal, pickup, transit}.

    입수(수령관 도착, 찾아갈 책)와 발송 등(이동 중, 아직 못 찾음)은 둘 다 반납일 대신
    상태 낱말이 오지만 할 일이 정반대라 tier를 나눈다.
    """
    due_raw = book.get("due_date", "")
    if due_raw == PICKUP_LABEL:
        return "pickup", "찾아가기"
    if due_raw in STATUS_WAITING_LABELS:
        return "transit", f"이동 중 · {due_raw}"
    try:
        due_dt = datetime.strptime(due_raw, "%Y.%m.%d")
        days = (due_dt.date() - datetime.now().date()).days
        if days < 0:
            return "urgent", "연체"
        if days == 0:
            return "urgent", "D-Day"
        if days <= 1:
            return "urgent", f"D-{days}"
        if days <= 3:
            return "approaching", f"D-{days}"
        return "normal", f"D-{days}"
    except Exception:
        return "normal", due_raw or "-"
