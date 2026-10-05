from core.splib import parse_doorae_status, parse_loan_status


def _loan_row(title, library, dates_html, status):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info"><span><strong>{library}</strong></span></div>
        <div class="info">{dates_html}</div>
      </div>
      <div class="statusBox">{status}</div>
    </div>"""


TWO_DATES = "<span>대출일 : 2026.08.01</span><span>반납예정일 : 2026.09.01</span>"
ONE_DATE = "<span>반납예정일 : 2026.09.09</span>"


def _page(rows):
    return f'<div class="myArticleWrap">{"".join(rows)}</div><!-- footer -->'


def test_interlibrary_flag_stays_with_its_own_row():
    """날짜 span이 2개가 아닌 행이 섞여도 상호대차 플래그가 밀리지 않아야 한다.

    제목은 len(date_info) == 2인 행만 수집하는데 상태는 모든 statusBox에서 걷으면,
    한 칸씩 밀려서 엉뚱한 책에 상호대차 배지와 초록 제목이 붙는다.
    """
    html = _page([
        _loan_row("A 책", "거마도서관", ONE_DATE, "연장"),
        _loan_row("B 책", "돌마리도서관", TWO_DATES, "책솔이"),
        _loan_row("C 책", "송파위례도서관", TWO_DATES, "연장"),
    ])

    titles, _, _, _, flags, books = parse_loan_status(html)

    assert titles == ["B 책", "C 책"]
    assert books["B 책"]["is_booksole"] is True
    assert books["C 책"]["is_booksole"] is False
    assert flags == [True, False]


def test_same_title_at_two_libraries_yields_two_loans():
    html = _page([
        _loan_row("물결의 이름", "거마도서관", TWO_DATES, "연장"),
        _loan_row("물결의 이름", "송파위례도서관", TWO_DATES, "연장"),
    ])

    titles, libraries, _, _, _, _ = parse_loan_status(html)

    assert titles == ["물결의 이름", "물결의 이름"]
    assert libraries == ["거마", "위례"]


def _doorae_row(title, receiving, providing, status):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info"><span>수령도서관 : {receiving}</span></div>
        <div class="info"><span>제공도서관 : {providing}</span></div>
      </div>
      <div class="statusBox">{status}</div>
    </div>"""


def test_same_title_from_two_libraries_keeps_both_interlibrary_entries():
    """같은 제목을 두 도서관에서 상호대차로 받는 중이면 두 건 모두 남아야 한다."""
    html = _page([
        _doorae_row("타오르는 강", "거마도서관", "송파위례도서관", "입수"),
        _doorae_row("타오르는 강", "돌마리도서관", "송파글마루도서관", "발송"),
    ])

    entries, returning = parse_doorae_status(html)

    # 집합이 아니라 순서쌍으로 본다. 집합 비교는 상태가 엉뚱한 행에 붙는 오매칭 —
    # 바로 이 수정이 겨냥한 버그 — 를 잡지 못한다.
    assert [(e["receiving_library"], e["status"]) for e in entries] == [
        ("거마", "입수"),
        ("돌마리", "발송"),
    ]
    assert returning == 0


def test_doorae_keeps_only_in_transit_statuses_and_counts_returning():
    html = _page([
        _doorae_row("가는 책", "거마도서관", "송파위례도서관", "복귀중"),
        _doorae_row("오는 책", "돌마리도서관", "송파글마루도서관", "입수"),
        _doorae_row("신청한 책", "잠실본동", "거마도서관", "요청중신청취소"),
        _doorae_row("버튼 붙은 책", "잠실본동", "거마도서관", "요청중 <a>신청취소</a>"),
        _doorae_row("접수 전 책", "잠실본동", "거마도서관", "신청중"),
        _doorae_row("다 본 책", "잠실본동", "거마도서관", "완료"),
        _doorae_row("취소한 책", "잠실본동", "거마도서관", "신청취소"),
        _doorae_row("모르는 상태", "잠실본동", "거마도서관", "입수취소"),
    ])

    entries, returning = parse_doorae_status(html)

    assert [e["title"] for e in entries] == ["오는 책", "신청한 책", "버튼 붙은 책", "접수 전 책"]
    assert [e["status"] for e in entries] == ["입수", "요청중", "요청중", "신청중"]
    assert returning == 1


def test_doorae_entries_keep_page_order():
    html = _page([
        _doorae_row("첫째", "거마도서관", "송파위례도서관", "입수"),
        _doorae_row("둘째", "돌마리도서관", "송파글마루도서관", "발송"),
    ])

    entries, _ = parse_doorae_status(html)

    assert [e["title"] for e in entries] == ["첫째", "둘째"]


