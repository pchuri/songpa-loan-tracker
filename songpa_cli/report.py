"""songpa_core 조회 결과를 사람·AI가 읽기 좋은 형태로 바꾼다.

songpa_core는 대출 중이 아닌 상호대차 건의 상태(입수·발송 등)를 due_date 칸에 넣어 준다.
여기서 그것을 status/due_date/days_left로 풀어 둔다.
"""

from __future__ import annotations

import re
from datetime import date, datetime

from songpa_core.splib import ACTIVE_DOORAE_STATUSES

LOANED = "loaned"
READY_FOR_PICKUP = "ready_for_pickup"
IN_TRANSIT = "in_transit"
PICKUP_STATUS = "입수"

_ORDER = {READY_FOR_PICKUP: 0, LOANED: 1, IN_TRANSIT: 2}


DATE_PATTERN = re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})")


def parse_date(text: str | None) -> date | None:
    """글 안의 첫 날짜(YYYY.M.D). '2026.10.10(연장)'처럼 뒤에 뭐가 붙어도 읽는다."""
    match = DATE_PATTERN.search(text or "")
    if not match:
        return None
    try:
        return date(*(int(part) for part in match.groups()))
    except ValueError:
        return None


def normalize_book(book: dict, today: date) -> dict:
    raw = book.get("due_date") or ""
    due = parse_date(raw)
    if due is not None:
        status, transit_status, days_left, due_text = LOANED, None, (due - today).days, due.strftime("%Y.%m.%d")
    elif raw == PICKUP_STATUS:
        status, transit_status, days_left, due_text = READY_FOR_PICKUP, raw, None, None
    elif book.get("is_interlibrary") and raw in ACTIVE_DOORAE_STATUSES:
        status, transit_status, days_left, due_text = IN_TRANSIT, raw, None, None
    else:
        # 반납일을 못 읽은 대출. 이동 중인 상호대차로 오해하지 않게 대출로 두고 원문을 남긴다.
        status, transit_status, days_left, due_text = LOANED, None, None, raw or None
    return {
        "title": book.get("title") or "",
        "status": status,
        "due_date": due_text,
        "days_left": days_left,
        "transit_status": transit_status,
        "is_interlibrary": bool(book.get("is_interlibrary")),
        "library": book.get("library") or "",
        "providing_library": book.get("providing_library") or "",
    }


def _sort_key(book: dict):
    # 반납일을 못 읽은 대출은 대출 목록 맨 앞에 둔다. 확인이 필요한 건이라서.
    days = book["days_left"] if book["days_left"] is not None else -10**6
    return _ORDER[book["status"]], days


def normalize_reservation(reservation: dict) -> dict:
    return {
        "title": reservation.get("title") or "",
        "library": reservation.get("library") or "",
        "ready_for_pickup": bool(reservation.get("expiry_date")),
        "pickup_deadline": reservation.get("expiry_date") or None,
        "rank": reservation.get("rank") or None,
        "waiting_count": reservation.get("waiting_count") or None,
        "reserved_date": reservation.get("reserved_date") or None,
    }


def build_report(credentials: list[dict], infos: list[dict], now: datetime | None = None) -> dict:
    now = now or datetime.now()
    today = now.date()
    accounts = []
    for credential, info in zip(credentials, infos):
        books = sorted((normalize_book(b, today) for b in info.get("books", [])), key=_sort_key)
        reservations = [normalize_reservation(r) for r in info.get("reservations", [])]
        account = {
            "label": credential["label"],
            "name": None if info.get("error") else info.get("name"),
            "book_count": len(books),
            "interlibrary_count": sum(1 for b in books if b["is_interlibrary"]),
            "ready_for_pickup_count": sum(1 for b in books if b["status"] == READY_FOR_PICKUP)
            + sum(1 for r in reservations if r["ready_for_pickup"]),
            "books": books,
            "reservations": reservations,
        }
        if info.get("error"):
            account["error"] = info["error"]
        accounts.append(account)
    return {"fetched_at": now.isoformat(timespec="seconds"), "accounts": accounts}


def due_label(book: dict, due_soon: int) -> tuple[str, str]:
    """(표시 글자, 단계). 단계 ∈ {overdue, today, soon, normal, pickup, transit}."""
    if book["status"] == READY_FOR_PICKUP:
        return "픽업필요", "pickup"
    if book["status"] == IN_TRANSIT:
        return "이동중", "transit"
    days = book["days_left"]
    if days is None:
        return book["due_date"] or "반납일?", "normal"
    if days < 0:
        return f"연체 {-days}일", "overdue"
    if days == 0:
        return "오늘 반납", "today"
    return f"D-{days}", "soon" if days <= due_soon else "normal"


def short_name(label: str) -> str:
    """세 글자 한글 이름은 성을 뗀다(홍길동 → 길동). 탭·알림처럼 좁은 곳에서만 쓴다."""
    if len(label) == 3 and all("가" <= ch <= "힣" for ch in label):
        return label[1:]
    return label


def attention_items(report: dict, due_soon: int) -> tuple[list[str], list[str]]:
    """(찾아올 것, 반납 임박·연체) 줄 목록."""
    pickups, due = [], []
    for account in report["accounts"]:
        name = account["label"]
        for book in account["books"]:
            label, tier = due_label(book, due_soon)
            if tier == "pickup":
                pickups.append(f"{name}: {book['title']} (상호대차 도착 · {book['library']})")
            elif tier in ("overdue", "today", "soon"):
                due.append(f"{name}: {book['title']} ({label}, {book['due_date']})")
        for reservation in account["reservations"]:
            if reservation["ready_for_pickup"]:
                pickups.append(
                    f"{name}: {reservation['title']} (예약 도착 · {reservation['library']}, ~{reservation['pickup_deadline']})"
                )
    return pickups, due
