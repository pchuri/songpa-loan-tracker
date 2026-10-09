"""Schema and concurrent-process regressions for credential-preserving storage."""
import json
import multiprocessing
import os
import threading
from pathlib import Path

import pytest

from src.config_store import ConfigReadError, ConfigStore


@pytest.mark.parametrize("data", [
    {"env": None, "users": []},
    {"env": {}, "users": [], "ui_state": []},
    {"env": {}, "users": [{"encrypted_password": "recoverable"}]},
    {"users": [{"userId": 123, "password": "pw"}]},
    {"users": [{"userId": "u", "encrypted_password": 123}]},
    {"users": [{"userId": "u", "password": None}]},
    {"users": [{"userId": "u", "password": "\ud800"}]},
    {"users": [{"userId": "u", "password": "pending-migration"}, {"password": "orphan"}]},
    {"users": [{"userId": "u"}, {"label": "u"}]},
    {"env": {"X": []}, "users": []},
    {"env": {"X=Y": "bad"}, "users": []},
    {"env": {}, "users": [], "auto_refresh_interval": "5"},
    {"env": {}, "users": [], "auto_refresh_interval": 2**32},
    {"env": {}, "users": [], "dark_mode": "false"},
    {"env": {}, "users": [], "ui_state": {"sort_key": []}},
    {"env": {}, "users": [], "ui_state": {"selected_user": []}},
])
def test_malformed_fields_preserve_bytes_and_block_saves(tmp_path, monkeypatch, data):
    path = tmp_path / "config.json"
    original = json.dumps(data).encode()
    path.write_bytes(original)
    calls = []
    monkeypatch.setattr("keyring.get_password", lambda *args: calls.append(args))
    store = ConfigStore(path)
    assert store.load() == {"users": []}
    assert store.config_error
    with pytest.raises(ConfigReadError):
        store.save({}, [])
    assert path.read_bytes() == original
    assert calls == []  # Validate before migration or decryption.


@pytest.mark.parametrize("normalize", [False, True])
def test_legacy_label_account_preserves_ciphertext_on_save(tmp_path, monkeypatch, normalize):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"users": [{"label": " old-id ", "encrypted_password": "recoverable"}]}))
    monkeypatch.setattr("keyring.get_password", lambda *args: None)
    store = ConfigStore(path)
    data = store.load()
    assert store.config_error is None
    assert data["users"][0]["label"] == " old-id "
    users = [{"userId": "old-id", "password": ""}] if normalize else data["users"]
    store.save({}, users)
    assert json.loads(path.read_text())["users"] == [{"userId": "old-id", "encrypted_password": "recoverable"}]


def test_flat_legacy_environment_ignores_settings_metadata(tmp_path, monkeypatch):
    data = {"LEGACY_LIBRARY": "Songpa", "users": [{"label": "id"}], "dark_mode": True,
            "auto_refresh_interval": 5, "ui_state": {"selected_user": None}}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(data))
    store = ConfigStore(path)
    loaded = store.load()
    assert store.config_error is None
    monkeypatch.delenv("LEGACY_LIBRARY", raising=False)
    store.apply_env(loaded)
    assert os.environ["LEGACY_LIBRARY"] == "Songpa"


def _save_in_process(path, read_entered, allow_write, second_started, finished, password):
    class InstrumentedStore(ConfigStore):
        def _read(self):
            data = super()._read()
            read_entered.set()
            assert allow_write.wait(10)
            return data

        def _encrypt(self, plaintext):
            return "new-credential"

    second_started.set()
    InstrumentedStore(Path(path)).save({}, [{"userId": "u", "password": password}])
    finished.set()


def test_processes_serialize_read_merge_write(tmp_path):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"env": {}, "users": [{"userId": "u", "encrypted_password": "old"}]}))
    ctx = multiprocessing.get_context("spawn")
    first_read, second_read = ctx.Event(), ctx.Event()
    release_first, release_second = ctx.Event(), ctx.Event()
    first_started, second_started = ctx.Event(), ctx.Event()
    first_done, second_done = ctx.Event(), ctx.Event()
    release_second.set()
    first = ctx.Process(target=_save_in_process, args=(str(path), first_read, release_first, first_started, first_done, "new"))
    second = ctx.Process(target=_save_in_process, args=(str(path), second_read, release_second, second_started, second_done, ""))
    try:
        first.start()
        assert first_read.wait(10)
        second.start()
        assert second_started.wait(10)
        # A second process must not read stale credentials while the first transaction is open.
        assert not second_read.wait(0.3)
        release_first.set()
        first.join(10)
        second.join(10)
        assert first.exitcode == second.exitcode == 0
        assert first_done.is_set() and second_done.is_set()
        assert json.loads(path.read_text())["users"][0]["encrypted_password"] == "new-credential"
    finally:
        release_first.set()
        for process in (first, second):
            if process.pid:
                process.join(2)
                if process.is_alive():
                    process.terminate()
                    process.join(2)


def test_concurrent_atomic_writes_do_not_share_temporary_inode(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    first, second = ConfigStore(path), ConfigStore(path)
    opened_second, first_done = threading.Event(), threading.Event()
    real_fdopen = os.fdopen
    errors = []
    long_data = {"users": [{"userId": "a", "encrypted_password": "a" * 500}]}
    short_data = {"users": []}

    class PausedFile:
        def __init__(self, fh):
            self.fh = fh
        def __enter__(self):
            self.fh.__enter__()
            return self
        def __exit__(self, *args):
            return self.fh.__exit__(*args)
        def __getattr__(self, name):
            return getattr(self.fh, name)
        def write(self, value):
            if threading.current_thread().name == "first":
                assert opened_second.wait(5)
            else:
                opened_second.set()
                assert first_done.wait(5)
            return self.fh.write(value)

    def write(store, data):
        try:
            store._write(data)
        except Exception as exc:
            errors.append(exc)
        finally:
            if threading.current_thread().name == "first":
                first_done.set()

    monkeypatch.setattr(os, "fdopen", lambda *args, **kwargs: PausedFile(real_fdopen(*args, **kwargs)))
    threads = [threading.Thread(name="first", target=write, args=(first, long_data)),
               threading.Thread(name="second", target=write, args=(second, short_data))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
        assert not thread.is_alive()
    assert errors == []
    assert json.loads(path.read_text()) == short_data
    assert list(tmp_path.glob("*.tmp")) == []


def test_lock_timeout_preserves_original_and_requires_reload(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    original = b'{"env": {}, "users": [{"userId": "u", "encrypted_password": "recoverable"}]}'
    path.write_bytes(original)
    owner, contender = ConfigStore(path), ConfigStore(path)
    monkeypatch.setattr("src.config_store._LOCK_TIMEOUT_SECONDS", 0.1)
    with owner._transaction():
        assert contender.load() == {"users": []}
        assert "busy" in contender.config_error
        with pytest.raises(ConfigReadError):
            contender.save({}, [])
    with pytest.raises(ConfigReadError):
        contender.save({}, [])
    assert path.read_bytes() == original
    monkeypatch.setattr("keyring.get_password", lambda *args: None)
    assert contender.load()["users"][0]["userId"] == "u"
    assert contender.config_error is None
