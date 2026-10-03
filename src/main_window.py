import asyncio
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QAction, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)
from qasync import asyncSlot

from core.splib import get_infos_async
from src.book_status import compute_book_status
from src.config_store import ConfigStore
from src.reservation_status import compute_reservation_status, group_key, is_ready_for_pickup
from src.styles import DARK_STYLESHEET, LIGHT_STYLESHEET, build_font_rule
from src.widgets import BookCard, FlowLayout, ReservationCard, SummaryBar, UserFilterBar


def _all_failed(infos) -> bool:
    """모든 계정이 error 엔트리로 돌아왔는지. 그 경우 빈 목록은 "없음"이 아니라 "실패"다."""
    return bool(infos) and all(entry.get("error") for entry in infos)


class MainWindow(QMainWindow):
    ENV_FIELDS: list[str] = []

    def __init__(self, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self.loop = loop
        self.config_store = ConfigStore()
        self.config_data = self.config_store.load()
        self.env_data = self.config_data.get("env", {k: v for k, v in self.config_data.items() if k != "users"})
        self.users = self._normalize_users(self.config_data.get("users", []))
        self.config_store.apply_env(self.config_data)
        self.last_infos = None
        self.auto_refresh_interval = self.config_data.get("auto_refresh_interval", 0)
        self.auto_refresh_timer = None
        self.dark_mode = self.config_data.get("dark_mode", False)
        self._last_updated_labels = []
        self._refresh_buttons = []

        ui_state = self.config_data.get("ui_state", {})
        self._initial_sort_key = ui_state.get("sort_key", "반납일")
        self._initial_inter_only = bool(ui_state.get("interlibrary_only", False))
        self._saved_user_selection = ui_state.get("selected_user")
        self._pending_user_selection = self._saved_user_selection
        self.tier_filter = ui_state.get("tier_filter")
        self._initial_reservation_sort_key = ui_state.get("reservation_sort_key", "책별")
        self._saved_reservation_user_selection = ui_state.get("reservation_selected_user")
        self._pending_reservation_user_selection = self._saved_reservation_user_selection
        self._suppress_state_save = False

        self.setWindowTitle("송파도서관 대출현황")
        self.resize(960, 720)

        self.tabs = QTabWidget()
        self.status_tab = self._build_status_tab()
        self.reservation_tab = self._build_reservation_tab()
        self.settings_tab = self._build_settings_tab()

        self.tabs.addTab(self.status_tab, "대출 현황")
        self.tabs.addTab(self.reservation_tab, "예약 현황")
        self.tabs.addTab(self.settings_tab, "설정")

        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.tabs)
        self.setCentralWidget(container)

        self.summary_bar.set_checked_tier(self.tier_filter)

        if any(u.get("password") for u in self.users):
            QTimer.singleShot(500, self.refresh_status)

        self._setup_shortcuts()
        self._start_auto_refresh_timer()
        self._apply_theme()

        if self.config_store.keychain_error:
            QTimer.singleShot(0, self._show_keychain_warning)
        elif self.config_store.decrypt_failed_users:
            QTimer.singleShot(0, self._show_decrypt_failure_warning)

        # 자동 업데이트 확인 (Windows 빌드에서만 동작)
        # 이전 업데이트 시도의 잔재가 있으면 먼저 치운다.
        from src import updater as _updater_startup
        _updater_startup.clean_stale_update_files()
        QTimer.singleShot(3000, self._check_for_updates)

    def _check_for_updates(self):
        from src import updater

        if not updater.should_check():
            return
        self._update_checker = updater.UpdateChecker()
        self._update_checker.update_found.connect(self._on_update_found)
        self._update_checker.start()

    def _on_update_found(self, result):
        from src import updater

        version_info, exe_asset = result
        remote_version = (version_info or {}).get("version")
        box = QMessageBox(self)
        box.setWindowTitle("업데이트")
        box.setText(
            f"새 버전(v{remote_version})이 있습니다. 업데이트하고 다시 시작할까요?"
            if remote_version
            else "새 버전이 있습니다. 업데이트하고 다시 시작할까요?"
        )
        update_btn = box.addButton("업데이트", QMessageBox.YesRole)
        box.addButton("나중에", QMessageBox.NoRole)
        box.setDefaultButton(update_btn)
        box.exec()
        if box.clickedButton() is not update_btn:
            return
        self._download_and_apply_update(exe_asset)

    def _download_and_apply_update(self, exe_asset):
        from PySide6.QtCore import Qt
        from PySide6.QtWidgets import QProgressDialog

        from src import updater

        progress = QProgressDialog("업데이트 다운로드 중...", "취소", 0, 100, self)
        progress.setWindowModality(Qt.WindowModal)
        progress.show()

        def on_progress(done, total):
            if progress.wasCanceled():
                raise updater.DownloadCancelled()
            if total:
                progress.setValue(int(done * 100 / total))
            QApplication.processEvents()

        try:
            bat_path = updater.apply_update(exe_asset, progress_cb=on_progress)
        except updater.DownloadCancelled:
            progress.close()
            return
        except Exception as exc:
            progress.close()
            QMessageBox.warning(self, "업데이트 실패", f"다운로드 중 오류가 발생했습니다.\n{exc}")
            return
        progress.close()
        updater.launch_updater(bat_path)
        QApplication.instance().quit()

    def _show_decrypt_failure_warning(self):
        names = ", ".join(self.config_store.decrypt_failed_users)
        QMessageBox.warning(
            self,
            "저장된 비밀번호 복호화 실패",
            "저장된 비밀번호를 읽을 수 없습니다. 암호화에 쓰인 키체인의 "
            "마스터키가 바뀌어 기존 비밀번호는 복구할 수 없습니다.\n\n"
            "설정 탭에서 아래 계정의 비밀번호를 다시 입력한 뒤 "
            "'저장 및 적용'을 눌러 주세요.\n\n"
            f"대상 계정: {names}",
        )

    def _show_keychain_warning(self):
        QMessageBox.warning(
            self,
            "키체인 접근 오류",
            "macOS 키체인 접근이 거부되어 저장된 비밀번호를 불러올 수 없습니다.\n\n"
            "계정 목록은 표시되지만 비밀번호가 없어 자동 조회는 동작하지 않습니다. "
            "저장된 비밀번호는 삭제되지 않았으며, 키체인 접근을 허용한 뒤 "
            "앱을 다시 실행하면 복구됩니다.\n\n"
            f"상세: {self.config_store.keychain_error}",
        )

    def _setup_shortcuts(self):
        refresh_shortcut = QShortcut(QKeySequence(Qt.Key.Key_F5), self)
        refresh_shortcut.activated.connect(self.refresh_status)
        tab1_shortcut = QShortcut(QKeySequence("Ctrl+1"), self)
        tab1_shortcut.activated.connect(lambda: self.tabs.setCurrentIndex(0))
        tab2_shortcut = QShortcut(QKeySequence("Ctrl+2"), self)
        tab2_shortcut.activated.connect(lambda: self.tabs.setCurrentIndex(1))
        tab3_shortcut = QShortcut(QKeySequence("Ctrl+3"), self)
        tab3_shortcut.activated.connect(lambda: self.tabs.setCurrentIndex(2))

    def _normalize_users(self, users: list[dict]) -> list[dict]:
        normalized = []
        seen = set()
        for user in reversed(users or []):
            user_id = (user.get("userId") or user.get("label") or "").strip()
            if not user_id or user_id in seen:
                continue
            seen.add(user_id)
            normalized.append({"userId": user_id, "password": user.get("password", "")})
        return list(reversed(normalized))

    def _build_status_tab(self) -> QWidget:
        page = QWidget()
        page.setObjectName("StatusPage")
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(12)

        header_row = self._build_header_row()
        layout.addLayout(header_row)

        self.summary_bar = SummaryBar()
        self.summary_bar.tierClicked.connect(self._on_summary_clicked)
        layout.addWidget(self.summary_bar)

        filter_row = QHBoxLayout()
        filter_row.setSpacing(8)
        self.user_filter_bar = UserFilterBar()
        self.user_filter_bar.selectionChanged.connect(self._rerender_status)
        filter_row.addWidget(self.user_filter_bar, 1)
        sort_label = QLabel("정렬")
        self.sort_combo = QComboBox()
        self.sort_combo.addItems(["반납일", "이름", "도서관"])
        idx = self.sort_combo.findText(self._initial_sort_key)
        self.sort_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.sort_combo.currentTextChanged.connect(self._rerender_status)
        filter_row.addWidget(sort_label)
        filter_row.addWidget(self.sort_combo)
        self.interlibrary_only = QCheckBox("상호대차만")
        self.interlibrary_only.setChecked(self._initial_inter_only)
        self.interlibrary_only.stateChanged.connect(self._rerender_status)
        filter_row.addWidget(self.interlibrary_only)
        layout.addLayout(filter_row)

        self.card_scroll, self.card_container, self.card_layout = self._build_card_area()
        layout.addWidget(self.card_scroll, 1)

        self.empty_state, self.empty_message, self.clear_filters_button = self._build_empty_state(
            self._clear_all_filters
        )
        layout.addWidget(self.empty_state)

        return page

    def _build_header_row(self):
        """탭마다 자기 헤더를 갖되 갱신 시각과 새로고침은 모든 탭이 함께 움직인다."""
        row = QHBoxLayout()
        label = QLabel("최근 업데이트: -")
        label.setObjectName("LastUpdatedLabel")
        row.addWidget(label)
        row.addStretch(1)
        button = QPushButton("↻  새로고침")
        button.setObjectName("RefreshButton")
        button.setCursor(Qt.CursorShape.PointingHandCursor)
        button.clicked.connect(self.refresh_status)
        row.addWidget(button)
        self._last_updated_labels.append(label)
        self._refresh_buttons.append(button)
        return row

    def _set_last_updated(self, text: str):
        for label in self._last_updated_labels:
            label.setText(text)

    def _set_refresh_enabled(self, enabled: bool):
        for button in self._refresh_buttons:
            button.setEnabled(enabled)

    def _build_card_area(self):
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setObjectName("CardScroll")
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        container = QWidget()
        container.setObjectName("CardContainer")
        card_layout = FlowLayout(container, margin=0, spacing=12)
        scroll.setWidget(container)
        return scroll, container, card_layout

    def _build_empty_state(self, on_clear):
        widget = QWidget()
        widget.setObjectName("EmptyState")
        es_layout = QVBoxLayout(widget)
        es_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        es_layout.setSpacing(10)
        message = QLabel("")
        message.setAlignment(Qt.AlignmentFlag.AlignCenter)
        message.setObjectName("EmptyMessage")
        es_layout.addWidget(message)
        button = QPushButton("필터 해제")
        button.setObjectName("ClearFiltersButton")
        button.setCursor(Qt.CursorShape.PointingHandCursor)
        button.clicked.connect(on_clear)
        button.hide()
        es_layout.addWidget(button, 0, Qt.AlignmentFlag.AlignCenter)
        widget.hide()
        return widget, message, button

    def _build_reservation_tab(self) -> QWidget:
        page = QWidget()
        page.setObjectName("ReservationPage")
        layout = QVBoxLayout(page)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(12)

        layout.addLayout(self._build_header_row())

        filter_row = QHBoxLayout()
        filter_row.setSpacing(8)
        self.reservation_user_filter = UserFilterBar()
        self.reservation_user_filter.selectionChanged.connect(self._rerender_reservations)
        filter_row.addWidget(self.reservation_user_filter, 1)
        filter_row.addWidget(QLabel("정렬"))
        self.reservation_sort_combo = QComboBox()
        self.reservation_sort_combo.addItems(["책별", "예약순번", "예약일", "도서관"])
        idx = self.reservation_sort_combo.findText(self._initial_reservation_sort_key)
        self.reservation_sort_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self.reservation_sort_combo.currentTextChanged.connect(self._rerender_reservations)
        filter_row.addWidget(self.reservation_sort_combo)
        layout.addLayout(filter_row)

        self.reservation_scroll, self.reservation_container, self.reservation_layout = self._build_card_area()
        layout.addWidget(self.reservation_scroll, 1)

        self.reservation_empty_state, self.reservation_empty_message, self.reservation_clear_button = (
            self._build_empty_state(self._clear_reservation_filters)
        )
        layout.addWidget(self.reservation_empty_state)

        return page

    def _build_settings_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        form = QFormLayout()
        self.field_inputs = {}

        for key in self.ENV_FIELDS:
            input_box = QLineEdit()
            if "PASSWORD" in key or "KEY" in key:
                input_box.setEchoMode(QLineEdit.EchoMode.Password)
            input_box.setText(self.env_data.get(key, ""))
            self.field_inputs[key] = input_box
            form.addRow(QLabel(key), input_box)

        self.auto_refresh_combo = QComboBox()
        self.auto_refresh_combo.addItems([
            "비활성화",
            "5분마다",
            "10분마다",
            "30분마다",
            "1시간마다"
        ])
        self.auto_refresh_combo.setMinimumWidth(150)
        interval_to_index = {0: 0, 5: 1, 10: 2, 30: 3, 60: 4}
        self.auto_refresh_combo.setCurrentIndex(interval_to_index.get(self.auto_refresh_interval, 0))
        form.addRow("자동 새로고침", self.auto_refresh_combo)

        self.dark_mode_checkbox = QCheckBox("다크모드 사용")
        self.dark_mode_checkbox.setChecked(self.dark_mode)
        form.addRow("테마", self.dark_mode_checkbox)

        layout.addLayout(form)

        layout.addWidget(QLabel("사용자 목록"))
        self.users_list = QListWidget()
        self.users_list.itemSelectionChanged.connect(self._on_user_selected)
        layout.addWidget(self.users_list)

        user_form = QFormLayout()
        self.user_id_input = QLineEdit()
        self.user_pw_input = QLineEdit()
        self.user_pw_input.setEchoMode(QLineEdit.EchoMode.Password)

        pw_layout = QHBoxLayout()
        pw_layout.addWidget(self.user_pw_input)
        self.pw_toggle_btn = QPushButton("👁")
        self.pw_toggle_btn.setCheckable(True)
        self.pw_toggle_btn.setMaximumWidth(40)
        self.pw_toggle_btn.setToolTip("비밀번호 표시/숨김")
        self.pw_toggle_btn.toggled.connect(self._toggle_password_visibility)
        pw_layout.addWidget(self.pw_toggle_btn)

        user_form.addRow("회원번호", self.user_id_input)
        user_form.addRow("비밀번호", pw_layout)
        layout.addLayout(user_form)

        user_btns = QHBoxLayout()
        new_btn = QPushButton("새로 만들기")
        new_btn.clicked.connect(self._clear_user_inputs)
        add_btn = QPushButton("추가 / 수정")
        add_btn.clicked.connect(self._add_or_update_user)
        del_btn = QPushButton("삭제")
        del_btn.clicked.connect(self._delete_user)
        user_btns.addWidget(new_btn)
        user_btns.addWidget(add_btn)
        user_btns.addWidget(del_btn)
        layout.addLayout(user_btns)

        button_row = QHBoxLayout()
        save_button = QPushButton("저장 및 적용")
        save_button.clicked.connect(self.save_settings)
        button_row.addWidget(save_button)
        layout.addLayout(button_row)

        self._refresh_users_list()
        return page

    @asyncSlot()
    async def refresh_status(self):
        if not self.users:
            return
        self._set_refresh_enabled(False)
        self._clear_cards()
        self._clear_reservation_cards()
        self.summary_bar.update_counts(0, 0, 0, 0)
        self.empty_message.setText("📚  불러오는 중...")
        self.clear_filters_button.hide()
        self.empty_state.show()
        self.reservation_empty_message.setText("📚  불러오는 중...")
        self.reservation_clear_button.hide()
        self.reservation_empty_state.show()
        self._set_last_updated("최근 업데이트: 업데이트 중...")
        try:
            infos = await get_infos_async(self.users)
            self.last_infos = infos
            self._populate_cards(infos)
            self._populate_reservations(infos)
            failed = [info for info in infos if info.get("error")]
            if failed and len(failed) == len(infos):
                # 계정마다 같은 원인이면 한 줄로 접힌다. "네트워크 또는 인증" 같은
                # 뭉뚱그린 안내 대신 실제 원인(잘못된 비밀번호 등)을 그대로 보여준다.
                reasons = sorted({str(info["error"]) for info in failed})
                self._show_error("모든 계정의 상태 조회에 실패했습니다.\n\n" + "\n".join(reasons))
                self._set_last_updated("최근 업데이트: 실패")
            else:
                if failed:
                    names = ", ".join(info["name"] for info in failed)
                    self._set_last_updated(
                        f"최근 업데이트: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} (일부 실패: {names})"
                    )
                else:
                    self._set_last_updated(
                        f"최근 업데이트: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
        except Exception as exc:  # noqa: BLE001
            self._show_error(f"상태 조회 실패: {exc}")
            self._set_last_updated("최근 업데이트: 실패")
            self._restore_after_failed_refresh()
        finally:
            self._set_refresh_enabled(True)

    def _restore_after_failed_refresh(self):
        """예외로 조회가 끊겼을 때 두 탭을 "불러오는 중" 상태로 남기지 않는다.

        직전 데이터가 있으면 그것을 다시 그린다. 헤더가 "실패"라고 말하고 있으니
        낡은 데이터임은 드러나고, 나중에 정렬을 건드렸을 때 카드가 아무 설명 없이
        되살아나는 일도 없어진다.
        """
        if self.last_infos:
            self._populate_cards(self.last_infos)
            self._populate_reservations(self.last_infos)
            return
        for message, button, state in (
            (self.empty_message, self.clear_filters_button, self.empty_state),
            (self.reservation_empty_message, self.reservation_clear_button, self.reservation_empty_state),
        ):
            message.setText("⚠️  조회에 실패했습니다")
            button.hide()
            state.show()

    def _rerender_status(self):
        if not self._suppress_state_save:
            self._save_ui_state()
        if self.last_infos:
            self._populate_cards(self.last_infos)

    def _clear_cards(self):
        self._clear_layout(self.card_layout)

    def _clear_reservation_cards(self):
        self._clear_layout(self.reservation_layout)

    @staticmethod
    def _clear_layout(card_layout):
        while card_layout.count():
            item = card_layout.takeAt(0)
            if item and item.widget():
                item.widget().deleteLater()

    def _populate_cards(self, infos):
        self._clear_cards()

        user_counts = [
            (
                entry.get("name", "?"),
                len(entry.get("books", [])),
                sum(1 for b in entry.get("books", []) if b.get("is_interlibrary")),
            )
            for entry in (infos or [])
        ]

        self._suppress_state_save = True
        self.user_filter_bar.set_users(user_counts)
        if self._pending_user_selection is not None:
            self.user_filter_bar.set_selection(self._pending_user_selection)
            self._pending_user_selection = None
        self._suppress_state_save = False

        urgent = approaching = waiting = total = 0
        for entry in (infos or []):
            for book in entry.get("books", []):
                tier, _ = compute_book_status(book)
                total += 1
                if tier == "urgent":
                    urgent += 1
                elif tier == "approaching":
                    approaching += 1
                elif tier == "waiting":
                    waiting += 1
        self.summary_bar.update_counts(urgent, approaching, waiting, total)
        self.summary_bar.set_checked_tier(self.tier_filter)

        pairs = self._flatten_and_sort(infos)

        has_active_filter = (
            self.interlibrary_only.isChecked()
            or self.user_filter_bar.current_user() is not None
            or self.tier_filter is not None
        )

        if not pairs:
            if _all_failed(infos):
                self.empty_message.setText("⚠️  조회에 실패했습니다")
                self.clear_filters_button.hide()
            elif total > 0 and has_active_filter:
                self.empty_message.setText("🔍  이 조건에 해당하는 도서가 없습니다")
                self.clear_filters_button.show()
            else:
                self.empty_message.setText("📭  대출 중인 도서가 없습니다")
                self.clear_filters_button.hide()
            self.empty_state.show()
            return
        self.empty_state.hide()

        with_shadow = not self.dark_mode
        for user_name, book in pairs:
            card = BookCard(book, user_name, with_shadow=with_shadow)
            card.clicked.connect(self._show_book_detail_dialog)
            self.card_layout.addWidget(card)

    def _flatten_and_sort(self, infos):
        pairs = []
        inter_only = self.interlibrary_only.isChecked()
        selected_user = self.user_filter_bar.current_user()
        tier_filter = self.tier_filter
        for entry in (infos or []):
            user_name = entry.get("name", "?")
            if selected_user and user_name != selected_user:
                continue
            for book in entry.get("books", []):
                if inter_only and not book.get("is_interlibrary"):
                    continue
                if tier_filter:
                    tier, _ = compute_book_status(book)
                    if tier != tier_filter:
                        continue
                pairs.append((user_name, book))

        sort_key = self.sort_combo.currentText()

        def parse_due(due_str: str):
            try:
                return datetime.strptime(due_str, "%Y.%m.%d")
            except Exception:
                return datetime.max

        if sort_key == "반납일":
            pairs.sort(key=lambda p: parse_due(p[1].get("due_date", "")))
        elif sort_key == "도서관":
            pairs.sort(key=lambda p: (p[1].get("library") or p[1].get("receiving_library") or "").strip())
        else:
            pairs.sort(key=lambda p: (p[1].get("title") or "").strip())
        return pairs

    def _rerender_reservations(self):
        if not self._suppress_state_save:
            self._save_ui_state()
        if self.last_infos:
            self._populate_reservations(self.last_infos)

    def _populate_reservations(self, infos):
        self._clear_reservation_cards()

        user_counts = [
            (entry.get("name", "?"), len(entry.get("reservations", [])))
            for entry in (infos or [])
        ]

        self._suppress_state_save = True
        self.reservation_user_filter.set_users(user_counts)
        if self._pending_reservation_user_selection is not None:
            self.reservation_user_filter.set_selection(self._pending_reservation_user_selection)
            self._pending_reservation_user_selection = None
        self._suppress_state_save = False

        total = sum(count for _, count in user_counts)
        pickup = sum(
            1
            for entry in (infos or [])
            for reservation in entry.get("reservations", [])
            if is_ready_for_pickup(reservation)
        )
        self._update_reservation_tab_label(total, pickup)

        rows = self._flatten_and_sort_reservations(infos)

        if not rows:
            if _all_failed(infos):
                self.reservation_empty_message.setText("⚠️  조회에 실패했습니다")
                self.reservation_clear_button.hide()
            elif total > 0:
                self.reservation_empty_message.setText("🔍  이 조건에 해당하는 예약이 없습니다")
                self.reservation_clear_button.show()
            else:
                self.reservation_empty_message.setText("📭  예약 중인 도서가 없습니다")
                self.reservation_clear_button.hide()
            self.reservation_empty_state.show()
            return
        self.reservation_empty_state.hide()

        with_shadow = not self.dark_mode
        for user_name, reservation, group_size in rows:
            card = ReservationCard(reservation, user_name, group_size=group_size, with_shadow=with_shadow)
            card.clicked.connect(self._show_reservation_detail_dialog)
            self.reservation_layout.addWidget(card)

    def _flatten_and_sort_reservations(self, infos):
        selected_user = self.reservation_user_filter.current_user()
        rows = []
        for entry in (infos or []):
            user_name = entry.get("name", "?")
            if selected_user and user_name != selected_user:
                continue
            for reservation in entry.get("reservations", []):
                # 그룹은 (사용자, 제목)이다. 서로 다른 사람이 같은 책을 걸어둔 건
                # 한 묶음이 아니고, 사용자별로 묶으면 사용자 필터를 바꿔도
                # 카드의 "같은 책 N곳"이 흔들리지 않는다.
                key = (user_name, group_key(reservation.get("title", "")))
                rows.append((user_name, reservation, key))

        # N곳은 예약 건수가 아니라 서로 다른 도서관 수다. 한 도서관에 두 건이
        # 잡혀 있어도 "2곳"이라고 말하면 안 된다.
        group_libraries = defaultdict(set)
        best_rank = {}
        group_expiry = {}
        for _, reservation, key in rows:
            group_libraries[key].add(reservation.get("library") or "")
            best_rank[key] = min(best_rank.get(key, 999), reservation.get("rank") or 999)
            if is_ready_for_pickup(reservation):
                expiry = reservation.get("expiry_date") or ""
                group_expiry[key] = min(group_expiry.get(key, expiry), expiry)
        group_sizes = {key: len(libraries) for key, libraries in group_libraries.items()}

        sort_key = self.reservation_sort_combo.currentText()
        if sort_key == "책별":
            # 그룹을 통째로 세운다. 수령 대기 건만 뽑아 올리면 같은 책 카드가
            # 그리드 양끝으로 찢어지면서 양쪽 다 "같은 책 N곳"을 주장한다.
            rows.sort(key=lambda row: (
                row[2] not in group_expiry,          # 수령 대기가 있는 책부터
                group_expiry.get(row[2], ""),        # 그 중 만기가 임박한 책부터
                best_rank[row[2]],                   # 그다음은 대출 가능에 가까운 책
                row[2],
                not is_ready_for_pickup(row[1]),     # 그룹 안에서는 수령 대기가 먼저
                row[1].get("rank") or 999,
            ))
            return [(user_name, r, group_sizes[key]) for user_name, r, key in rows]

        if sort_key == "예약순번":
            rows.sort(key=lambda row: (row[1].get("rank") or 999, row[2]))
        elif sort_key == "예약일":
            rows.sort(key=lambda row: (row[1].get("reserved_date") or "9999.99.99", row[2]))
        elif sort_key == "도서관":
            rows.sort(key=lambda row: ((row[1].get("library") or "").strip(), row[2]))

        # 책별이 아닌 정렬에서는 묶음이 없으니 수령 대기 건을 개별로 끌어올린다.
        # 만기가 이미 지난 건이 D-35보다 뒤에 오지 않도록 만기일 순으로.
        rows.sort(key=lambda row: (
            not is_ready_for_pickup(row[1]),
            row[1].get("expiry_date") or "",
        ))

        return [(user_name, r, group_sizes[key]) for user_name, r, key in rows]

    def _update_reservation_tab_label(self, total: int, pickup: int):
        if pickup:
            label = f"예약 현황 ({total} · 수령 {pickup})"
        elif total:
            label = f"예약 현황 ({total})"
        else:
            label = "예약 현황"
        index = self.tabs.indexOf(self.reservation_tab)
        if index >= 0:
            self.tabs.setTabText(index, label)

    def _clear_reservation_filters(self):
        self._suppress_state_save = True
        self.reservation_user_filter.set_selection(None)
        self._suppress_state_save = False
        self._save_ui_state()
        if self.last_infos:
            self._populate_reservations(self.last_infos)

    def _show_reservation_detail_dialog(self, reservation: dict):
        dialog = QDialog(self)
        dialog.setWindowTitle("예약 상세 정보")
        dialog.resize(500, 400)
        layout = QVBoxLayout(dialog)
        form = QFormLayout()
        _, badge = compute_reservation_status(reservation)
        rank = reservation.get("rank") or 0
        waiting = reservation.get("waiting_count") or 0
        fields = [
            ("제목", reservation.get("title", "")),
            ("상태", badge),
            ("도서관", reservation.get("library", "") or "-"),
            ("자료실", reservation.get("room", "") or "-"),
            ("예약일", reservation.get("reserved_date", "") or "-"),
            ("예약순번", f"{rank}번째 / {waiting}명 예약" if rank else "-"),
            ("도서현황", reservation.get("book_status", "") or "-"),
            ("반납예정일", reservation.get("due_date", "") or "-"),
        ]
        if reservation.get("expiry_date"):
            fields.append(("예약만기일", reservation["expiry_date"]))
        for label, value in fields:
            value_label = QLabel(str(value))
            value_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            value_label.setWordWrap(True)
            form.addRow(f"{label}:", value_label)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)
        dialog.exec()

    def _on_summary_clicked(self, tier: str):
        if tier == "total" or self.tier_filter == tier:
            new_filter = None
        else:
            new_filter = tier
        self.tier_filter = new_filter
        self.summary_bar.set_checked_tier(new_filter)
        self._save_ui_state()
        if self.last_infos:
            self._populate_cards(self.last_infos)

    def _clear_all_filters(self):
        self._suppress_state_save = True
        self.interlibrary_only.setChecked(False)
        self.user_filter_bar.set_selection(None)
        self.tier_filter = None
        self.summary_bar.set_checked_tier(None)
        self._suppress_state_save = False
        self._save_ui_state()
        if self.last_infos:
            self._populate_cards(self.last_infos)

    @staticmethod
    def _selection_to_save(filter_bar, saved):
        """첫 조회가 끝나기 전에는 저장된 선택을 지우지 않는다.

        칩이 만들어지기 전 current_user()는 항상 None인데, 그때 저장하면
        (예: 조회 중에 정렬을 바꾸거나 설정을 저장하면) 기억해둔 사용자 선택이
        None으로 덮어써진다.
        """
        return filter_bar.current_user() if filter_bar.has_users() else saved

    def _current_ui_state(self) -> dict:
        return {
            "sort_key": self.sort_combo.currentText(),
            "interlibrary_only": self.interlibrary_only.isChecked(),
            "selected_user": self._selection_to_save(self.user_filter_bar, self._saved_user_selection),
            "tier_filter": self.tier_filter,
            "reservation_sort_key": self.reservation_sort_combo.currentText(),
            "reservation_selected_user": self._selection_to_save(
                self.reservation_user_filter, self._saved_reservation_user_selection
            ),
        }

    def _save_ui_state(self):
        ui_state = self._current_ui_state()
        self.config_store.save(
            self.env_data,
            self.users,
            self.auto_refresh_interval,
            self.dark_mode,
            ui_state=ui_state,
        )

    def _show_book_detail_dialog(self, book: dict):
        dialog = QDialog(self)
        dialog.setWindowTitle("도서 상세 정보")
        dialog.resize(500, 400)
        layout = QVBoxLayout(dialog)
        form = QFormLayout()
        fields = [
            ("제목", book.get("title", "")),
            ("도서관", book.get("library") or book.get("receiving_library", "")),
            ("반납일", book.get("due_date", "")),
            ("상호대차", "예" if book.get("is_interlibrary") else "아니오"),
        ]
        if book.get("providing_library"):
            fields.insert(2, ("제공도서관", book["providing_library"]))
        for label, value in fields:
            value_label = QLabel(str(value))
            value_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            value_label.setWordWrap(True)
            form.addRow(f"{label}:", value_label)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)
        dialog.exec()

    def save_settings(self):
        self.env_data = {k: field.text().strip() for k, field in self.field_inputs.items() if field.text().strip()}
        index_to_interval = {0: 0, 1: 5, 2: 10, 3: 30, 4: 60}
        self.auto_refresh_interval = index_to_interval.get(self.auto_refresh_combo.currentIndex(), 0)
        old_dark_mode = self.dark_mode
        self.dark_mode = self.dark_mode_checkbox.isChecked()
        ui_state = self._current_ui_state()
        self.config_store.save(
            self.env_data,
            self.users,
            self.auto_refresh_interval,
            self.dark_mode,
            ui_state=ui_state,
        )
        self.config_store.apply_env({"env": self.env_data})
        self._start_auto_refresh_timer()
        self._apply_theme()
        if old_dark_mode != self.dark_mode and self.last_infos:
            self._populate_cards(self.last_infos)
            self._populate_reservations(self.last_infos)
        if self.config_store.keychain_error:
            QMessageBox.warning(
                self,
                "설정",
                "설정을 저장했지만 키체인 접근이 거부되어 비밀번호를 암호화하지 못했습니다.\n"
                "기존에 저장된 비밀번호는 그대로 유지되며, 새로 입력한 비밀번호는 "
                "키체인 접근을 허용하고 앱을 다시 실행한 뒤 다시 저장해야 합니다.\n\n"
                f"상세: {self.config_store.keychain_error}",
            )
        else:
            QMessageBox.information(self, "설정", "환경 변수와 사용자 정보가 저장되었습니다.")

    def _show_error(self, message: str):
        QMessageBox.critical(self, "오류", message)

    def _refresh_users_list(self):
        self.users_list.clear()
        for user in self.users:
            user_id = user.get("userId", "")
            self.users_list.addItem(user_id)

    def _on_user_selected(self):
        items = self.users_list.selectedIndexes()
        if not items:
            return
        idx = items[0].row()
        user = self.users[idx]
        self.user_id_input.setText(user.get("userId", ""))
        self.user_pw_input.setText(user.get("password", ""))

    def _add_or_update_user(self):
        user_id = self.user_id_input.text().strip()
        password = self.user_pw_input.text().strip()
        if not (user_id and password):
            self._show_error("회원번호와 비밀번호를 모두 입력해주세요.")
            return
        existing = next((u for u in self.users if u.get("userId") == user_id), None)
        if existing:
            existing.update({"userId": user_id, "password": password})
        else:
            self.users.append({"userId": user_id, "password": password})
        self._refresh_users_list()
        self._clear_user_inputs()
        if self.config_store.keychain_error:
            QMessageBox.warning(
                self,
                "키체인 접근 오류",
                "키체인 접근이 거부된 상태라 지금 입력한 비밀번호를 암호화해 "
                "저장할 수 없습니다.\n이번 실행 중에는 사용할 수 있지만 앱을 "
                "종료하면 사라집니다. 키체인 접근을 허용한 뒤 앱을 다시 실행해 "
                "다시 등록해 주세요.",
            )

    def _clear_user_inputs(self):
        self.user_id_input.clear()
        self.user_pw_input.clear()
        self.users_list.clearSelection()
        self.user_id_input.setFocus()

    def _delete_user(self):
        items = self.users_list.selectedIndexes()
        if not items:
            return
        idx = items[0].row()
        self.users.pop(idx)
        self._refresh_users_list()

    def _toggle_password_visibility(self, checked: bool):
        if checked:
            self.user_pw_input.setEchoMode(QLineEdit.EchoMode.Normal)
            self.pw_toggle_btn.setText("🙈")
        else:
            self.user_pw_input.setEchoMode(QLineEdit.EchoMode.Password)
            self.pw_toggle_btn.setText("👁")

    def _start_auto_refresh_timer(self):
        if self.auto_refresh_timer:
            self.auto_refresh_timer.stop()
            self.auto_refresh_timer = None
        if self.auto_refresh_interval > 0 and any(u.get("password") for u in self.users):
            self.auto_refresh_timer = QTimer(self)
            self.auto_refresh_timer.timeout.connect(self.refresh_status)
            self.auto_refresh_timer.start(self.auto_refresh_interval * 60 * 1000)

    def _apply_theme(self):
        app = QApplication.instance()
        if not app:
            return
        body = DARK_STYLESHEET if self.dark_mode else LIGHT_STYLESHEET
        app.setStyleSheet(build_font_rule() + body)

    def closeEvent(self, event):
        # 트레이 상주 없이 일반 앱처럼 종료한다.
        event.accept()
