import asyncio
import json
import os

import keyring
import keyring.errors
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


@pytest.fixture(scope="module")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


def test_main_window_constructs_when_keyring_fails(qapp, tmp_path, monkeypatch):
    def raise_error(*args, **kwargs):
        raise keyring.errors.KeyringError("access denied")

    monkeypatch.setattr(keyring, "get_password", raise_error)
    monkeypatch.setattr(keyring, "set_password", raise_error)
    monkeypatch.setenv("HOME", str(tmp_path))

    config_dir = tmp_path / ".jenaonbot"
    config_dir.mkdir()
    config = {
        "env": {},
        "users": [{"userId": "user1", "encrypted_password": "gAAAAAB-unreadable"}],
        "auto_refresh_interval": 5,
    }
    (config_dir / "config.json").write_text(json.dumps(config))

    from PySide6.QtWidgets import QMessageBox

    warnings = []

    def fake_warning(*args, **kwargs):
        warnings.append(args)
        return QMessageBox.StandardButton.Ok

    monkeypatch.setattr(QMessageBox, "warning", fake_warning)

    from src.main_window import MainWindow

    loop = asyncio.new_event_loop()
    try:
        window = MainWindow(loop)
        # app is up, users are listed, passwords empty
        assert window.config_store.keychain_error
        assert window.users == [{"userId": "user1", "password": ""}]
        assert window.users_list.count() == 1
        assert window.users_list.item(0).text() == "user1"
        # no usable password: periodic auto-refresh must not be armed
        assert window.auto_refresh_timer is None
        # the startup keychain warning actually fires and is in Korean
        for _ in range(5):
            qapp.processEvents()
        assert any("키체인" in str(arg) for call in warnings for arg in call)
        # ciphertext on disk untouched
        on_disk = json.loads((config_dir / "config.json").read_text())
        assert on_disk == config
        window.close()
    finally:
        loop.close()


def _reservation(reservation_id, title, library, rank, waiting, expiry_date=""):
    return {
        "reservation_id": reservation_id,
        "title": title,
        "library": library,
        "room": f"{library} 자료실",
        "reserved_date": "2026.08.23",
        "rank": rank,
        "waiting_count": waiting,
        "book_status": "대출중",
        "due_date": "",
        "expiry_date": expiry_date,
    }


