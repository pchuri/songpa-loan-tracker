from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel


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

    def set_count(self, n: int):
        if self.tier == "total":
            self._count_lbl.setText(f"{n}권")
        else:
            self._count_lbl.setText(str(n))

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
            ("📦", "대기", "waiting"),
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

    def update_counts(self, urgent: int, approaching: int, waiting: int, total: int):
        counts = {"urgent": urgent, "approaching": approaching, "waiting": waiting, "total": total}
        for item in self._items:
            item.set_count(counts.get(item.tier, 0))

    def set_checked_tier(self, tier: str | None):
        for item in self._items:
            if item.tier == "total":
                item.set_checked(False)
            else:
                item.set_checked(item.tier == tier)
