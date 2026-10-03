"""자동 업데이트 (Windows).

앱 시작 시 GitHub Releases의 latest-build와 VERSION을 비교하고,
새 버전이 있으면 다운로드 후 자신을 교체하고 다시 시작한다.

- 버전 정보: CI가 빌드 시 생성하는 src/_version.py (APP_VERSION).
  파일이 없으면(소스 실행) 업데이터는 동작하지 않는다.
  버전은 리포 루트의 VERSION 파일에서 관리하며, 올리고 싶을 때만 숫자를 올린다.
  (문서만 고친 커밋에는 업데이트 안내가 뜨지 않는다.)
- 비공개 레포 대응: CI가 UPDATER_TOKEN 시크릿으로 생성하는
  src/_updater_token.py. 없으면 익명 요청(레포 공개 시)으로 동작한다.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

from PySide6.QtCore import QObject, Signal

REPO = "pchuri/songpa-loan-tracker"
RELEASE_TAG = "latest-build"
EXE_ASSET_NAME = "songpa-loan-tracker.exe"
VERSION_ASSET_NAME = "version.json"
RELEASE_API_URL = f"https://api.github.com/repos/{REPO}/releases/tags/{RELEASE_TAG}"


class DownloadCancelled(Exception):
    """사용자가 다운로드 취소를 눌렀다."""


def _build_version():
    try:
        from src._version import APP_VERSION
    except ImportError:
        return None
    return APP_VERSION or None


def _build_sha():
    # 구버전 릴리스와의 호환용. 새 릴리스는 version으로 비교한다.
    try:
        from src._version import BUILD_SHA
    except ImportError:
        return None
    return BUILD_SHA or None


def _github_token():
    try:
        from src._updater_token import GITHUB_TOKEN
    except ImportError:
        return None
    return GITHUB_TOKEN or None


def is_frozen():
    return getattr(sys, "frozen", False)


def should_check():
    """지금 이 환경에서 업데이트 확인을 수행해야 하는가."""
    return is_frozen() and sys.platform == "win32" and _build_version() is not None


def _parse_version(v):
    return tuple(int(x) for x in str(v).strip().split("."))


def is_newer(remote, local):
    """remote 버전이 local보다 새로운가."""
    try:
        return _parse_version(remote) > _parse_version(local)
    except (ValueError, TypeError, AttributeError):
        return str(remote) != str(local)


def _api_headers(octet_stream=False):
    headers = {"Accept": "application/vnd.github+json"}
    if octet_stream:
        headers["Accept"] = "application/octet-stream"
    token = _github_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _request_json(url):
    req = urllib.request.Request(url, headers=_api_headers())
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url, dest, progress_cb=None):
    """릴리스 에셋 다운로드. API asset url + octet-stream 방식을 쓴다."""
    req = urllib.request.Request(url, headers=_api_headers(octet_stream=True))
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            fh.write(chunk)
            done += len(chunk)
            if progress_cb:
                progress_cb(done, total)
    return dest


def find_asset(release, name):
    for asset in release.get("assets", []):
        if asset.get("name") == name:
            return asset
    return None


def _remote_version_info():
    release = _request_json(RELEASE_API_URL)
    version_asset = find_asset(release, VERSION_ASSET_NAME)
    exe_asset = find_asset(release, EXE_ASSET_NAME)
    if not version_asset or not exe_asset:
        return None, None, None
    tmp = os.path.join(tempfile.gettempdir(), "slt-version.json")
    _download(version_asset["url"], tmp)
    try:
        with open(tmp, encoding="utf-8") as fh:
            version_info = json.load(fh)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return version_info, exe_asset, release


def check_for_update():
    """새 버전이 있으면 (version_info, exe_asset), 없으면 None."""
    local_version = _build_version()
    if not local_version:
        return None
    try:
        version_info, exe_asset, _ = _remote_version_info()
    except Exception:
        return None
    if not version_info or not exe_asset:
        return None
    remote_version = version_info.get("version")
    if remote_version:
        if not is_newer(remote_version, local_version):
            return None
    elif version_info.get("sha") == _build_sha():
        # version이 없는 구 릴리스와의 호환
        return None
    return version_info, exe_asset


def exe_path():
    return Path(sys.executable).resolve()


UPDATER_BAT_NAME = "update-songpa-loan-tracker.bat"


def build_updater_script(exe: Path, new_exe: Path, pid: int) -> str:
    """앱 종료를 기다렸다가 exe를 교체하고 다시 실행하는 배치 스크립트.

    대기에는 30초 타임아웃이 있고, 그래도 안 꺼지면 강제 종료한다.
    """
    return (
        "@echo off\r\n"
        "setlocal\r\n"
        f'set "EXE={exe}"\r\n'
        f'set "NEW={new_exe}"\r\n'
        f'set "PID={pid}"\r\n'
        "set /a TRIES=0\r\n"
        ":waitloop\r\n"
        'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul\r\n'
        "if errorlevel 1 goto donewait\r\n"
        "set /a TRIES+=1\r\n"
        "if %TRIES% GTR 30 goto forcekill\r\n"
        "timeout /t 1 /nobreak >nul\r\n"
        "goto waitloop\r\n"
        ":forcekill\r\n"
        "taskkill /F /PID %PID% >nul 2>&1\r\n"
        "timeout /t 2 /nobreak >nul\r\n"
        ":donewait\r\n"
        'move /Y "%NEW%" "%EXE%" >nul\r\n'
        'start "" "%EXE%"\r\n'
        'del "%~f0"\r\n'
    )


def clean_stale_update_files():
    """이전 업데이트 시도의 잔재(.new.exe, updater bat)를 정리한다.

    앱 시작 시 호출되며, 실패해도 무시한다.
    """
    if not is_frozen() or sys.platform != "win32":
        return
    exe = exe_path()
    candidates = [
        exe.with_name(exe.stem + ".new.exe"),
        exe.parent / UPDATER_BAT_NAME,
    ]
    for p in candidates:
        try:
            if p.exists():
                p.unlink()
        except OSError:
            pass


def apply_update(exe_asset, progress_cb=None):
    """새 exe를 내려받고 교체 스크립트를 만든다. 스크립트 경로를 반환."""
    target = exe_path()
    tmp_new = target.with_name(target.stem + ".new.exe")
    _download(exe_asset["url"], tmp_new, progress_cb)
    if tmp_new.stat().st_size == 0:
        raise RuntimeError("다운로드된 파일이 비어 있습니다.")
    bat_path = target.with_name(UPDATER_BAT_NAME)
    bat_path.write_text(
        build_updater_script(target, tmp_new, os.getpid()), encoding="utf-8"
    )
    return bat_path


def launch_updater(bat_path):
    if sys.platform == "win32":
        subprocess.Popen(
            ["cmd", "/c", str(bat_path)],
            creationflags=subprocess.CREATE_NO_WINDOW
            | subprocess.DETACHED_PROCESS,
            close_fds=True,
        )
    else:
        subprocess.Popen(["cmd", "/c", str(bat_path)])


class UpdateChecker(QObject):
    """백그라운드 스레드에서 업데이트를 확인하고 결과를 시그널로 알린다."""

    update_found = Signal(object)  # (version_info, exe_asset)

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        result = check_for_update()
        if result:
            self.update_found.emit(result)