def _loan_row_without_status(title, library, dates_html):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info"><span><strong>{library}</strong></span></div>
        <div class="info">{dates_html}</div>
      </div>
    </div>"""


def test_a_row_with_no_status_box_does_not_borrow_the_next_rows_status():
    """statusBox가 빠진 행이 다음 행의 상태를 끌어오면 안 된다.

    infoBox와 statusBox를 각각 find_all로 걷어 zip하던 방식에서는 이 행 때문에
    이후 모든 행의 책솔이 플래그가 한 칸씩 밀렸다.
    """
    html = _page([
        _loan_row_without_status("A 책", "거마도서관", TWO_DATES),
        _loan_row("B 책", "돌마리도서관", TWO_DATES, "책솔이"),
        _loan_row("C 책", "송파위례도서관", TWO_DATES, "연장"),
    ])

    titles, _, _, _, flags, _ = parse_loan_status(html)

    assert titles == ["A 책", "B 책", "C 책"]
    assert flags == [False, True, False]


def test_a_trailing_row_with_no_status_box_is_still_returned():
    html = _page([
        _loan_row("A 책", "거마도서관", TWO_DATES, "책솔이"),
        _loan_row_without_status("B 책", "돌마리도서관", TWO_DATES),
    ])

    titles, _, _, _, flags, _ = parse_loan_status(html)

    assert titles == ["A 책", "B 책"]
    assert flags == [True, False]


def _doorae_row_without_status(title, receiving, providing):
    return f"""
    <div class="myArticle-list">
      <div class="infoBox">
        <div class="title">{title}</div>
        <div class="info"><span>수령도서관 : {receiving}</span></div>
        <div class="info"><span>제공도서관 : {providing}</span></div>
      </div>
    </div>"""


def test_doorae_row_with_no_status_box_does_not_steal_the_next_status():
    html = _page([
        _doorae_row_without_status("상태 없는 책", "거마도서관", "송파위례도서관"),
        _doorae_row("오는 책", "돌마리도서관", "송파글마루도서관", "입수"),
    ])

    entries, _ = parse_doorae_status(html)

    # 상태 없는 행은 화이트리스트에서 걸러지고, 입수는 원래 주인에게 남는다.
    assert [(e["title"], e["status"]) for e in entries] == [("오는 책", "입수")]


TITLELESS_RETURNING_ROW = (
    '<div class="myArticle-list">'
    '<div class="infoBox"><div class="info"><span>수령도서관 : 거마도서관</span></div></div>'
    '<div class="statusBox">복귀중</div>'
    '</div>'
)


def test_returning_count_includes_a_row_without_a_title():
    """복귀중 집계는 제목 유무와 무관하다. 빠지면 active_interlibrary_loans가 과다 보고된다."""
    entries, returning = parse_doorae_status(_page([TITLELESS_RETURNING_ROW]))

    assert entries == []
    assert returning == 1


STRAY_STATUS_BOX = '<aside><div class="statusBox">책솔이</div></aside>'


def test_a_status_box_outside_the_result_rows_is_ignored():
    """목록 밖의 statusBox가 마지막 행의 상태로 새어들면 안 된다."""
    html = _page([
        _loan_row("A 책", "거마도서관", TWO_DATES, "연장"),
        _loan_row("B 책", "돌마리도서관", TWO_DATES, "연장"),
    ]) + STRAY_STATUS_BOX

    titles, _, _, _, flags, _ = parse_loan_status(html)

    assert titles == ["A 책", "B 책"]
    assert flags == [False, False]


def test_rows_are_read_even_when_the_wrapper_class_is_missing():
    """래퍼를 못 찾으면 문서 순서로 물러난다. 목록이 통째로 비어선 안 된다."""
    unwrapped = """
    <div class="infoBox">
      <div class="title">A 책</div>
      <div class="info"><span><strong>거마도서관</strong></span></div>
      <div class="info">{dates}</div>
    </div>
    <div class="statusBox">책솔이</div>
    """.format(dates=TWO_DATES)

    titles, _, _, _, flags, _ = parse_loan_status(f"<div>{unwrapped}</div><!-- footer -->")

    assert titles == ["A 책"]
    assert flags == [True]


def test_a_row_wrapper_that_is_not_a_div_still_counts():
    html = ('<ul><li class="myArticle-list">'
            '<div class="infoBox"><div class="title">A 책</div>'
            '<div class="info"><span><strong>거마도서관</strong></span></div>'
            f'<div class="info">{TWO_DATES}</div></div>'
            '<div class="statusBox">책솔이</div>'
            '</li></ul><!-- footer -->')

    titles, _, _, _, flags, _ = parse_loan_status(html)

    assert titles == ["A 책"]
    assert flags == [True]
