from datetime import datetime


STATUS_WAITING_LABELS = {"입수", "발송", "요청중", "복귀중"}


def compute_book_status(book: dict) -> tuple[str, str]:
    """반납일 → (tier, 배지 라벨). tier ∈ {urgent, approaching, normal, waiting}."""
    due_raw = book.get("due_date", "")
    if due_raw in STATUS_WAITING_LABELS:
        return "waiting", due_raw
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
