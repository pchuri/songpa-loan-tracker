"""자동 업데이터 로직 테스트. 네트워크는 쓰지 않는다."""

import json
from pathlib import Path

import pytest

from src import updater


def test_should_check_is_false_when_not_frozen(monkeypatch):
    monkeypatch.setattr(updater.sys, "frozen", False, raising=False)
    assert updater.should_check() is False


def test_should_check_is_false_on_non_windows(monkeypatch):
    monkeypatch.setattr(updater.sys, "frozen", True, raising=False)
    monkeypatch.setattr(updater.sys, "platform", "linux")
    assert updater.should_check() is False


def test_find_asset():
    release = {"assets": [{"name": "a.exe"}, {"name": "version.json"}]}
    assert updater.find_asset(release, "version.json")["name"] == "version.json"
    assert updater.find_asset(release, "missing") is None
    assert updater.find_asset({}, "version.json") is None


def _remote(version, asset=None):
    return (
        {"version": version, "sha": "s-" + version},
        asset if asset is not None else {"name": "songpa-loan-tracker.exe"},
        None,
    )


def test_check_for_update_none_when_same_version(monkeypatch):
    monkeypatch.setattr(updater, "_build_version", lambda: "1.0.0")
    monkeypatch.setattr(updater, "_remote_version_info", lambda: _remote("1.0.0"))
    assert updater.check_for_update() is None


def test_check_for_update_none_when_remote_older(monkeypatch):
    monkeypatch.setattr(updater, "_build_version", lambda: "1.2.0")
    monkeypatch.setattr(updater, "_remote_version_info", lambda: _remote("1.1.0"))
    assert updater.check_for_update() is None


def test_check_for_update_returns_assets_when_version_newer(monkeypatch):
    monkeypatch.setattr(updater, "_build_version", lambda: "1.0.0")
    exe_asset = {"name": "songpa-loan-tracker.exe", "url": "https://example/x"}
    monkeypatch.setattr(updater, "_remote_version_info", lambda: _remote("1.1.0", exe_asset))
    info, asset = updater.check_for_update()
    assert info["version"] == "1.1.0"
    assert asset is exe_asset


def test_check_for_update_falls_back_to_sha_without_version(monkeypatch):
    # version이 없는 구 릴리스: sha 비교로 동작
    monkeypatch.setattr(updater, "_build_version", lambda: "1.0.0")
    monkeypatch.setattr(updater, "_build_sha", lambda: "old-sha")
    monkeypatch.setattr(
        updater,
        "_remote_version_info",
        lambda: ({"sha": "old-sha"}, {"name": "songpa-loan-tracker.exe"}, None),
    )
    assert updater.check_for_update() is None
    monkeypatch.setattr(
        updater,
        "_remote_version_info",
        lambda: ({"sha": "new-sha"}, {"name": "songpa-loan-tracker.exe"}, None),
    )
    assert updater.check_for_update() is not None


def test_is_newer():
    assert updater.is_newer("1.1.0", "1.0.0") is True
    assert updater.is_newer("1.0.0", "1.0.0") is False
    assert updater.is_newer("1.0.0", "1.1.0") is False
    assert updater.is_newer("1.0.10", "1.0.9") is True
    assert updater.is_newer("2.0", "1.9.9") is True


def test_check_for_update_none_on_network_error(monkeypatch):
    monkeypatch.setattr(updater, "_build_version", lambda: "1.0.0")

    def boom():
        raise OSError("no network")

    monkeypatch.setattr(updater, "_remote_version_info", boom)
    assert updater.check_for_update() is None


def test_build_updater_script(tmp_path):
    exe = tmp_path / "songpa-loan-tracker.exe"
    new_exe = tmp_path / "songpa-loan-tracker.new.exe"
    script = updater.build_updater_script(exe, new_exe, 1234)
    assert f'set "PID=1234"' in script
    assert f'set "EXE={exe}"' in script
    assert f'set "NEW={new_exe}' in script
    assert "tasklist" in script  # 앱 종료 대기
    assert 'move /Y "%NEW%" "%EXE%"' in script
    assert 'start "" "%EXE%"' in script
    assert 'del "%~f0"' in script  # 스크립트 자가 삭제
    assert "taskkill /F /PID" in script  # 타임아웃 시 강제 종료
    assert "TRIES" in script  # 대기 타임아웃 카운터


def test_apply_update_writes_bat_and_downloads(monkeypatch, tmp_path):
    monkeypatch.setattr(updater.sys, "frozen", True, raising=False)
    monkeypatch.setattr(updater, "exe_path", lambda: tmp_path / "songpa-loan-tracker.exe")

    def fake_download(url, dest, progress_cb=None):
        Path(dest).write_bytes(b"fake-exe-bytes")
        if progress_cb:
            progress_cb(15, 15)

    monkeypatch.setattr(updater, "_download", fake_download)
    monkeypatch.setattr(updater.os, "getpid", lambda: 4321)

    progress_calls = []
    bat = updater.apply_update(
        {"url": "https://example/x"}, progress_cb=lambda d, t: progress_calls.append((d, t))
    )
    assert bat.name == "update-songpa-loan-tracker.bat"
    assert (tmp_path / "songpa-loan-tracker.new.exe").read_bytes() == b"fake-exe-bytes"
    assert "4321" in bat.read_text(encoding="utf-8")
    assert progress_calls == [(15, 15)]


def test_apply_update_rejects_empty_download(monkeypatch, tmp_path):
    monkeypatch.setattr(updater, "exe_path", lambda: tmp_path / "songpa-loan-tracker.exe")
    monkeypatch.setattr(updater, "_download", lambda url, dest, progress_cb=None: Path(dest).write_bytes(b""))
    with pytest.raises(RuntimeError):
        updater.apply_update({"url": "https://example/x"})


def test_clean_stale_update_files_removes_leftovers(monkeypatch, tmp_path):
    exe = tmp_path / "songpa-loan-tracker.exe"
    exe.write_bytes(b"x")
    stale_new = tmp_path / "songpa-loan-tracker.new.exe"
    stale_new.write_bytes(b"y")
    stale_bat = tmp_path / updater.UPDATER_BAT_NAME
    stale_bat.write_text("x")
    keep = tmp_path / "notes.txt"
    keep.write_text("keep me")

    monkeypatch.setattr(updater.sys, "frozen", True, raising=False)
    monkeypatch.setattr(updater.sys, "platform", "win32")
    monkeypatch.setattr(updater, "exe_path", lambda: exe)

    updater.clean_stale_update_files()

    assert not stale_new.exists()
    assert not stale_bat.exists()
    assert exe.exists()
    assert keep.exists()


def test_clean_stale_update_files_noop_when_not_frozen(monkeypatch, tmp_path):
    monkeypatch.setattr(updater.sys, "frozen", False, raising=False)
    # exe_path를 호출하지 않아야 한다 (호출되면 AttributeError)
    monkeypatch.setattr(updater, "exe_path", lambda: (_ for _ in ()).throw(AssertionError()))
    updater.clean_stale_update_files()  # 예외 없이 통과
