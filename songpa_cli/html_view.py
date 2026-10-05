"""카드 화면 HTML. 폰·PC 브라우저 설정(라이트/다크)을 따라간다."""

from __future__ import annotations

import html
import os
import shutil
import subprocess
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

from songpa_cli.report import due_label, short_name

HTML_FILENAME = "latest.html"
HTML_SERVE_SECONDS = 120

HTML_STYLE = """
  /* 폰 설정(라이트/다크, 일몰~일출 자동 포함)을 따라간다. 라이트 색은 흰 바탕에서 읽히도록 진하게. */
  :root { color-scheme: light dark;
          --bg:#F2F2F7; --card:#FFFFFF; --border:#E5E5EA; --text:#000; --sub:#6C6C70;
          --chip:#E5E5EA; --chip-count:rgba(0,0,0,0.08); --overlay:rgba(242,242,247,0.92); --badge-bg:rgba(0,0,0,0.06);
          --green:#248A3D; --red:#D70015; --orange:#C93400; --sky:#0071A4; --yellow:#9A6700; --yellow-bg:#FFD60A;
          --tint-green:rgba(36,138,61,0.12); --tint-sky:rgba(0,113,164,0.12);
          --tint-red:rgba(215,0,21,0.08); --tint-red-border:rgba(215,0,21,0.3); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#000; --card:#1C1C1E; --border:#2C2C2E; --text:#FFF; --sub:#8E8E93;
            --chip:#2C2C2E; --chip-count:rgba(255,255,255,0.2); --overlay:rgba(0,0,0,0.9); --badge-bg:rgba(255,255,255,0.12);
            --green:#30D158; --red:#FF453A; --orange:#FF9F0A; --sky:#64D2FF; --yellow:#FFD60A; --yellow-bg:#FFD60A;
            --tint-green:rgba(48,209,88,0.18); --tint-sky:rgba(100,210,255,0.18);
            --tint-red:rgba(255,69,58,0.15); --tint-red-border:rgba(255,69,58,0.35); }
  }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--text); margin:0; padding:16px 12px 60px;
         font-family:-apple-system, "Noto Sans KR", Roboto, sans-serif; -webkit-font-smoothing:antialiased; }
  .app-header { text-align:center; margin-bottom:12px; }
  .app-title { font-size:20px; font-weight:800; margin-bottom:4px; }
  .fetched-at { display:inline-block; background:var(--chip); border-radius:10px; padding:3px 10px;
                font-size:13px; font-weight:700; color:var(--yellow); margin-bottom:4px; }
  .app-subtitle { font-size:13px; color:var(--sub); }
  .tabs { display:flex; gap:8px; overflow-x:auto; padding:6px 0 12px; position:sticky; top:0;
          background:var(--overlay); z-index:10; scrollbar-width:none; }
  .tabs::-webkit-scrollbar { display:none; }
  .tab-pill { background:var(--chip); color:var(--text); padding:6px 12px; border-radius:16px; font-size:13px;
              font-weight:600; text-decoration:none; white-space:nowrap; display:flex; align-items:center; gap:4px; }
  .tab-count { background:var(--chip-count); border-radius:10px; padding:1px 6px; font-size:11px; }
  .tab-inter { color:var(--red); font-size:12px; font-weight:800; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:16px 14px;
          margin-bottom:14px; scroll-margin-top:56px; }
  .user-row { display:flex; justify-content:space-between; align-items:center; }
  .user-name { font-size:17px; font-weight:800; }
  .badge-total { background:var(--badge-bg); padding:3px 9px; border-radius:12px; font-size:12px; font-weight:600; }
  .stats-row { display:flex; flex-wrap:wrap; gap:8px; font-size:13px; font-weight:700; margin-top:6px; }
  .err-box { background:var(--tint-red); border:1px solid var(--tint-red-border); color:var(--red);
             border-radius:10px; padding:10px; font-size:13px; margin-top:10px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  th { font-size:11px; color:var(--sub); text-align:left; padding:6px 4px; border-bottom:1px solid var(--border); }
  td { font-size:13px; padding:8px 4px; border-bottom:1px solid var(--border); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .col-num { color:var(--sub); width:18px; }
  .col-lib { width:58px; font-weight:700; white-space:nowrap; }
  .col-due { width:70px; text-align:right; white-space:nowrap; }
  .lib-sub, .loc { font-size:11px; color:var(--sub); font-weight:400; margin-top:2px; }
  .lib-sub { letter-spacing:-0.3px; }
  .inter { color:var(--green); }
  .tag { font-size:10px; font-weight:800; border-radius:6px; padding:1px 5px; margin-right:3px; }
  .tag-inter { background:var(--tint-green); color:var(--green); }
  .badge { font-size:11px; font-weight:800; border-radius:8px; padding:2px 7px; }
  .badge-pickup { background:var(--yellow-bg); color:#000; }
  .badge-transit { background:var(--tint-sky); color:var(--sky); }
  .due-urgent { color:var(--red); font-weight:800; }
  .due-soon { color:var(--orange); font-weight:800; }
  .due-normal { color:var(--green); font-weight:700; }
  .res-title { font-size:12px; color:var(--sub); font-weight:700; margin-top:12px; }
  .res-row { font-size:13px; padding:4px 0; }
  .res-ready { color:var(--yellow); font-weight:800; }
  .empty { color:var(--sub); text-align:center; padding:14px 0; }
"""


