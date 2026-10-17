from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QVBoxLayout,
)

from src.book_status import compute_book_status
from src.widgets.elided_label import ElidedLabel

DUPLICATE_BADGE_TEXT = "확인 필요"
DUPLICATE_TOOLTIP = "대출 중인 책과 제목이 같은 상호대차입니다. 같은 권인지 확인되지 않았으니 사이트에서 확인하세요."


class BookCard(QFrame):
    clicked = Signal(dict)

    def __init__(self, book: dict, user_name: str, with_shadow: bool = True, parent=None):
        super().__init__(parent)
        self.book = book
        self.setObjectName("BookCard")
        self.setFixedSize(260, 160)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        tier, dday_label = compute_book_status(book)
        self.setProperty("tier", tier)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(6)

        top_row = QHBoxLayout()
        top_row.setSpacing(6)
        dday = QLabel(dday_label)
        dday.setObjectName("DdayBadge")
        dday.setProperty("tier", tier)
        dday.setAlignment(Qt.AlignmentFlag.AlignCenter)
        top_row.addWidget(dday)
        self.duplicate_badge = None
        if book.get("possible_duplicate"):
            # 제목만 같은 대출·상호대차는 합치지 않고 따로 보인다. 같은 권일 수 있음을 카드에서 바로 드러낸다.
            badge = QLabel(f"⚠️ {DUPLICATE_BADGE_TEXT}")
            badge.setObjectName("DuplicateBadge")
            badge.setToolTip(DUPLICATE_TOOLTIP)
            top_row.addWidget(badge)
            self.duplicate_badge = badge
            self.setToolTip(DUPLICATE_TOOLTIP)
        top_row.addStretch(1)
        icon_text = self._icon_for_tier(tier)
        if icon_text:
            icon_label = QLabel(icon_text)
            icon_label.setObjectName("CardStatusIcon")
            top_row.addWidget(icon_label)
        layout.addLayout(top_row)

        title = book.get("title", "") or "-"
        if len(title) > 50:
            title = title[:50] + "…"
        title_label = QLabel(title)
        title_label.setObjectName("CardTitle")
        title_label.setWordWrap(True)
        title_label.setMaximumHeight(46)
        layout.addWidget(title_label, 1)

        library = book.get("library") or book.get("receiving_library") or "-"
        providing = book.get("providing_library")
        library_text = f"{providing} → {library}" if providing else library
        lib_label = ElidedLabel(f"🏛  {library_text}")
        lib_label.setObjectName("CardMeta")
        layout.addWidget(lib_label)

        inter_mark = "  ⇄" if book.get("is_interlibrary") else ""
        user_label = ElidedLabel(f"👤  {user_name}{inter_mark}")
        user_label.setObjectName("CardMeta")
        layout.addWidget(user_label)

        self._shadow = None
        if with_shadow:
            shadow = QGraphicsDropShadowEffect(self)
            shadow.setBlurRadius(14)
            shadow.setColor(QColor(15, 23, 42, 30))
            shadow.setOffset(0, 2)
            self.setGraphicsEffect(shadow)
            self._shadow = shadow

    def enterEvent(self, event):
        if self._shadow is not None:
            self._shadow.setBlurRadius(22)
            self._shadow.setOffset(0, 4)
            self._shadow.setColor(QColor(15, 23, 42, 55))
        super().enterEvent(event)

    def leaveEvent(self, event):
        if self._shadow is not None:
            self._shadow.setBlurRadius(14)
            self._shadow.setOffset(0, 2)
            self._shadow.setColor(QColor(15, 23, 42, 30))
        super().leaveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.book)
        super().mousePressEvent(event)

    @staticmethod
    def _icon_for_tier(tier: str) -> str:
        if tier == "urgent":
            return "🔴"
        if tier == "approaching":
            return "🟠"
        if tier == "waiting":
            return "📦"
        return ""
