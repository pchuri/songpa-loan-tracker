import json
from pathlib import Path

import keyring
import keyring.errors
import pytest
from cryptography.fernet import Fernet

from src.config_store import ConfigReadError, ConfigStore, KeychainAccessError


def make_store(tmp_path, data=None):
    path = tmp_path / "config.json"
    if data is not None:
        path.write_text(json.dumps(data))
    return ConfigStore(path=path)


def make_encrypted_config(key: bytes, password: str) -> dict:
    enc = Fernet(key).encrypt(password.encode()).decode()
    return {"env": {}, "users": [{"userId": "u1", "encrypted_password": enc}]}


@pytest.fixture
def fake_keyring(monkeypatch):
    """In-memory keyring; tests mutate .store or swap the functions."""
    state = {"store": {}, "set_calls": []}

    def get_password(service, username):
        return state["store"].get((service, username))

    def set_password(service, username, password):
        state["set_calls"].append((service, username, password))
        state["store"][(service, username)] = password

    monkeypatch.setattr(keyring, "get_password", get_password)
    monkeypatch.setattr(keyring, "set_password", set_password)
    return state


def deny(monkeypatch, exc=None):
    exc = exc or keyring.errors.KeyringError("access denied")

    def raise_error(*args, **kwargs):
        raise exc

    monkeypatch.setattr(keyring, "get_password", raise_error)
    monkeypatch.setattr(keyring, "set_password", raise_error)


def test_load_survives_keyring_error(tmp_path, monkeypatch):
    deny(monkeypatch)
    key = Fernet.generate_key()
    config = make_encrypted_config(key, "secret")
    store = make_store(tmp_path, config)

    data = store.load()

    assert store.keychain_error
    assert data["users"] == [{"userId": "u1", "password": ""}]
    # ciphertext on disk untouched
    assert json.loads(store.path.read_text()) == config


def test_load_survives_keyring_locked(tmp_path, monkeypatch):
    deny(monkeypatch, keyring.errors.KeyringLocked("keychain locked"))
    store = make_store(tmp_path, make_encrypted_config(Fernet.generate_key(), "pw"))

    data = store.load()

    assert store.keychain_error
    assert data["users"][0]["password"] == ""


def test_none_key_with_existing_ciphertext_never_regenerates(tmp_path, fake_keyring):
    # get_password returns None (denied read on some backends), but encrypted
    # passwords exist: must NOT create a new master key.
    config = make_encrypted_config(Fernet.generate_key(), "secret")
    store = make_store(tmp_path, config)

    data = store.load()

    assert store.keychain_error
    assert fake_keyring["set_calls"] == []
    assert data["users"][0]["password"] == ""
    assert json.loads(store.path.read_text()) == config


def test_fresh_setup_generates_key_and_round_trips(tmp_path, fake_keyring):
    store = make_store(tmp_path)
    store.save({}, [{"userId": "u1", "password": "secret"}])

    assert len(fake_keyring["set_calls"]) == 1
    on_disk = json.loads(store.path.read_text())
    assert on_disk["users"][0]["encrypted_password"]
    assert "password" not in on_disk["users"][0]

    fresh = ConfigStore(path=store.path)
    data = fresh.load()
    assert fresh.keychain_error is None
    assert data["users"][0]["password"] == "secret"


def test_save_preserves_ciphertext_when_password_empty(tmp_path, monkeypatch):
    deny(monkeypatch)
    key = Fernet.generate_key()
    config = make_encrypted_config(key, "secret")
    store = make_store(tmp_path, config)

    users = store.load()["users"]
    assert users[0]["password"] == ""
    store.save({"A": "1"}, users, auto_refresh_interval=5, dark_mode=True)

    on_disk = json.loads(store.path.read_text())
    assert on_disk["users"][0]["encrypted_password"] == config["users"][0]["encrypted_password"]
    assert on_disk["env"] == {"A": "1"}

    # once keychain access works again, the original password is recovered
    monkeypatch.setattr(keyring, "get_password", lambda *a: key.decode())
    recovered = ConfigStore(path=store.path).load()
    assert recovered["users"][0]["password"] == "secret"


def test_save_new_password_denied_keeps_old_ciphertext(tmp_path, monkeypatch):
    deny(monkeypatch)
    config = make_encrypted_config(Fernet.generate_key(), "old")
    store = make_store(tmp_path, config)

    store.save({}, [{"userId": "u1", "password": "new-password"}])

    on_disk = json.loads(store.path.read_text())
    assert store.keychain_error
    assert on_disk["users"][0]["encrypted_password"] == config["users"][0]["encrypted_password"]
    assert "new-password" not in store.path.read_text()


def test_set_password_failure_does_not_crash_save(tmp_path, monkeypatch):
    monkeypatch.setattr(keyring, "get_password", lambda *a: None)

    def fail_set(*args, **kwargs):
        raise keyring.errors.PasswordSetError("write denied")

    monkeypatch.setattr(keyring, "set_password", fail_set)
    store = make_store(tmp_path)

    store.save({}, [{"userId": "u1", "password": "secret"}])

    assert store.keychain_error
    on_disk = json.loads(store.path.read_text())
    assert on_disk["users"] == [{"userId": "u1"}]
    assert "secret" not in store.path.read_text()