def _book_cells(book: dict, due_soon: int) -> tuple[str, str, str]:
    """(도서관 칸, 제목 칸, 상태 칸) HTML."""
    esc = html.escape
    title = esc(book["title"])
    lib = esc(book["library"])
    prov = esc(book["providing_library"])
    label, tier = due_label(book, due_soon)

    if tier == "pickup":
        lib_html = f'<div class="inter">{lib}</div><div class="lib-sub">수령처</div>'
        loc = f'<div class="loc">📍도착: <b>{lib}</b>{f" (소장: {prov})" if prov else ""}</div>'
        return lib_html, f"<div>{title}</div>{loc}", '<span class="badge badge-pickup">픽업필요</span>'

    if tier == "transit":
        raw = esc(book["transit_status"] or "")
        lib_html = f'<div class="inter">{lib}</div><div class="lib-sub">수령예정</div>'
        loc = f'<div class="loc">📍{f"{prov} ➔ " if prov else ""}<b>{lib}</b> ({raw})</div>'
        return lib_html, f"<div>{title}</div>{loc}", f'<span class="badge badge-transit">{esc(label)}</span>'

    cls = {"overdue": "due-urgent", "today": "due-urgent", "soon": "due-soon"}.get(tier, "due-normal")
    if book["is_interlibrary"]:
        lib_html = f'<div class="inter">{lib}</div><div class="lib-sub">수령/반납</div>'
        loc = f'<div class="loc"><span class="tag tag-inter">상호대차</span>{f"소장: {prov}" if prov else ""}</div>'
    else:
        lib_html = f'<div>{lib}</div><div class="lib-sub">대출처</div>'
        loc = ""
    short_date = esc(book["due_date"][5:]) if book["days_left"] is not None else ""
    return lib_html, f"<div>{title}</div>{loc}", f'{short_date}<br><span class="{cls}">{esc(label)}</span>'


