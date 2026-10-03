from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QVBoxLayout,
)

from src.reservation_status import compute_reservation_status, is_ready_for_pickup
from src.widgets.elided_label import ElidedLabel


class ReservationCard(QFrame):
    clicked = Signal(dict)

    def __init__(self, reservation: dict, user_name: str, group_size: int = 1,
                 with_shadow: bool = True, parent=None):
        super().__init__(parent)
        self.reservation = reservation
        self.setObjectName("ReservationCard")
        self.setFixedSize(260, 160)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        tier, badge_label = compute_reservation_status(reservation)
        self.setProperty("tier", tier)

        room = reservation.get("room") or ""
        if room:
            self.setToolTip(room)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(6)

        top_row = QHBoxLayout()
        top_row.setSpacing(6)
        badge = QLabel(badge_label)
        badge.setObjectName("DdayBadge")
        badge.setProperty("tier", tier)
        badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        top_row.addWidget(badge)
        top_row.addStretch(1)
        icon_text = self._icon_for(reservation, tier)
        if icon_text:
            icon_label = QLabel(icon_text)
            icon_label.setObjectName("CardStatusIcon")
            top_row.addWidget(icon_label)
        layout.addLayout(top_row)

        title = reservation.get("title", "") or "-"
        if len(title) > 50:
            title = title[:50] + "…"
        title_label = QLabel(title)
        title_label.setObjectName("CardTitle")
        title_label.setWordWrap(True)
        title_label.setMaximumHeight(46)
        layout.addWidget(title_label, 1)

        library = reservation.get("library") or "-"
        library_text = f"🏛  {library}"
        if group_size > 1:
            library_text += f"  ·  같은 책 {group_size}곳"
        lib_label = ElidedLabel(library_text)
        lib_label.setObjectName("CardMeta")
        layout.addWidget(lib_label)

        waiting = reservation.get("waiting_count") or 0
        waiting_mark = f"  ·  {waiting}명 대기" if waiting else ""
        user_label = ElidedLabel(f"👤  {user_name}{waiting_mark}")
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
            self.clicked.emit(self.reservation)
        super().mousePressEvent(event)

    @staticmethod
    def _icon_for(reservation: dict, tier: str) -> str:
        if is_ready_for_pickup(reservation):
            return "🎁"
        if tier == "approaching":
            return "🟠"
        return ""
