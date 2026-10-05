import json
from datetime import datetime

import pytest

from songpa_cli import app
from songpa_cli.accounts import AccountStore
from songpa_cli.html_view import render_html, write_html
from songpa_cli.notify import build_notification
from songpa_cli.report import build_report, short_name
from songpa_cli.text import render_text

NOW = datetime(2026, 10, 5, 9, 30)
CREDENTIALS = [
    {"label": "홍길동", "userId": "hong", "password": "pw"},
    {"label": "김영희", "userId": "kim", "password": "pw"},
]
INFOS = [
    {
        "name": "홍길동",
        "books": [
            {"title": "어린 왕자", "due_date": "2026.10.20", "is_interlibrary": False, "library": "거마"},
            {"title": "데미안", "due_date": "2026.10.03", "is_interlibrary": True,
             "library": "잠실", "providing_library": "돌마리"},
            {"title": "<노인과 바다>", "due_date": "발송", "is_interlibrary": True,
             "library": "거마", "providing_library": "위례"},
            {"title": "변신", "due_date": "입수", "is_interlibrary": True,
             "library": "거마", "providing_library": "글마루"},
            {"title": "동물농장", "due_date": "2026.10.07", "is_interlibrary": False, "library": "거마"},
        ],
        "reservations": [
            {"title": "1984", "library": "잠실", "rank": 0, "expiry_date": "2026.10.08"},
            {"title": "이방인", "library": "거마", "rank": 3, "expiry_date": ""},
        ],
    },
    {"name": "kim", "books": [], "reservations": [], "error": "회원번호 또는 비밀번호가 올바르지 않습니다."},
]


@pytest.fixture
def report():
    return build_report(CREDENTIALS, INFOS, now=NOW)


def test_books_are_normalized_and_sorted_pickup_loans_transit(report):
    books = report["accounts"][0]["books"]

    assert [(b["title"], b["status"], b["days_left"]) for b in books] == [
        ("변신", "ready_for_pickup", None),
        ("데미안", "loaned", -2),
        ("동물농장", "loaned", 2),
        ("어린 왕자", "loaned", 15),
        ("<노인과 바다>", "in_transit", None),
    ]
    transit = books[-1]
    assert transit["due_date"] is None and transit["transit_status"] == "발송"


def test_counts_match_the_desktop_and_widget(report):
    first, second = report["accounts"]
    assert (first["book_count"], first["interlibrary_count"], first["ready_for_pickup_count"]) == (5, 3, 2)
    assert second["error"] and second["name"] is None and second["books"] == []


def test_text_summary_shows_urgency_and_errors(report):
    text = render_text(report, due_soon=3)

    assert "2개 계정 · 총 5권 (상호대차 3) · 찾아올 책 2" in text
    assert "연체 2일" in text and "D-2" in text and "픽업필요" in text and "이동중" in text
    assert "위례 → 거마 (발송)" in text
    assert "수령대기 ~2026.10.08" in text and "3순위" in text
    assert "조회 실패: 회원번호 또는 비밀번호가 올바르지 않습니다." in text
    assert "\033[" not in text
    assert "\033[" in render_text(report, color=True)


def test_html_escapes_titles_and_follows_dark_mode(report):
    page = render_html(report)

    assert "&lt;노인과 바다&gt;" in page and "<노인과 바다>" not in page
    assert "prefers-color-scheme: dark" in page
    assert '<span class="tab-count">5</span><span class="tab-inter">(3)</span>' in page
    assert "⚠️ 조회 실패" in page


def test_html_file_is_private(tmp_path, report):
    path = write_html(report, 3, tmp_path / "out" / "latest.html")

    assert path.read_text(encoding="utf-8").startswith("<!DOCTYPE html>")
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_notification_lists_pickups_and_due_books(report):
    title, content, priority = build_notification(report, due_soon=3)

    assert title == "송파도서관: 찾아올 책 2 · 반납 임박 2"
    assert priority == "high"
    assert "홍길동: 변신 (상호대차 도착 · 거마)" in content
    assert "홍길동: 1984 (예약 도착 · 잠실, ~2026.10.08)" in content
    assert "홍길동: 데미안 (연체 2일, 2026.10.03)" in content
    assert "대출 5권: 길동 5 / 영희 0" in content
    assert "⚠️ 조회 실패: 김영희" in content


def test_short_name_only_trims_three_letter_korean_names():
    assert short_name("홍길동") == "길동"
    assert short_name("엄마") == "엄마"
    assert short_name("Tom") == "Tom"


def _run(monkeypatch, tmp_path, capsys, argv):
    store = AccountStore(tmp_path, use_keyring=False)
    for c in CREDENTIALS:
        store.add(c["label"], c["userId"], c["password"])
    monkeypatch.setattr(app, "AccountStore", lambda: store)
    seen = {}

    def fake_fetch(credentials):
        seen["ids"] = [c["userId"] for c in credentials]
        return build_report(credentials, INFOS[: len(credentials)], now=NOW)

    monkeypatch.setattr(app, "fetch_report", fake_fetch)
    with pytest.raises(SystemExit) as exc:
        app.main(argv)
    return exc.value.code, capsys.readouterr(), seen


def test_json_output_and_exit_code_reports_a_failed_account(monkeypatch, tmp_path, capsys):
    code, out, _ = _run(monkeypatch, tmp_path, capsys, ["--json"])

    data = json.loads(out.out)
    assert [a["label"] for a in data["accounts"]] == ["홍길동", "김영희"]
    assert code == app.EXIT_FETCH_FAILED
    assert "pw" not in out.out


def test_user_filter_only_fetches_that_account(monkeypatch, tmp_path, capsys):
    code, _, seen = _run(monkeypatch, tmp_path, capsys, ["-u", "홍길동", "--no-color"])

    assert seen["ids"] == ["hong"]
    assert code == app.EXIT_OK


def test_no_accounts_points_to_accounts_add(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(app, "AccountStore", lambda: AccountStore(tmp_path, use_keyring=False))

    with pytest.raises(SystemExit) as exc:
        app.main([])

    assert exc.value.code == app.EXIT_USAGE
    assert "songpa accounts add" in capsys.readouterr().err


def test_accounts_add_with_password_stdin_then_list(monkeypatch, tmp_path, capsys):
    store = AccountStore(tmp_path, use_keyring=False)
    monkeypatch.setattr(app, "AccountStore", lambda: store)
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("secret\n"))

    with pytest.raises(SystemExit) as exc:
        app.main(["accounts", "add", "--label", "홍길동", "--id", "hong", "--password-stdin"])
    assert exc.value.code == 0
    assert store.credentials()[0]["password"] == "secret"

    with pytest.raises(SystemExit):
        app.main(["accounts", "list"])
    listed = capsys.readouterr().out
    assert "홍길동\thong\t(비밀번호: 파일)" in listed and "secret" not in listed
