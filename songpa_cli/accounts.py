"""계정 저장소.

계정 목록(이름·아이디)은 설정 폴더의 accounts.json(권한 600)에 둔다.
비밀번호는 OS 키체인(macOS·Windows의 keyring)을 쓸 수 있으면 키체인에, 아니면
(Termux·리눅스 서버 등) 같은 파일에 둔다. 파일에 둘 때는 이 기기 계정의 권한만으로
지켜지므로 README에 그렇게 밝힌다.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

KEYRING_SERVICE = "songpa-cli"
CONFIG_DIR_ENV = "SONGPA_CONFIG_DIR"
ACCOUNTS_FILENAME = "accounts.json"
PASSWORD_IN_KEYRING = "keyring"


class AccountError(Exception):
    """계정 설정을 읽거나 쓸 수 없을 때."""


def config_dir() -> Path:
    custom = os.environ.get(CONFIG_DIR_ENV)
    if custom:
        return Path(custom).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "songpa"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "songpa"


def _usable_keyring():
    """쓸 수 있는 OS 키체인 모듈. 설치 안 됐거나 쓸 수 있는 백엔드가 없으면 None."""
    try:
        import keyring
        from keyring.backends import fail
    except ImportError:
        return None
    try:
        backend = keyring.get_keyring()
    except Exception:
        return None
    if isinstance(backend, fail.Keyring) or getattr(backend, "priority", 1) <= 0:
        return None
    return keyring


class AccountStore:
    def __init__(self, directory: Path | None = None, keyring_module=None, use_keyring: bool = True):
        self.path = (directory or config_dir()) / ACCOUNTS_FILENAME
        if keyring_module is not None:
            self._keyring = keyring_module
        else:
            self._keyring = _usable_keyring() if use_keyring else None

    @property
    def uses_keyring(self) -> bool:
        return self._keyring is not None

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AccountError(f"계정 파일을 읽을 수 없습니다: {self.path} ({exc})") from exc
        accounts = data.get("accounts") if isinstance(data, dict) else None
        if not isinstance(accounts, list):
            raise AccountError(f"계정 파일 형식이 올바르지 않습니다: {self.path}")
        return [a for a in accounts if isinstance(a, dict) and a.get("userId")]

    def _write(self, accounts: list[dict]) -> None:
        folder = self.path.parent
        # 폴더 권한(700)은 이 코드가 만든 폴더에만 맞춘다. SONGPA_CONFIG_DIR로 이미 있는
        # 폴더(예: 홈 폴더)를 가리켰을 때 그 폴더 권한을 바꾸면 안 된다.
        if not folder.exists():
            folder.mkdir(parents=True)
            try:
                os.chmod(folder, 0o700)
            except OSError:
                pass
        # 중간에 끊겨도 기존 파일이 반쯤 지워지지 않게 임시 파일에 쓰고 바꿔 끼운다.
        tmp_path = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(fd, 0o600)  # 남아 있던 임시 파일에는 O_CREAT 권한이 적용되지 않는다.
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
                json.dump({"accounts": accounts}, fh, ensure_ascii=False, indent=2)
            os.replace(tmp_path, self.path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    def entries(self) -> list[dict]:
        """비밀번호를 뺀 계정 목록 [{label, userId, password_store}]."""
        return [
            {
                "label": a.get("label") or a["userId"],
                "userId": a["userId"],
                "password_store": a.get("password_store") or "file",
            }
            for a in self._read()
        ]

    def credentials(self, labels: list[str] | None = None) -> list[dict]:
        """조회에 쓸 [{label, userId, password}]. labels를 주면 그 이름(또는 아이디)만."""
        accounts = self._read()
        if labels:
            wanted = set(labels)
            unknown = wanted - {a.get("label") for a in accounts} - {a["userId"] for a in accounts}
            if unknown:
                raise AccountError(f"등록되지 않은 계정: {', '.join(sorted(unknown))}")
            accounts = [a for a in accounts if a.get("label") in wanted or a["userId"] in wanted]

        result = []
        for account in accounts:
            password = account.get("password", "")
            if account.get("password_store") == PASSWORD_IN_KEYRING:
                password = self._keyring_password(account["userId"])
            result.append({
                "label": account.get("label") or account["userId"],
                "userId": account["userId"],
                "password": password,
            })
        return result

    def _keyring_password(self, user_id: str) -> str:
        if self._keyring is None:
            raise AccountError(
                "비밀번호가 OS 키체인에 저장돼 있는데 키체인을 쓸 수 없습니다. "
                "`songpa accounts add`로 다시 등록해 주세요."
            )
        try:
            password = self._keyring.get_password(KEYRING_SERVICE, user_id)
        except Exception as exc:
            raise AccountError(f"키체인에서 비밀번호를 읽지 못했습니다: {exc}") from exc
        if not password:
            raise AccountError(
                f"키체인에 {user_id} 계정의 비밀번호가 없습니다. `songpa accounts add`로 다시 등록해 주세요."
            )
        return password

    def add(self, label: str, user_id: str, password: str) -> bool:
        """계정을 추가한다. 같은 아이디가 있으면 바꾸고 True를 돌려준다."""
        label, user_id = label.strip(), user_id.strip()
        if not label or not user_id or not password:
            raise AccountError("이름, 아이디, 비밀번호를 모두 입력해 주세요.")
        accounts = self._read()
        for account in accounts:
            if account.get("label") == label and account["userId"] != user_id:
                raise AccountError(f"'{label}' 이름은 다른 아이디가 이미 쓰고 있습니다.")

        entry = {"label": label, "userId": user_id}
        if self._keyring is not None:
            try:
                self._keyring.set_password(KEYRING_SERVICE, user_id, password)
                entry["password_store"] = PASSWORD_IN_KEYRING
            except Exception as exc:
                raise AccountError(f"키체인에 비밀번호를 저장하지 못했습니다: {exc}") from exc
        else:
            entry["password"] = password

        replaced = False
        for i, account in enumerate(accounts):
            if account["userId"] == user_id:
                accounts[i] = entry
                replaced = True
                break
        if not replaced:
            accounts.append(entry)
        self._write(accounts)
        return replaced

    def remove(self, label_or_id: str) -> dict:
        accounts = self._read()
        for i, account in enumerate(accounts):
            if label_or_id in (account.get("label"), account["userId"]):
                removed = accounts.pop(i)
                self._write(accounts)
                if removed.get("password_store") == PASSWORD_IN_KEYRING and self._keyring is not None:
                    try:
                        self._keyring.delete_password(KEYRING_SERVICE, removed["userId"])
                    except Exception:
                        pass
                return {"label": removed.get("label") or removed["userId"], "userId": removed["userId"]}
        raise AccountError(f"등록되지 않은 계정: {label_or_id}")
