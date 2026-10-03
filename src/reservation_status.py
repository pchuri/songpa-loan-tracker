import re
from datetime import datetime


_WHITESPACE = re.compile(r"\s+")


def group_key(title: str) -> str:
    """정렬용 제목 정규화 키. 띄어쓰기 차이만 흡수한다.

    실제 페이지는 같은 책을 도서관마다 "검은 눈물 석유" / "검은눈물 석유"처럼
    띄어쓰기만 달리 적는 경우가 있어 그것만 지운다.

    괄호와 ':' 부제는 일부러 남긴다. 한국 도서관 목록은 시리즈 권을 바로 그것으로
    구분해서(토지 (1) / 토지 (2), 해리 포터 : 마법사의 돌 / 비밀의 방) 지워버리면
    서로 다른 책이 한 그룹이 되고, 카드의 "같은 책 N곳"이 틀린 숫자를 말한다.
    부제 위치까지 다른 판본은 이제 묶이지 않지만, 안 묶이는 쪽이 틀리게 묶는 쪽보다
    낫다 — 이 키는 정렬과 그 숫자에만 쓰이고 예약 건을 합치지는 않는다.
    """
    return _WHITESPACE.sub("", title or "")


def is_ready_for_pickup(reservation: dict) -> bool:
    """수령 대기 여부. 도서현황은 항상 '대출중'이라 예약만기일 유무로만 판별된다."""
    return bool(reservation.get("expiry_date"))


def compute_reservation_status(reservation: dict) -> tuple[str, str]:
    """예약 건 → (tier, 배지 라벨). tier ∈ {urgent, approaching, normal}."""
    expiry = reservation.get("expiry_date")
    if expiry:
        try:
            days = (datetime.strptime(expiry, "%Y.%m.%d").date() - datetime.now().date()).days
        except ValueError:
            return "urgent", "수령 대기"
        if days < 0:
            return "urgent", "만기 경과"
        if days == 0:
            return "urgent", "수령 D-Day"
        if days <= 1:
            return "urgent", f"수령 D-{days}"
        return "approaching", f"수령 D-{days}"

    rank = reservation.get("rank") or 0
    if rank == 1:
        return "approaching", "1순위"
    if rank:
        return "normal", f"{rank}순위"
    return "normal", "예약중"
