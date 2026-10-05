"""songpa 명령어 진입점."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import logging
import os
import sys
from pathlib import Path

from songpa_cli import __version__
from songpa_cli.accounts import AccountError, AccountStore
from songpa_cli.report import build_report

EXIT_OK = 0
EXIT_FETCH_FAILED = 1
EXIT_USAGE = 2

NO_ACCOUNTS_HELP = "등록된 계정이 없습니다. 먼저 `songpa accounts add`로 계정을 추가해 주세요."


def _status_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="songpa",
        description="송파구립도서관 대출·상호대차·예약 현황을 조회합니다.",
        epilog="계정 관리: songpa accounts add | list | remove (자세히: songpa accounts -h)",
    )
    p.add_argument("--version", action="version", version=f"songpa {__version__}")
    p.add_argument("-u", "--user", action="append", metavar="이름",
                   help="이 계정만 조회 (이름이나 아이디, 여러 번 쓸 수 있음)")
    out = p.add_mutually_exclusive_group()
    out.add_argument("--json", action="store_true", help="JSON으로 출력 (스크립트·AI용)")
    out.add_argument("--html", action="store_true", help="카드 화면 HTML을 만들어 브라우저로 열기")
    out.add_argument("--notify", action="store_true", help="안드로이드 Termux 알림으로 보내기")
    p.add_argument("--due-soon", type=int, default=3, metavar="일",
                   help="반납 임박으로 볼 남은 날 수 (기본 3)")
    p.add_argument("--no-open", action="store_true", help="--html에서 파일만 만들고 열지 않기")
    p.add_argument("--output", type=Path, metavar="경로", help="--html 저장 경로")
    p.add_argument("--no-color", action="store_true", help="색 없이 출력")
    return p


def _accounts_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="songpa accounts", description="조회할 도서관 계정을 관리합니다.")
    sub = p.add_subparsers(dest="command", required=True)
    add = sub.add_parser("add", help="계정 추가 (같은 아이디면 바꾸기)")
    add.add_argument("--label", help="화면에 보일 이름")
    add.add_argument("--id", dest="user_id", help="도서관 홈페이지 아이디")
    add.add_argument("--password-stdin", action="store_true",
                     help="비밀번호를 표준입력 첫 줄에서 읽기 (입력 화면 없이 설정할 때, --label·--id 필수)")
    sub.add_parser("list", help="등록된 계정 보기")
    remove = sub.add_parser("remove", help="계정 삭제")
    remove.add_argument("name", metavar="이름", help="삭제할 계정의 이름이나 아이디")
    return p


def _prompt(text: str) -> str:
    try:
        return input(text)
    except EOFError:
        return ""


def run_accounts(argv: list[str], store: AccountStore) -> int:
    parser = _accounts_parser()
    args = parser.parse_args(argv)
    if args.command == "add" and args.password_stdin and not (args.label and args.user_id):
        # 이름·아이디를 물어보는 input()이 표준입력의 비밀번호 줄을 먼저 읽어 버린다.
        parser.error("--password-stdin을 쓸 때는 --label과 --id를 함께 주세요.")
    try:
        if args.command == "list":
            entries = store.entries()
            if not entries:
                print(NO_ACCOUNTS_HELP)
                return EXIT_OK
            for entry in entries:
                where = "키체인" if entry["password_store"] == "keyring" else "파일"
                print(f"{entry['label']}\t{entry['userId']}\t(비밀번호: {where})")
            print(f"\n설정 파일: {store.path}")
            return EXIT_OK

        if args.command == "remove":
            removed = store.remove(args.name)
            print(f"{removed['label']} 계정을 삭제했습니다.")
            return EXIT_OK

        label = args.label or _prompt("이름 (화면에 표시): ")
        user_id = args.user_id or _prompt("도서관 홈페이지 아이디: ")
        if args.password_stdin:
            password = sys.stdin.readline().rstrip("\r\n")
        else:
            password = getpass.getpass("비밀번호 (입력해도 화면에 보이지 않습니다): ")
        replaced = store.add(label, user_id, password)
        where = "OS 키체인" if store.uses_keyring else f"{store.path} (이 기기 사용자만 읽기 가능)"
        print(f"{label.strip()} 계정을 {'바꿨' if replaced else '추가했'}습니다. 비밀번호 저장 위치: {where}")
        return EXIT_OK
    except AccountError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return EXIT_USAGE


def fetch_report(credentials: list[dict]) -> dict:
    # songpa_core 로그는 실패한 계정의 아이디를 남긴다. 화면에는 결과의 오류 문구만 보여 준다.
    logging.getLogger("songpa_core").setLevel(logging.CRITICAL)
    from songpa_core.splib import get_infos_async

    infos = asyncio.run(get_infos_async([
        {"userId": c["userId"], "password": c["password"]} for c in credentials
    ]))
    return build_report(credentials, infos)


def _use_color(args) -> bool:
    return not args.no_color and "NO_COLOR" not in os.environ and sys.stdout.isatty()


def run_status(argv: list[str], store: AccountStore) -> int:
    args = _status_parser().parse_args(argv)
    try:
        credentials = store.credentials(args.user)
    except AccountError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return EXIT_USAGE
    if not credentials:
        print(NO_ACCOUNTS_HELP, file=sys.stderr)
        return EXIT_USAGE

    report = fetch_report(credentials)
    failed = any(a.get("error") for a in report["accounts"])

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif args.html:
        from songpa_cli.html_view import open_html, write_html

        path = write_html(report, args.due_soon, args.output)
        if args.no_open or not open_html(path):
            print(f"HTML 저장: {path}")
    elif args.notify:
        from songpa_cli.notify import build_notification, send_notification
        from songpa_cli.text import clean

        if not send_notification(report, args.due_soon):
            title, content, _ = build_notification(report, args.due_soon)
            print("알림을 보내지 못해 대신 출력합니다. (Termux에서 `pkg install termux-api`와 "
                  "Termux:API 앱 설치·알림 권한이 필요합니다)", file=sys.stderr)
            print(clean(title))
            print()
            print("\n".join(clean(line) for line in content.splitlines()))
    else:
        from songpa_cli.text import render_text

        print(render_text(report, args.due_soon, color=_use_color(args)))
    return EXIT_FETCH_FAILED if failed else EXIT_OK


def _ensure_utf8_output() -> None:
    # Windows에서 파이프로 넘기면 기본 인코딩(cp949)이라 이모지·JSON 출력이 깨진다.
    for stream in (sys.stdout, sys.stderr):
        if (getattr(stream, "encoding", "") or "").lower().replace("-", "") != "utf8":
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (AttributeError, ValueError):
                pass


def main(argv: list[str] | None = None) -> None:
    _ensure_utf8_output()
    argv = sys.argv[1:] if argv is None else argv
    store = AccountStore()
    if argv and argv[0] == "accounts":
        code = run_accounts(argv[1:], store)
    else:
        code = run_status(argv, store)
    sys.exit(code)
