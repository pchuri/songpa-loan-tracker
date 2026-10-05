"""안드로이드 Termux 알림 (termux-notification, Termux:API 앱 필요)."""

from __future__ import annotations

import shutil
import subprocess

from songpa_cli.report import attention_items, short_name

NOTIFICATION_ID = "songpa_library_status"


def build_notification(report: dict, due_soon: int = 3) -> tuple[str, str, str]:
    """(제목, 본문, 우선순위)."""
    pickups, due = attention_items(report, due_soon)
    accounts = report["accounts"]
    total = sum(a["book_count"] for a in accounts)
    failed = [a["label"] for a in accounts if a.get("error")]

    if pickups or due:
        title = f"송파도서관: 찾아올 책 {len(pickups)} · 반납 임박 {len(due)}"
        priority = "high"
    else:
        title = f"송파도서관: 총 {total}권 대출 중 (임박 없음)"
        priority = "default"

    lines = []
    if pickups:
        lines.append(f"📦 찾아올 책 {len(pickups)}")
        lines.extend(f"• {item}" for item in pickups)
        lines.append("")
    if due:
        lines.append(f"⏰ 반납 임박·연체 {len(due)}")
        lines.extend(f"• {item}" for item in due)
        lines.append("")
    lines.append(f"📚 대출 {total}권: " + " / ".join(f"{short_name(a['label'])} {a['book_count']}" for a in accounts))
    if failed:
        lines.append("⚠️ 조회 실패: " + ", ".join(failed))
    return title, "\n".join(lines).strip(), priority


# Termux:API 앱이 없거나 권한이 없으면 termux-notification이 끝나지 않고 멈춰 있는다.
NOTIFY_TIMEOUT_SECONDS = 15


def send_notification(report: dict, due_soon: int = 3) -> bool:
    """알림을 보낸다. 보내지 못하면(명령 없음·실패·시간 초과) False."""
    if not shutil.which("termux-notification"):
        return False
    title, content, priority = build_notification(report, due_soon)
    try:
        result = subprocess.run(
            ["termux-notification", "--id", NOTIFICATION_ID, "--title", title, "--content", content,
             "--priority", priority, "--icon", "menu_book"],
            stdin=subprocess.DEVNULL, timeout=NOTIFY_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0
