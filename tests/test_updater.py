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


def test_check_for_update_none_when_same_sha(monkeypatch, tmp_path):
    monkeypatch.setattr(updater, "_build_sha", lambda: "abc123")
    monkeypatch.setattr(
        updater,
        "_remote_version_info",
        lambda: ({"sha": "abc123"}, {"name": "songpa-loan-tracker.exe"}, None),
    )
    assert updater.check_for_update() is None


def test_check_for_update_returns_assets_when_sha_differs(monkeypatch):
    monkeypatch.setattr(updater, "_build_sha", lambda: "old-sha")
    exe_asset = {"name": "songpa-loan-tracker.exe", "url": "https://example/x"}
    monkeypatch.setattr(
        updater,
        "_remote_version_info",
        lambda: ({"sha": "new-sha"}, exe_asset, None),
    )
    info, asset = updater.check_for_update()
    assert info["sha"] == "new-sha"
    assert asset is exe_asset


def test_check_for_update_none_on_network_error(monkeypatch):
    monkeypatch.setattr(updater, "_build_sha", lambda: "old-sha")

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
