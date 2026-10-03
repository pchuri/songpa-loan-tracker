from typing import Union

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QButtonGroup, QHBoxLayout, QPushButton, QWidget


class UserFilterBar(QWidget):
    selectionChanged = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("UserFilterBar")
        self._layout = QHBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.setSpacing(6)
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._group.buttonClicked.connect(lambda _: self.selectionChanged.emit())
        self._buttons: list[QPushButton] = []
        self._chip_data: dict = {}

    def set_users(self, user_counts: list[Union[tuple[str, int], tuple[str, int, int]]]):
        """user_counts: [(name, count), ...] 또는 [(name, count, inter_count), ...].

        3-튜플 항목은 "이름 N (M)" 형식으로 렌더링한다 (M = 상호대차 권수).
        2-튜플 항목은 기존대로 "이름 N"으로 렌더링한다 (예약 탭).
        """
        current = self.current_user()
        for btn in list(self._group.buttons()):
            self._group.removeButton(btn)
        while self._layout.count():
            item = self._layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        self._buttons.clear()
        self._chip_data.clear()

        normalized = []
        for entry in user_counts:
            if len(entry) == 3:
                name, count, inter = entry
                normalized.append((name, count, inter))
            elif len(entry) == 2:
                name, count = entry
                normalized.append((name, count, None))
            else:
                raise ValueError(
                    "user_counts entries must be (name, count) or "
                    f"(name, count, inter_count), got {entry!r}"
                )

        total = sum(c for _, c, _ in normalized)
        total_inter = (
            sum(i for _, _, i in normalized if i is not None)
            if any(i is not None for _, _, i in normalized)
            else None
        )
        all_label = f"전체 {total}" if total_inter is None else f"전체 {total} ({total_inter})"
        all_btn = self._make_chip(all_label, None)
        for name, count, inter in normalized:
            label = f"{name} {count}" if inter is None else f"{name} {count} ({inter})"
            self._make_chip(label, name)
        self._layout.addStretch(1)

        if current is not None:
            for btn in self._buttons:
                if self._chip_data.get(btn) == current:
                    btn.setChecked(True)
                    return
        all_btn.setChecked(True)

    def set_selection(self, user_name):
        for btn in self._buttons:
            if self._chip_data.get(btn) == user_name:
                btn.setChecked(True)
                return

    def _make_chip(self, label: str, user_name):
        btn = QPushButton(label)
        btn.setCheckable(True)
        btn.setObjectName("FilterChip")
        btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._group.addButton(btn)
        self._layout.addWidget(btn)
        self._buttons.append(btn)
        self._chip_data[btn] = user_name
        return btn

    def has_users(self) -> bool:
        """set_users()가 아직 안 불려 칩이 하나도 없는 상태를 구분한다.

        칩이 없을 때의 current_user()는 "전체 선택"이 아니라 "모름"이다.
        """
        return bool(self._buttons)

    def current_user(self):
        btn = self._group.checkedButton()
        if not btn:
            return None
        return self._chip_data.get(btn)
