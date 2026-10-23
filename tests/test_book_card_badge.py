import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


@pytest.fixture(scope="module")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


def _badge_background(qapp, stylesheet, due_date):
    from PySide6.QtWidgets import QLabel

    from src.widgets.book_card import BookCard

    qapp.setStyleSheet(stylesheet)
    card = BookCard({"title": "책", "due_date": due_date, "library": "송파글마루도서관"}, "제나", with_shadow=False)
    card.show()
    qapp.processEvents()
    from PySide6.QtCore import QPoint

    badge = card.findChild(QLabel, "DdayBadge")
    image = card.grab().toImage()
    # 글자를 피해 배지 왼쪽 가장자리 안쪽 픽셀과, 배지 바로 오른쪽 카드 픽셀을 비교한다.
    inside = badge.mapTo(card, QPoint(4, badge.height() // 2))
    outside = badge.mapTo(card, QPoint(badge.width() + 2, badge.height() // 2))
    background = image.pixelColor(inside.x(), inside.y()).name()
    card_background = image.pixelColor(outside.x(), outside.y()).name()
    return background, card_background


@pytest.mark.parametrize("theme", ["LIGHT_STYLESHEET", "DARK_STYLESHEET"])
def test_transit_badge_has_no_background_but_pickup_does(qapp, theme):
    from src import styles

    stylesheet = getattr(styles, theme)
    pickup_bg, card_bg = _badge_background(qapp, stylesheet, "입수")
    transit_bg, card_bg = _badge_background(qapp, stylesheet, "발송")
    assert pickup_bg == "#7c3aed"
    assert transit_bg == card_bg
