"""터미널용 요약 출력."""

from __future__ import annotations

import shutil
import unicodedata

from songpa_cli.report import due_label

_ANSI = {
    "overdue": "1;31",
    "today": "1;31",
    "soon": "1;33",
    "pickup": "1;33",
    "transit": "36",
    "normal": "32",
    "error": "31",
    "dim": "2",
    "bold": "1",
}


def _clean(text: str) -> str:
    """사이트 글자에 섞인 제어 문자를 뺀다. 터미널 색·커서를 건드리지 못하게."""
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cc")


def _width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _width(text))


# 이보다 좁은 화면(휴대폰 Termux는 40~50칸)에서는 도서관·날짜를 제목 아랫줄로 내린다.
NARROW_COLUMNS = 70
STATUS_WIDTH = 10


def render_text(report: dict, due_soon: int = 3, color: bool = False, columns: int | None = None) -> str:
    narrow = (columns or shutil.get_terminal_size().columns) < NARROW_COLUMNS

    def row(status: str, tier: str, title: str, detail: str) -> list[str]:
        head = f"  {paint(_pad(status, STATUS_WIDTH), tier)} {title}"
        if narrow:
            return [head, f"  {' ' * STATUS_WIDTH} {detail}"]
        return [f"{head}  {detail}"]

    def paint(text: str, tier: str) -> str:
        return f"\033[{_ANSI[tier]}m{text}\033[0m" if color else text

    accounts = report["accounts"]
    total = sum(a["book_count"] for a in accounts)
    inter = sum(a["interlibrary_count"] for a in accounts)
    pickups = sum(a["ready_for_pickup_count"] for a in accounts)
    fetched = report["fetched_at"].replace("T", " ")[:16]

    summary = f"{len(accounts)}개 계정 · 총 {total}권 (상호대차 {inter})"
    if pickups:
        summary += f" · 찾아올 책 {pickups}"
    lines = [paint(f"송파도서관 대출 현황 · {fetched}", "bold"), summary]

    for account in accounts:
        lines.append("")
        head = f"{account['label']}  대출 {account['book_count']}권 (상호대차 {account['interlibrary_count']})"
        if account["reservations"]:
            head += f" · 예약 {len(account['reservations'])}건"
        lines.append(paint(head, "bold"))
        if account.get("error"):
            lines.append("  " + paint(f"조회 실패: {account['error']}", "error"))
            continue
        if not account["books"] and not account["reservations"]:
            lines.append("  " + paint("이용 중인 책이 없습니다.", "dim"))
        for book in account["books"]:
            label, tier = due_label(book, due_soon)
            if tier == "pickup":
                where = f"{book['library']} 도착"
            elif tier == "transit":
                route = f"{book['providing_library']} → " if book["providing_library"] else ""
                where = f"{route}{book['library']} ({book['transit_status'] or '?'})"
            else:
                where = f"{book['library']} · {book['due_date']}"
                if book["is_interlibrary"]:
                    where += " · 상호대차"
            lines.extend(row(_clean(label), tier, _clean(book["title"]), paint(_clean(where), "dim")))
        for reservation in account["reservations"]:
            if reservation["ready_for_pickup"]:
                state = paint(_clean(f"수령대기 ~{reservation['pickup_deadline']}"), "pickup")
            else:
                state = f"{reservation['rank'] or '?'}순위"
            lines.extend(row("예약", "dim", _clean(reservation["title"]),
                             f"{paint(_clean(reservation['library']), 'dim')} {state}"))
    return "\n".join(lines)
