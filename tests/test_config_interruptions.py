"""Real-process interruption and repeated recovery using only dummy config paths."""
import json
import multiprocessing
import os
import time
from pathlib import Path

import pytest

from src.config_store import ConfigReadError, ConfigStore


def _paused_writer(path, stage, reached):
    # Pause at the commit boundary, while save still owns the OS lock.
    real_replace = os.replace

    def replace(source, destination):
        if stage == "after":
            real_replace(source, destination)
        reached.set()
        time.sleep(30)
        if stage == "before":
            real_replace(source, destination)

    os.replace = replace
    ConfigStore(Path(path)).save({"GENERATION": "new"}, [{"userId": "dummy"}])


@pytest.mark.skipif(os.name != "posix", reason="SIGKILL and POSIX permission checks")
@pytest.mark.parametrize("stage", ["before", "after"])
def test_killed_writer_preserves_commit_boundary_and_releases_lock(tmp_path, stage):
    path = tmp_path / "config.json"
    old = {"env": {"GENERATION": "old"}, "users": [{"userId": "dummy"}]}
    original = json.dumps(old).encode()
    path.write_bytes(original)
    ctx = multiprocessing.get_context("spawn")
    reached = ctx.Event()
    process = ctx.Process(target=_paused_writer, args=(str(path), stage, reached))
    try:
        process.start()
        assert reached.wait(10)
        process.kill()
        process.join(10)
        assert process.exitcode is not None and process.exitcode < 0
        if stage == "before":
            assert path.read_bytes() == original
            # A hard kill can leave an uncommitted temporary file. It must never
            # be mistaken for the config, reused, or prevent the next save.
            assert len(list(tmp_path.glob("config.json.*.tmp"))) == 1
        else:
            assert json.loads(path.read_text())["env"] == {"GENERATION": "new"}
            assert list(tmp_path.glob("*.tmp")) == []
        store = ConfigStore(path)
        assert store.load()["users"] == [{"userId": "dummy", "password": ""}]
        assert store.config_error is None
        store.save({"GENERATION": "restarted"}, [{"userId": "dummy"}])
        assert json.loads(path.read_text())["env"] == {"GENERATION": "restarted"}
        assert path.stat().st_mode & 0o777 == 0o600
    finally:
        if process.pid and process.is_alive():
            process.kill()
            process.join(10)


def test_repeated_corruption_repair_reload_and_restart(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    credential_calls = []
    monkeypatch.setattr("keyring.get_password", lambda *args: credential_calls.append(args))
    monkeypatch.setattr("keyring.set_password", lambda *args: credential_calls.append(args))
    store = ConfigStore(path)
    for generation in range(30):
        corrupt = b'{"users": [' + str(generation).encode()
        path.write_bytes(corrupt)
        assert store.load() == {"users": []}
        for _ in range(3):
            with pytest.raises(ConfigReadError):
                store.save({}, [])
            assert path.read_bytes() == corrupt
        repaired = {"env": {"GENERATION": str(generation)}, "users": [{"userId": "dummy"}]}
        path.write_text(json.dumps(repaired))
        with pytest.raises(ConfigReadError):
            store.save({}, [])
        loaded = store.load()
        assert store.config_error is None
        store.save(loaded["env"], loaded["users"])
        store = ConfigStore(path)
        restarted = store.load()
        assert restarted["env"] == loaded["env"]
        assert restarted["users"] == loaded["users"]
        assert restarted["auto_refresh_interval"] == 0
        assert restarted["dark_mode"] is False
    assert credential_calls == []


@pytest.mark.skipif(os.name != "posix" or os.geteuid() == 0, reason="non-root POSIX permissions")
def test_real_permission_denial_preserves_bytes_until_reload(tmp_path):
    path = tmp_path / "config.json"
    original = b'{"env": {}, "users": [{"userId": "dummy"}]}'
    path.write_bytes(original)
    store = ConfigStore(path)
    path.chmod(0)
    try:
        assert store.load() == {"users": []}
        with pytest.raises(ConfigReadError):
            store.save({}, [])
    finally:
        path.chmod(0o600)
    assert path.read_bytes() == original
    with pytest.raises(ConfigReadError):
        store.save({}, [])
    loaded = store.load()
    assert store.config_error is None
    store.save({}, loaded["users"])
    assert json.loads(path.read_text())["users"] == [{"userId": "dummy"}]