def render_html(report: dict, due_soon: int = 3) -> str:
    esc = html.escape
    fetched = datetime.fromisoformat(report["fetched_at"]).strftime("%m/%d %H:%M")
    tabs, cards = [], []
    total_books = total_inter = total_pickup = 0

    for idx, account in enumerate(report["accounts"]):
        name = account["label"]
        books, reservations = account["books"], account["reservations"]
        inter = account["interlibrary_count"]
        pickups = sum(1 for b in books if b["status"] == "ready_for_pickup")
        res_ready = sum(1 for r in reservations if r["ready_for_pickup"])
        total_books += len(books)
        total_inter += inter
        total_pickup += account["ready_for_pickup_count"]

        tabs.append(f'<a href="#card-{idx}" class="tab-pill">{esc(short_name(name))} '
                    f'<span class="tab-count">{len(books)}</span><span class="tab-inter">({inter})</span></a>')

        if account.get("error"):
            body = f'<div class="err-box">⚠️ 조회 실패: {esc(str(account["error"]))}</div>'
        elif not books:
            body = '<div class="empty">현재 이용 중인 도서가 없습니다.</div>'
        else:
            trs = "".join(
                f'<tr><td class="col-num">{n}</td><td class="col-lib">{lib_html}</td>'
                f'<td>{title_html}</td><td class="col-due">{due_html}</td></tr>'
                for n, (lib_html, title_html, due_html) in enumerate((_book_cells(b, due_soon) for b in books), 1)
            )
            body = ('<table><thead><tr><th>#</th><th>도서관</th><th>도서명</th>'
                    f'<th style="text-align:right">상태/반납</th></tr></thead><tbody>{trs}</tbody></table>')

        res_html = ""
        if reservations and not account.get("error"):
            items = []
            for r in reservations:
                lib = esc(r["library"])
                if r["ready_for_pickup"]:
                    items.append(f'<div class="res-row res-ready">🔔 {esc(r["title"])} · {lib} 수령대기 (~{esc(r["pickup_deadline"])})</div>')
                else:
                    items.append(f'<div class="res-row">· {esc(r["title"])} · {lib} {r["rank"] or "?"}순위</div>')
            res_html = f'<div class="res-title">예약 {len(reservations)}건</div>{"".join(items)}'

        stats = [f'<span>대출 {len(books)}권</span>', f'<span class="inter">상호대차 {inter}</span>']
        if pickups:
            stats.append(f'<span style="color:var(--yellow)">🔔 픽업 {pickups}</span>')
        if res_ready:
            stats.append(f'<span style="color:var(--yellow)">🔖 예약수령 {res_ready}</span>')
        cards.append(
            f'<div class="card" id="card-{idx}"><div class="user-row"><span class="user-name">👤 {esc(name)}</span>'
            f'<span class="badge-total">{len(books)}권</span></div>'
            f'<div class="stats-row">{"".join(stats)}</div>{body}{res_html}</div>'
        )

    subtitle = f"{len(report['accounts'])}개 계정 · 총 {total_books}권 (상호대차 {total_inter})"
    if total_pickup:
        subtitle += f" · 🔔 찾아올 책 {total_pickup}"
    return f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>송파도서관 대출 현황</title><style>{HTML_STYLE}</style></head>
<body>
  <div class="app-header">
    <div class="app-title">📚 송파도서관 대출 현황</div>
    <div class="fetched-at">조회 시각 {fetched}</div>
    <div class="app-subtitle">{subtitle}</div>
  </div>
  <div class="tabs">{"".join(tabs)}</div>
  {"".join(cards)}
</body></html>
"""


def default_html_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "songpa"


def write_html(report: dict, due_soon: int, path: Path | None = None) -> Path:
    """HTML을 파일 하나에 덮어쓴다. 대출 내역이 담기므로 파일은 600.

    폴더 권한(700)은 기본 위치일 때만 맞춘다. --output으로 고른 폴더는 건드리지 않는다.
    """
    if path is None:
        path = default_html_dir() / HTML_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path.parent, 0o700)
        except OSError:
            pass
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    if hasattr(os, "fchmod"):
        os.fchmod(fd, 0o600)  # 이미 있던 파일은 O_CREAT 권한이 적용되지 않는다.
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(render_html(report, due_soon))
    return path


def is_termux() -> bool:
    return shutil.which("termux-open-url") is not None


def _serve_briefly(path: Path) -> str | None:
    """songpa_cli.serve를 따로 띄워 주소를 받는다. Termux 위젯 세션이 끝나도 살아 있도록 새 세션으로."""
    proc = subprocess.Popen(
        [sys.executable, "-m", "songpa_cli.serve", str(path), str(HTML_SERVE_SECONDS)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True, text=True,
    )
    line = proc.stdout.readline().split()
    proc.stdout.close()
    if len(line) != 2:
        return None
    port, page_path = line
    return f"http://127.0.0.1:{port}{page_path}"


def open_html(path: Path) -> bool:
    """브라우저로 연다. 열 방법을 못 찾으면 False."""
    if is_termux():
        url = _serve_briefly(path)
        if url is None:
            return False
        return subprocess.run(["termux-open-url", url], check=False).returncode == 0
    return webbrowser.open(path.resolve().as_uri())
