from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel

INCOMPLETE_TOOLTIP = "일부 계정을 끝까지 읽지 못했거나 조회에 실패해 합계가 확정치가 아닙니다 (실제로는 더 많을 수 있음)."


class SummaryItem(QFrame):
    """클릭 가능한 요약 항목. tier를 Signal로 발행."""

    clicked = Signal(str)

    def __init__(self, icon: str, label: str, tier: str, interactive: bool = True, parent=None):
        super().__init__(parent)
        self.tier = tier
        self._interactive = interactive
        self.setObjectName("SummaryItem")
        self.setProperty("tier", tier)
        self.setProperty("checked", False)
        if interactive:
            self.setCursor(Qt.CursorShape.PointingHandCursor)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(10, 6, 10, 6)
        layout.setSpacing(6)

        icon_lbl = QLabel(icon)
        text_lbl = QLabel(label)
        text_lbl.setObjectName("SummaryLabel")
        count_lbl = QLabel("0")
        count_lbl.setObjectName("SummaryCount")
        count_lbl.setProperty("tier", tier)
        layout.addWidget(icon_lbl)
        layout.addWidget(text_lbl)
        layout.addWidget(count_lbl)

        self._count_lbl = count_lbl

    def set_count(self, n: int, incomplete: bool = False):
        """incomplete면 숫자가 하한일 뿐임을 글자와 툴팁으로 드러낸다."""
        if self.tier == "total":
            text = f"{n}권"
        else:
            text = str(n)
        if incomplete:
            text += " (미확정)" if self.tier == "total" else "+"
        self._count_lbl.setText(text)
        self.setProperty("incomplete", bool(incomplete))
        self.setToolTip(INCOMPLETE_TOOLTIP if incomplete else "")

    def count_text(self) -> str:
        return self._count_lbl.text()

    def set_checked(self, value: bool):
        self.setProperty("checked", bool(value))
        self.style().unpolish(self)
        self.style().polish(self)

    def mousePressEvent(self, event):
        if self._interactive and event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.tier)
        super().mousePressEvent(event)


class SummaryBar(QFrame):
    tierClicked = Signal(str)
    FILTER_TIERS = (None, "urgent", "approaching", "pickup", "transit")

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("SummaryBar")
        layout = QHBoxLayout(self)
        layout.setContentsMargins(10, 8, 10, 8)
        layout.setSpacing(4)

        self._items: list[SummaryItem] = []
        for icon, label, tier in [
            ("🔴", "긴급", "urgent"),
            ("🟠", "임박", "approaching"),
            ("🎁", "찾아갈 책", "pickup"),
            ("🚚", "이동 중", "transit"),
        ]:
            item = SummaryItem(icon, label, tier, interactive=True)
            item.clicked.connect(self.tierClicked.emit)
            layout.addWidget(item)
            self._items.append(item)

        layout.addStretch(1)

        total_item = SummaryItem("📚", "총", "total", interactive=True)
        total_item.clicked.connect(self.tierClicked.emit)
        layout.addWidget(total_item)
        self._items.append(total_item)

    def update_counts(self, urgent: int, approaching: int, pickup: int, transit: int, total: int,
                      incomplete: bool = False):
        """incomplete=True: 일부 계정이 partial이거나 실패해 모든 숫자가 하한일 뿐이다."""
        counts = {"urgent": urgent, "approaching": approaching, "pickup": pickup, "transit": transit,
                  "total": total}
        for item in self._items:
            item.set_count(counts.get(item.tier, 0), incomplete=incomplete)

    def count_text(self, tier: str) -> str:
        for item in self._items:
            if item.tier == tier:
                return item.count_text()
        return ""

    def set_checked_tier(self, tier: str | None):
        for item in self._items:
            if item.tier == "total":
                item.set_checked(False)
            else:
                item.set_checked(item.tier == tier)
