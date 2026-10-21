from datetime import datetime

from songpa_cli import app
from songpa_cli.plan import build_plan, format_plan_text, library_display, short_title
from songpa_cli.report import build_report

NOW = datetime(2026, 10, 5, 9, 30)
CREDENTIALS = [
    {"label": "홍길동", "userId": "hong", "password": "pw"},
    {"label": "김영희", "userId": "kim", "password": "pw"},
    {"label": "이철수", "userId": "lee", "password": "pw"},
]
INFOS = [
    {
        "name": "홍길동",
        "books": [
            {"title": "어린 왕자", "due_date": "2026.10.20", "is_interlibrary": False, "library": "거마"},
            {"title": "데미안", "due_date": "2026.10.03", "is_interlibrary": False, "library": "거마"},
            {"title": "(세계문학)변신", "due_date": "입수", "is_interlibrary": True,
             "library": "거마", "providing_library": "글마루"},
            {"title": "노인과 바다", "due_date": "발송", "is_interlibrary": True,
             "library": "스마트", "providing_library": "위례"},
        ],
        "reservations": [
            {"title": "1984", "library": "거마", "rank": 0, "expiry_date": "2026.10.08"},
            {"title": "이방인", "library": "거마", "rank": 3, "expiry_date": ""},
        ],
    },
    {
        "name": "김영희",
        "books": [
            {"title": "동물농장 : 어떤 동화", "due_date": "2026.10.07", "is_interlibrary": True,
             "library": "스마트", "providing_library": "돌마리"},
            {"title": "멋진 신세계", "due_date": "2026.10.06", "is_interlibrary": False, "library": "스마트"},
            {"title": "파우스트", "due_date": "2026.10.30", "is_interlibrary": False, "library": "잠실"},
            {"title": "햄릿", "due_date": "알수없음", "is_interlibrary": False, "library": "잠실"},
        ],
        "reservations": [
            {"title": "페스트", "library": "잠실", "rank": 0, "expiry_date": "2026.10.06"},
        ],
    },
    {"name": "lee", "books": [], "reservations": [], "error": "회원번호 또는 비밀번호가 올바르지 않습니다."},
]


def _plan():
    return build_plan(build_report(CREDENTIALS, INFOS, now=NOW))


def _titles(items):
    return [item["title"] for item in items]


def test_libraries_are_ordered_by_the_most_urgent_errand():
    # 잠실: 반납일 못 읽은 책, 거마: 연체, 스마트: D-1
    assert [sec["library"] for sec in _plan()["libraries"]] == ["잠실", "거마", "스마트"]


def test_returns_are_grouped_by_library_overdue_first():
    by_lib = {sec["library"]: sec for sec in _plan()["libraries"]}

    assert _titles(by_lib["거마"]["returns"]) == ["데미안", "어린 왕자"]
    assert by_lib["거마"]["returns"][0]["notes"] == ["연체 2일"]
    assert _titles(by_lib["스마트"]["returns"]) == ["멋진 신세계", "동물농장"]
    assert _titles(by_lib["잠실"]["returns"]) == ["햄릿", "파우스트"]


def test_pickups_include_arrived_interlibrary_and_ready_reservations_by_deadline():
    by_lib = {sec["library"]: sec for sec in _plan()["libraries"]}

    gema = by_lib["거마"]["pickups"]
    assert [(i["title"], i["notes"]) for i in gema] == [
        ("1984", ["예약도서", "10/8까지"]),
        ("변신", ["상호대차"]),
    ]
    assert "이방인" not in _titles(gema)
    assert _titles(by_lib["잠실"]["pickups"]) == ["페스트"]
    assert by_lib["스마트"]["pickups"] == []


def test_in_transit_books_are_listed_separately_not_as_pickups():
    plan = _plan()

    assert [(i["title"], i["notes"]) for i in plan["in_transit"]] == [("노인과 바다", ["위례→스마트", "발송"])]


def test_ambiguous_returns_and_unknown_due_dates_need_a_check():
    by_lib = {sec["library"]: sec for sec in _plan()["libraries"]}

    smart = {i["title"]: i for i in by_lib["스마트"]["returns"]}
    assert smart["동물농장"]["needs_check"] and "반납처 확인(돌마리 책)" in smart["동물농장"]["notes"]
    assert not smart["멋진 신세계"]["needs_check"]
    hamlet = by_lib["잠실"]["returns"][0]
    assert hamlet["needs_check"] and hamlet["notes"] == ["반납일 확인 필요"]


def test_plain_text_uses_short_labels_and_hides_failed_account_ids():
    text = format_plan_text(_plan())

    assert text.splitlines()[:6] == [
        "도서관 반납·픽업 (10/5 기준)",
        "[잠실도서관 반납]",
        "- 햄릿 (영희, 반납일 확인 필요)",
        "- 파우스트 (영희, 10/30까지)",
        "[잠실도서관 픽업]",
        "- 페스트 (영희, 예약도서, 10/6까지)",
    ]
    assert "- 데미안 (길동, 연체 2일)" in text
    assert "[아직 못 찾음 - 이동 중]\n- 노인과 바다 (길동, 위례→스마트, 발송)" in text
    assert "(조회 실패 1개 계정은 빠졌습니다)" in text
    assert "lee" not in text and "홍길동" not in text


def test_empty_plan_says_so():
    report = build_report([{"label": "엄마"}], [{"name": "엄마", "books": [], "reservations": []}], now=NOW)

    assert format_plan_text(build_plan(report)).endswith("반납하거나 찾아올 책이 없습니다.")


def test_short_title_and_library_display():
    assert short_title("(세계문학)변신") == "변신"
    assert short_title("어린 왕자 : 생텍쥐페리 소설") == "어린 왕자"
    assert short_title("이방인 = The Stranger") == "이방인"
    assert short_title("(부제만)") == "(부제만)"
    assert library_display("영어") == "영어도서관"
    assert library_display("송파도서관") == "송파도서관"


def test_cli_plan_flag_prints_the_report(monkeypatch, capsys):
    class Store:
        def credentials(self, names):
            return CREDENTIALS

    monkeypatch.setattr(app, "fetch_report", lambda creds: build_report(creds, INFOS, now=NOW))

    code = app.run_status(["--plan"], Store())

    out = capsys.readouterr().out
    assert code == app.EXIT_FETCH_FAILED
    assert out.startswith("도서관 반납·픽업 (10/5 기준)\n[잠실도서관 반납]")


def test_partial_accounts_and_possible_duplicates_are_flagged():
    infos = [{"name": "엄마", "partial": True, "reservations": [], "books": [
        {"title": "같은 제목", "due_date": "2026.10.20", "is_interlibrary": False, "library": "거마"},
        {"title": "같은 제목", "due_date": "입수", "is_interlibrary": True, "library": "거마",
         "possible_duplicate": True},
    ]}]
    plan = build_plan(build_report([{"label": "엄마"}], infos, now=NOW))

    pickup = plan["libraries"][0]["pickups"][0]
    assert pickup["needs_check"] and "대출 중인 책과 제목 같음, 확인 필요" in pickup["notes"]
    assert format_plan_text(plan).endswith("(일부만 읽은 1개 계정은 빠진 책이 있을 수 있습니다)")
