import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


@pytest.fixture(scope="module")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


def _chip_texts(bar):
    return [btn.text() for btn in bar._buttons]


def test_chips_show_interlibrary_counts(qapp):
    from src.widgets import UserFilterBar

    bar = UserFilterBar()
    bar.set_users([("홍길동", 6, 3), ("김철수", 4, 0)])
    assert _chip_texts(bar) == ["전체 10 (3)", "홍길동 6 (3)", "김철수 4 (0)"]
    bar.close()


def test_chips_without_interlibrary_counts_keep_legacy_labels(qapp):
    from src.widgets import UserFilterBar

    bar = UserFilterBar()
    bar.set_users([("홍길동", 6), ("김철수", 4)])
    assert _chip_texts(bar) == ["전체 10", "홍길동 6", "김철수 4"]
    bar.close()


def test_malformed_entries_raise(qapp):
    from src.widgets import UserFilterBar

    bar = UserFilterBar()
    with pytest.raises(ValueError):
        bar.set_users([("홍길동",)])
    with pytest.raises(ValueError):
        bar.set_users([("홍길동", 6, 3, "extra")])
    bar.close()


def test_selection_survives_relabel(qapp):
    from src.widgets import UserFilterBar

    bar = UserFilterBar()
    bar.set_users([("홍길동", 6, 3), ("김철수", 4, 1)])
    bar.set_selection("김철수")
    bar.set_users([("홍길동", 6, 3), ("김철수", 4, 1)])
    assert bar.current_user() == "김철수"
    bar.close()
