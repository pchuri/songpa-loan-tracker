"""반납·픽업 리포트: 도서관에 들렀을 때 어디서 무엇을 찾고 어디에 무엇을 반납할지.

build_report()가 만든 결과를 도서관(대출관·수령관)별로 묶는다. 카톡에 그대로 붙여넣을
수 있게 플레인텍스트로 낸다. 사람 이름은 계정 label만 쓴다.
"""

from __future__ import annotations

import re
from datetime import date, datetime

from songpa_cli.report import IN_TRANSIT, LOANED, READY_FOR_PICKUP, parse_date, short_name

# 상호대차로 받은 다른 관 책을 여기에 반납해도 되는지 확실하지 않은 곳.
# 스마트도서관은 무인 대출·반납기라 다른 관 소장 상호대차 책은 반납처를 따로 확인해야 한다.
AMBIGUOUS_RETURN_LIBRARIES = {"스마트"}

UNKNOWN_LIBRARY = "도서관 미상"

_LEADING_PAREN = re.compile(r"^\s*\([^)]*\)\s*")
_SUBTITLE = re.compile(r"\s+[:=]\s+.*$")


def short_title(title: str) -> str:
    """카톡에서 읽기 좋게 줄인 제목. 앞 괄호 머리말과 ' : 부제', ' = 원제'를 뗀다.

    '(세계문학)변신' → '변신', '어린 왕자 : 생텍쥐페리 소설' → '어린 왕자'.
    다 떼고 나서 빈 글자가 되면 원래 제목을 쓴다.
    """
    text = _SUBTITLE.sub("", _LEADING_PAREN.sub("", title or "")).strip()
    return text or (title or "").strip()


def library_display(library: str) -> str:
    """'영어' → '영어도서관'. 카드용 줄임 이름에 '도서관'을 다시 붙인다."""
    if not library or library == UNKNOWN_LIBRARY or library.endswith("도서관"):
        return library
    return f"{library}도서관"


def _md(day: date) -> str:
    return f"{day.month}/{day.day}"


def _due_note(days_left: int | None, due: date | None) -> str:
    if days_left is None:
        return "반납일 확인 필요"
    if days_left < 0:
        return f"연체 {-days_left}일"
    if days_left == 0:
        return "오늘까지"
    return f"{_md(due)}까지" if due else f"D-{days_left}"


def _needs_return_check(book: dict) -> bool:
    library = book["library"]
    providing = book["providing_library"]
    return (
        book["is_interlibrary"]
        and library in AMBIGUOUS_RETURN_LIBRARIES
        and bool(providing)
        and providing != library
    )


def build_plan(report: dict) -> dict:
    """{"date", "libraries": [{"library", "returns", "pickups"}], "in_transit", "failed", "partial"}.

    각 항목은 {"title", "who", "notes", "needs_check"}다. 반납은 연체·임박 순,
    픽업은 수령 마감이 빠른 순, 도서관은 가장 급한 일이 있는 곳부터 세운다.
    """
    today = datetime.fromisoformat(report["fetched_at"]).date()
    libraries: dict[str, dict] = {}
    in_transit = []
    failed = 0
    partial = 0

    def section(library: str) -> dict:
        name = library or UNKNOWN_LIBRARY
        return libraries.setdefault(name, {"library": name, "returns": [], "pickups": []})

    for account in report["accounts"]:
        if account.get("error"):
            failed += 1
            continue
        if account.get("partial"):
            partial += 1
        who = short_name(account["label"])
        for book in account["books"]:
            item = {"title": short_title(book["title"]), "who": who, "notes": [], "needs_check": False}
            if book["status"] == READY_FOR_PICKUP:
                item["notes"].append("상호대차")
                if book.get("possible_duplicate"):
                    item["notes"].append("대출 중인 책과 제목 같음, 확인 필요")
                    item["needs_check"] = True
                item["_sort"] = ("9999.99.99", who, item["title"])
                section(book["library"])["pickups"].append(item)
            elif book["status"] == IN_TRANSIT:
                route = book["library"] or UNKNOWN_LIBRARY
                if book["providing_library"]:
                    route = f"{book['providing_library']}→{route}"
                item["notes"].append(route)
                if book["transit_status"]:
                    item["notes"].append(book["transit_status"])
                in_transit.append(item)
            elif book["status"] == LOANED:
                days = book["days_left"]
                item["notes"].append(_due_note(days, parse_date(book["due_date"])))
                if days is None:
                    item["needs_check"] = True
                if _needs_return_check(book):
                    item["notes"].append(f"반납처 확인({book['providing_library']} 책)")
                    item["needs_check"] = True
                item["_days"] = days
                item["_sort"] = (days if days is not None else -10**6, who, item["title"])
                section(book["library"])["returns"].append(item)
        for reservation in account["reservations"]:
            if not reservation["ready_for_pickup"]:
                continue
            deadline = parse_date(reservation["pickup_deadline"])
            item = {"title": short_title(reservation["title"]), "who": who, "notes": ["예약도서"],
                    "needs_check": False}
            if deadline:
                item["notes"].append(f"{_md(deadline)}까지")
            item["_sort"] = (deadline.strftime("%Y.%m.%d") if deadline else "0000", who, item["title"])
            section(reservation["library"])["pickups"].append(item)

    def urgency(sec: dict):
        # 픽업할 책이 있으면 오늘 갈 이유가 있는 곳으로 본다(0일). 반납일을 못 읽은 책도 급한 쪽.
        days = [-10**6 if r["_days"] is None else r["_days"] for r in sec["returns"]]
        if sec["pickups"]:
            days.append(0)
        return (min(days) if days else 10**6, sec["library"] == UNKNOWN_LIBRARY, sec["library"])

    ordered = sorted(libraries.values(), key=urgency)
    for sec in ordered:
        sec["returns"].sort(key=lambda item: item["_sort"])
        sec["pickups"].sort(key=lambda item: item["_sort"])
    in_transit.sort(key=lambda item: (item["who"], item["title"]))
    for item in [i for sec in ordered for i in sec["returns"] + sec["pickups"]]:
        item.pop("_sort", None)
        item.pop("_days", None)

    return {"date": today, "libraries": ordered, "in_transit": in_transit, "failed": failed, "partial": partial}


def _line(item: dict) -> str:
    return f"- {item['title']} ({', '.join([item['who'], *item['notes']])})"


def format_plan_text(plan: dict) -> str:
    """카톡에 붙여넣을 플레인텍스트."""
    lines = [f"도서관 반납·픽업 ({_md(plan['date'])} 기준)"]
    for sec in plan["libraries"]:
        name = library_display(sec["library"])
        if sec["returns"]:
            lines.append(f"[{name} 반납]")
            lines.extend(_line(item) for item in sec["returns"])
        if sec["pickups"]:
            lines.append(f"[{name} 픽업]")
            lines.extend(_line(item) for item in sec["pickups"])
    if plan["in_transit"]:
        lines.append("[아직 못 찾음 - 이동 중]")
        lines.extend(_line(item) for item in plan["in_transit"])
    if not plan["libraries"] and not plan["in_transit"]:
        lines.append("반납하거나 찾아올 책이 없습니다.")
    if plan["failed"]:
        lines.append(f"(조회 실패 {plan['failed']}개 계정은 빠졌습니다)")
    if plan.get("partial"):
        lines.append(f"(일부만 읽은 {plan['partial']}개 계정은 빠진 책이 있을 수 있습니다)")
    return "\n".join(lines)