def test_plaintext_migration_skipped_when_keyring_denied(tmp_path, monkeypatch):
    deny(monkeypatch)
    config = {"env": {}, "users": [{"userId": "u1", "password": "plain"}]}
    store = make_store(tmp_path, config)

    data = store.load()

    # still usable in memory, file left as-is (no half-migration)
    assert data["users"][0]["password"] == "plain"
    assert json.loads(store.path.read_text()) == config


def test_save_preserves_legacy_plaintext_when_keyring_denied(tmp_path, monkeypatch):
    # Pre-migration config (plaintext on disk) + denied keychain: the hot
    # _save_ui_state path must not strip the only copy of the credential.
    deny(monkeypatch)
    config = {"env": {}, "users": [{"userId": "u1", "password": "legacy-plain"}]}
    store = make_store(tmp_path, config)

    users = store.load()["users"]
    assert users[0]["password"] == "legacy-plain"
    store.save({}, users)

    on_disk = json.loads(store.path.read_text())
    assert on_disk["users"][0]["password"] == "legacy-plain"

    # once keychain access works again, load() migrates instead of losing it
    kr = {}
    monkeypatch.setattr(keyring, "get_password", lambda s, u: kr.get((s, u)))
    monkeypatch.setattr(keyring, "set_password", lambda s, u, p: kr.__setitem__((s, u), p))
    recovered = ConfigStore(path=store.path)
    data = recovered.load()
    assert data["users"][0]["password"] == "legacy-plain"
    migrated = json.loads(store.path.read_text())
    assert migrated["users"][0]["encrypted_password"]
    assert "password" not in migrated["users"][0]


def test_load_keeps_plaintext_when_entry_has_both_fields(tmp_path, monkeypatch):
    # Migration skipped under denial leaves both fields; the decrypt loop must
    # not blank the surviving plaintext, and save must keep both on disk.
    deny(monkeypatch)
    config = {
        "env": {},
        "users": [{"userId": "u1", "password": "plain", "encrypted_password": "gAAA-stale"}],
    }
    store = make_store(tmp_path, config)

    users = store.load()["users"]
    assert users[0]["password"] == "plain"
    store.save({}, users)

    on_disk = json.loads(store.path.read_text())
    assert on_disk["users"][0]["password"] == "plain"
    assert on_disk["users"][0]["encrypted_password"] == "gAAA-stale"


def test_corrupt_config_blocks_key_regeneration(tmp_path, fake_keyring):
    # A truncated config may still hold ciphertext; a None key (backend that
    # swallows denials) must not lead to generating a new master key over it.
    path = tmp_path / "config.json"
    path.write_text('{"users": [{"userId": "u1", "encrypted_password": "gAAA')
    original = path.read_bytes()
    store = ConfigStore(path=path)

    with pytest.raises(ConfigReadError):
        store.save({}, [{"userId": "u2", "password": "pw"}])

    assert fake_keyring["set_calls"] == []
    assert store.config_error
    assert path.read_bytes() == original


@pytest.mark.parametrize("original", [
    b'{"users": [{"userId": "u1", "encrypted_password": "gAAA',
    b"\xff\xfe",  # invalid UTF-8
    b"[]",
    b"null",
    b'{"users": null}',
    b'{"users": {"userId": "u1"}}',
    b'{"users": ["u1"]}',
])
def test_invalid_config_load_and_saves_preserve_original(tmp_path, fake_keyring, original):
    path = tmp_path / "config.json"
    path.write_bytes(original)
    store = ConfigStore(path=path)
    # Even an available master key must not allow replacing the invalid file.
    fake_keyring["store"][("songpa-loan-tracker", "__master__")] = Fernet.generate_key().decode()

    data = store.load()

    assert data == {"users": []}
    assert store.config_error
    assert path.read_bytes() == original
    for users in (data["users"], [{"userId": "new", "password": "secret"}]):
        with pytest.raises(ConfigReadError):
            store.save({}, users, dark_mode=True, ui_state={"sort_key": "이름"})
        assert path.read_bytes() == original
    assert fake_keyring["set_calls"] == []
    assert not path.with_name("config.json.tmp").exists()


def test_unreadable_config_load_and_save_preserve_original(tmp_path, fake_keyring, monkeypatch):
    store = make_store(tmp_path, make_encrypted_config(Fernet.generate_key(), "secret"))
    original = store.path.read_bytes()

    def fail_read(*args, **kwargs):
        raise PermissionError("access denied")

    monkeypatch.setattr(Path, "read_text", fail_read)
    assert store.load() == {"users": []}
    with pytest.raises(ConfigReadError):
        store.save({}, [])
    assert store.path.read_bytes() == original
    assert fake_keyring["set_calls"] == []