@pytest.fixture
def window(qapp, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / ".jenaonbot"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(json.dumps({"env": {}, "users": []}))

    from src.main_window import MainWindow

    loop = asyncio.new_event_loop()
    win = MainWindow(loop)
    try:
        yield win
    finally:
        win.close()
        loop.close()


def test_reservation_tab_renders_a_card_per_reservation(window):
    """같은 책을 여러 도서관에 걸어둔 예약도 각각 카드 한 장씩 나와야 한다."""
    infos = [{
        "name": "사용자",
        "books": [],
        "reservations": [
            _reservation("1", "물결의 이름", "거마", 3, 5),
            _reservation("2", "물결의  이름", "돌마리", 4, 5),
            _reservation("3", "(부제)물결의 이름 : 부제", "위례", 2, 5),
            _reservation("4", "다른 책", "엘스", 1, 2, expiry_date="2026.08.29"),
        ],
    }]

    window._populate_reservations(infos)

    assert window.reservation_layout.count() == 4
    label = window.tabs.tabText(window.tabs.indexOf(window.reservation_tab))
    assert label == "예약 현황 (4 · 수령 1)"


def test_same_book_cards_sit_together(window):
    infos = [{
        "name": "사용자",
        "books": [],
        "reservations": [
            _reservation("1", "물결의 이름", "거마", 3, 5),
            _reservation("2", "끼어드는 책", "엘스", 2, 4),
            _reservation("3", "물결의  이름", "돌마리", 4, 5),
            _reservation("4", "물결의 이름", "위례", 5, 5),
        ],
    }]

    window.reservation_sort_combo.setCurrentText("책별")
    ids = [r["reservation_id"] for _, r, _ in window._flatten_and_sort_reservations(infos)]

    positions = sorted(ids.index(i) for i in ("1", "3", "4"))
    assert positions == [positions[0], positions[0] + 1, positions[0] + 2], ids


def test_group_size_counts_distinct_libraries_not_reservations(window):
    """'같은 책 N곳'은 예약 건수가 아니라 도서관 수다.

    한 도서관에 두 건이 잡혀 있어도 "2곳"이라고 말하면 안 된다.
    """
    infos = [{
        "name": "사용자",
        "books": [],
        "reservations": [
            _reservation("1", "물결의 이름", "거마", 3, 5),
            _reservation("2", "물결의  이름", "돌마리", 4, 5),
            _reservation("3", "물결의 이름", "거마", 5, 5),   # 거마에 두 번째 건
            _reservation("4", "끼어드는 책", "엘스", 2, 4),
        ],
    }]

    sizes = {r["reservation_id"]: size
             for _, r, size in window._flatten_and_sort_reservations(infos)}

    assert sizes == {"1": 2, "2": 2, "3": 2, "4": 1}


def test_two_users_holding_the_same_book_are_not_one_group(window):
    """다른 사람의 예약은 '같은 책'이 아니다."""
    infos = [
        {"name": "가", "books": [], "reservations": [_reservation("1", "총, 균, 쇠", "거마", 1, 2)]},
        {"name": "나", "books": [], "reservations": [_reservation("2", "총, 균, 쇠", "거마", 2, 2)]},
    ]

    sizes = {r["reservation_id"]: size
             for _, r, size in window._flatten_and_sort_reservations(infos)}

    assert sizes == {"1": 1, "2": 1}


def test_group_size_is_stable_when_the_user_filter_changes(window):
    infos = [
        {"name": "가", "books": [], "reservations": [
            _reservation("1", "물결의 이름", "거마", 1, 2),
            _reservation("2", "물결의 이름", "돌마리", 2, 2),
        ]},
        {"name": "나", "books": [], "reservations": [_reservation("3", "물결의 이름", "위례", 1, 2)]},
    ]
    window.last_infos = infos
    window._populate_reservations(infos)

    unfiltered = {r["reservation_id"]: s
                  for _, r, s in window._flatten_and_sort_reservations(infos)}
    window.reservation_user_filter.set_selection("가")
    filtered = {r["reservation_id"]: s
                for _, r, s in window._flatten_and_sort_reservations(infos)}

    assert unfiltered == {"1": 2, "2": 2, "3": 1}
    assert filtered == {"1": 2, "2": 2}


def test_a_book_group_is_not_torn_apart_by_the_pickup_hoist(window):
    """수령 대기 카드를 뽑아 올리면 같은 책 카드가 그리드 양끝으로 찢어진다."""
    infos = [{
        "name": "사용자",
        "books": [],
        "reservations": [
            _reservation("1", "물결의 이름", "거마", 3, 5),
            _reservation("2", "끼어드는 책", "엘스", 1, 2),
            _reservation("3", "물결의 이름", "돌마리", 0, 5, expiry_date="2026.08.29"),
            _reservation("4", "물결의 이름", "위례", 4, 5),
        ],
    }]

    window.reservation_sort_combo.setCurrentText("책별")
    ids = [r["reservation_id"] for _, r, _ in window._flatten_and_sort_reservations(infos)]

    assert ids[:3] == ["3", "1", "4"], ids   # 수령 대기가 그룹 선두, 그룹은 붙어 있다
    assert ids[3] == "2"


def test_pickup_waiting_reservations_are_ordered_by_deadline(window):
    """만기가 지난 건이 D-35보다 뒤에 오면 안 된다."""
    infos = [{
        "name": "사용자",
        "books": [],
        "reservations": [
            _reservation("1", "먼 책", "거마", 0, 1, expiry_date="2026.09.30"),
            _reservation("2", "지난 책", "돌마리", 0, 1, expiry_date="2026.08.01"),
            _reservation("3", "오늘 책", "위례", 0, 1, expiry_date="2026.08.26"),
        ],
    }]

    for sort_key in ("책별", "예약순번", "예약일", "도서관"):
        window.reservation_sort_combo.setCurrentText(sort_key)
        ids = [r["reservation_id"] for _, r, _ in window._flatten_and_sort_reservations(infos)]
        assert ids == ["2", "3", "1"], f"{sort_key}: {ids}"


@pytest.mark.parametrize("sort_key", ["책별", "예약순번", "예약일", "도서관"])
def test_pickup_waiting_reservation_floats_to_the_top(window, sort_key):
    """수령 마감이 걸린 건은 어떤 정렬에서도 맨 앞이어야 한다."""
    infos = [{
        "name": "사용자",
        "books": [],
        "reservations": [
            _reservation("1", "가나다", "거마", 1, 5),
            _reservation("2", "하하하", "위례", 9, 9, expiry_date="2026.08.29"),
            _reservation("3", "마바사", "돌마리", 2, 5),
        ],
    }]

    window.reservation_sort_combo.setCurrentText(sort_key)
    rows = window._flatten_and_sort_reservations(infos)

    assert rows[0][1]["reservation_id"] == "2"


def test_empty_reservations_show_the_empty_state(window):
    infos = [{"name": "사용자", "books": [], "reservations": []}]

    window._populate_reservations(infos)

    assert window.reservation_layout.count() == 0
    assert not window.reservation_empty_state.isHidden()
    assert "예약 중인 도서가 없습니다" in window.reservation_empty_message.text()
    assert window.tabs.tabText(window.tabs.indexOf(window.reservation_tab)) == "예약 현황"


def test_user_filter_hiding_every_reservation_offers_a_way_out(window):
    infos = [
        {"name": "가", "books": [], "reservations": [_reservation("1", "책", "거마", 1, 2)]},
        {"name": "나", "books": [], "reservations": []},
    ]
    window.last_infos = infos
    window._populate_reservations(infos)

    window.reservation_user_filter.set_selection("나")
    window._populate_reservations(infos)

    assert window.reservation_layout.count() == 0
    assert "이 조건에 해당하는 예약이 없습니다" in window.reservation_empty_message.text()
    assert not window.reservation_clear_button.isHidden()

    window._clear_reservation_filters()

    assert window.reservation_layout.count() == 1
    assert window.reservation_empty_state.isHidden()


def test_all_accounts_failing_is_not_reported_as_having_no_books(window):
    """조회 실패가 '예약 중인 도서가 없습니다'로 보이면 안 된다."""
    infos = [{
        "name": "user1", "books": [], "reservations": [],
        "error": "조회 시간이 초과되었습니다",
    }]

    window._populate_cards(infos)
    window._populate_reservations(infos)

    assert "조회에 실패했습니다" in window.empty_message.text()
    assert "조회에 실패했습니다" in window.reservation_empty_message.text()


def test_a_raising_refresh_does_not_leave_the_tabs_on_loading(window):
    """예외로 조회가 끊겼을 때 두 탭이 '불러오는 중'에 갇히면 안 된다."""
    window.empty_message.setText("📚  불러오는 중...")
    window.reservation_empty_message.setText("📚  불러오는 중...")

    window._restore_after_failed_refresh()

    assert "불러오는 중" not in window.empty_message.text()
    assert "불러오는 중" not in window.reservation_empty_message.text()
    assert "조회에 실패했습니다" in window.reservation_empty_message.text()


def test_a_raising_refresh_redraws_the_last_known_data(window):
    infos = [{
        "name": "사용자", "books": [],
        "reservations": [_reservation("1", "책", "거마", 1, 2)],
    }]
    window.last_infos = infos
    window._clear_reservation_cards()
    window.reservation_empty_message.setText("📚  불러오는 중...")

    window._restore_after_failed_refresh()

    assert window.reservation_layout.count() == 1
    assert window.reservation_empty_state.isHidden()


def test_saving_before_the_first_fetch_keeps_the_remembered_user_selections(window):
    """칩이 만들어지기 전 저장이 기억해둔 선택을 지우면 안 된다."""
    window._saved_user_selection = "엄마"
    window._saved_reservation_user_selection = "아빠"

    state = window._current_ui_state()

    assert state["selected_user"] == "엄마"
    assert state["reservation_selected_user"] == "아빠"


def test_once_chips_exist_the_actual_selection_wins(window):
    infos = [
        {"name": "엄마", "books": [], "reservations": [_reservation("1", "책", "거마", 1, 2)]},
        {"name": "아빠", "books": [], "reservations": []},
    ]
    window._saved_reservation_user_selection = "엄마"
    window._populate_reservations(infos)
    window.reservation_user_filter.set_selection(None)

    assert window._current_ui_state()["reservation_selected_user"] is None
