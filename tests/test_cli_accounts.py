import json
import os
import stat

import pytest

from songpa_cli.accounts import KEYRING_SERVICE, AccountError, AccountStore


class FakeKeyring:
    def __init__(self):
        self.store = {}

    def set_password(self, service, user, password):
        self.store[(service, user)] = password

    def get_password(self, service, user):
        return self.store.get((service, user))

    def delete_password(self, service, user):
        self.store.pop((service, user), None)


def test_file_store_keeps_password_in_a_private_file(tmp_path):
    store = AccountStore(tmp_path, use_keyring=False)

    assert store.add("홍길동", "hong", "secret") is False

    data = json.loads(store.path.read_text(encoding="utf-8"))
    assert data == {"accounts": [{"label": "홍길동", "userId": "hong", "password": "secret"}]}
    if os.name != "nt":
        assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
        assert stat.S_IMODE(store.path.parent.stat().st_mode) == 0o700
    assert store.credentials() == [{"label": "홍길동", "userId": "hong", "password": "secret"}]


def test_keyring_store_never_writes_the_password_to_the_file(tmp_path):
    keyring = FakeKeyring()
    store = AccountStore(tmp_path, keyring_module=keyring)

    store.add("홍길동", "hong", "secret")

    assert "secret" not in store.path.read_text(encoding="utf-8")
    assert keyring.store[(KEYRING_SERVICE, "hong")] == "secret"
    assert store.credentials()[0]["password"] == "secret"
    assert store.entries() == [{"label": "홍길동", "userId": "hong", "password_store": "keyring"}]


def test_adding_the_same_id_replaces_the_account(tmp_path):
    store = AccountStore(tmp_path, use_keyring=False)
    store.add("길동", "hong", "old")

    assert store.add("홍길동", "hong", "new") is True

    assert store.credentials() == [{"label": "홍길동", "userId": "hong", "password": "new"}]


def test_a_label_cannot_point_at_two_ids(tmp_path):
    store = AccountStore(tmp_path, use_keyring=False)
    store.add("홍길동", "hong", "pw")

    with pytest.raises(AccountError):
        store.add("홍길동", "other", "pw")


@pytest.mark.parametrize("label,user_id,password", [("", "id", "pw"), ("이름", " ", "pw"), ("이름", "id", "")])
def test_missing_fields_are_rejected(tmp_path, label, user_id, password):
    with pytest.raises(AccountError):
        AccountStore(tmp_path, use_keyring=False).add(label, user_id, password)


def test_credentials_can_be_filtered_by_label_or_id(tmp_path):
    store = AccountStore(tmp_path, use_keyring=False)
    store.add("홍길동", "hong", "a")
    store.add("김영희", "kim", "b")
    store.add("이철수", "lee", "c")

    assert [c["label"] for c in store.credentials(["김영희", "lee"])] == ["김영희", "이철수"]
    with pytest.raises(AccountError):
        store.credentials(["없는사람"])


def test_remove_also_deletes_the_keyring_entry(tmp_path):
    keyring = FakeKeyring()
    store = AccountStore(tmp_path, keyring_module=keyring)
    store.add("홍길동", "hong", "secret")

    assert store.remove("홍길동") == {"label": "홍길동", "userId": "hong"}

    assert store.entries() == []
    assert keyring.store == {}
    with pytest.raises(AccountError):
        store.remove("홍길동")


def test_keyring_password_without_keyring_explains_how_to_recover(tmp_path):
    AccountStore(tmp_path, keyring_module=FakeKeyring()).add("홍길동", "hong", "secret")

    with pytest.raises(AccountError, match="accounts add"):
        AccountStore(tmp_path, use_keyring=False).credentials()


def test_broken_file_is_reported_not_overwritten(tmp_path):
    (tmp_path / "accounts.json").write_text("{broken", encoding="utf-8")

    with pytest.raises(AccountError):
        AccountStore(tmp_path, use_keyring=False).add("홍길동", "hong", "pw")
    assert (tmp_path / "accounts.json").read_text(encoding="utf-8") == "{broken"