def test_config_corrupted_after_load_is_not_overwritten(tmp_path, fake_keyring):
    store = make_store(tmp_path, {"users": []})
    data = store.load()
    original = b'{"users": ["recoverable data"'
    store.path.write_bytes(original)

    with pytest.raises(ConfigReadError):
        store.save({}, data["users"])

    assert store.path.read_bytes() == original


def test_repaired_config_requires_reload_before_saving(tmp_path, fake_keyring):
    store = make_store(tmp_path)
    store.path.write_bytes(b'{"users":')
    assert store.load() == {"users": []}
    repaired = {"env": {}, "users": [{"userId": "restored"}], "dark_mode": True}
    store.path.write_text(json.dumps(repaired))

    # The empty fallback held by the old window must not erase restored users.
    with pytest.raises(ConfigReadError):
        store.save({}, [])
    assert json.loads(store.path.read_text()) == repaired

    data = store.load()
    assert store.config_error is None
    store.save({}, data["users"], dark_mode=True)
    assert json.loads(store.path.read_text())["users"] == [{"userId": "restored"}]


def test_write_is_atomic(tmp_path, fake_keyring, monkeypatch):
    store = make_store(tmp_path, {"env": {}, "users": []})
    original = store.path.read_text()

    import os as os_module

    real_replace = os_module.replace

    def fail_replace(*args, **kwargs):
        raise OSError("simulated crash")

    monkeypatch.setattr("src.config_store.os.replace", fail_replace)
    with pytest.raises(OSError):
        store.save({"A": "1"}, [])
    assert store.path.read_text() == original

    monkeypatch.setattr("src.config_store.os.replace", real_replace)
    store.save({"A": "1"}, [])
    assert json.loads(store.path.read_text())["env"] == {"A": "1"}
    assert list(tmp_path.glob("*.tmp")) == []


def test_cipher_failure_is_cached_to_avoid_prompt_spam(tmp_path, monkeypatch):
    calls = {"n": 0}

    def raise_error(*args, **kwargs):
        calls["n"] += 1
        raise keyring.errors.KeyringError("denied")

    monkeypatch.setattr(keyring, "get_password", raise_error)
    store = make_store(tmp_path, make_encrypted_config(Fernet.generate_key(), "pw"))

    store.load()
    with pytest.raises(KeychainAccessError):
        store._encrypt("x")
    assert calls["n"] == 1


def test_rotated_master_key_flags_users_for_reentry(tmp_path, fake_keyring):
    """마스터키가 바뀌어 복호화가 불가능하면 비밀번호는 비우되 재입력 대상으로 알린다."""
    config = make_encrypted_config(Fernet.generate_key(), "secret")
    store = make_store(tmp_path, config)
    fake_keyring["store"][("songpa-loan-tracker", "__master__")] = Fernet.generate_key().decode()

    data = store.load()

    assert data["users"][0]["password"] == ""
    assert store.decrypt_failed_users == ["u1"]
    assert store.keychain_error is None
    # ciphertext on disk untouched
    assert json.loads(store.path.read_text()) == config


def test_keyring_denied_is_not_flagged_as_decrypt_failure(tmp_path, monkeypatch):
    """키체인 접근 거부는 복구 가능한 상태라 재입력 안내 대상이 아니다."""
    deny(monkeypatch)
    store = make_store(tmp_path, make_encrypted_config(Fernet.generate_key(), "pw"))

    store.load()

    assert store.keychain_error
    assert store.decrypt_failed_users == []


def test_legacy_jenaonbot_config_is_migrated(tmp_path, monkeypatch, fake_keyring):
    """이전 이름(jenaonbot) 시절의 설정·마스터키가 새 위치로 옮겨진다."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    legacy_dir = tmp_path / ".jenaonbot"
    legacy_dir.mkdir()
    config = {"env": {}, "users": [{"userId": "u1", "encrypted_password": "x"}]}
    (legacy_dir / "config.json").write_text(json.dumps(config))
    old_key = Fernet.generate_key().decode()
    fake_keyring["store"][("jenaonbot", "__master__")] = old_key

    store = ConfigStore()

    assert store.path == tmp_path / ".songpa-loan-tracker" / "config.json"
    assert json.loads(store.path.read_text()) == config
    assert fake_keyring["store"][("songpa-loan-tracker", "__master__")] == old_key


def test_migration_does_not_overwrite_existing_config(tmp_path, monkeypatch, fake_keyring):
    """새 설정이 이미 있으면 레거시는 건드리지 않는다."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    new_dir = tmp_path / ".songpa-loan-tracker"
    new_dir.mkdir()
    new_config = {"env": {}, "users": []}
    (new_dir / "config.json").write_text(json.dumps(new_config))
    legacy_dir = tmp_path / ".jenaonbot"
    legacy_dir.mkdir()
    (legacy_dir / "config.json").write_text(json.dumps({"env": {}, "users": [{"userId": "u9"}]}))

    store = ConfigStore()

    assert json.loads(store.path.read_text()) == new_config
