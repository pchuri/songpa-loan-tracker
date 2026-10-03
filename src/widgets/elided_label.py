from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel


class ElidedLabel(QLabel):
    """폭에 맞춰 자동으로 '…' 처리되는 QLabel."""

    def __init__(self, text: str = "", mode=Qt.TextElideMode.ElideRight, parent=None):
        super().__init__(parent)
        self._full_text = text
        self._elide_mode = mode
        self._update_elided()

    def setText(self, text: str):  # type: ignore[override]
        self._full_text = text
        self._update_elided()

    def text(self) -> str:  # type: ignore[override]
        return self._full_text

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._update_elided()

    def _update_elided(self):
        if not self._full_text:
            super().setText("")
            return
        width = max(0, self.width())
        if width <= 0:
            super().setText(self._full_text)
            return
        fm = self.fontMetrics()
        super().setText(fm.elidedText(self._full_text, self._elide_mode, width))
