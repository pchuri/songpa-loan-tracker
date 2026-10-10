import errno
import json
import logging
import os
import shutil
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import keyring
import keyring.errors
from cryptography.fernet import Fernet, InvalidToken


KEYRING_SERVICE = "songpa-loan-tracker"
MASTER_KEY_USERNAME = "__master__"
CONFIG_DIRNAME = ".songpa-loan-tracker"
# 이전 이름(jenaonbot) 시절의 설정 위치. 첫 실행 시 자동 마이그레이션된다.
LEGACY_KEYRING_SERVICE = "jenaonbot"
LEGACY_CONFIG_DIRNAME = ".jenaonbot"

logger = logging.getLogger(__name__)

_CONFIG_FIELDS = {"users", "env", "auto_refresh_interval", "dark_mode", "ui_state"}
_LOCK_TIMEOUT_SECONDS = 2.0


def _account_id(user: dict) -> str:
    # The original config format used label for the login ID.
    return (user.get("userId") or user.get("label") or "").strip()


def _env_section(data: dict) -> dict:
    return data.get("env", {k: v for k, v in data.items() if k not in _CONFIG_FIELDS})


def _validate_config(data: dict) -> None:
    """Reject lossy/unsafe shapes before decrypting, migrating, or normalizing."""
    if not isinstance(data, dict):
        raise ValueError("config must be a JSON object")
    users = data.get("users", [])
    if not isinstance(users, list) or any(not isinstance(u, dict) for u in users):
        raise ValueError("users must be a list of objects")
    seen = set()
    for user in users:
        for field in ("userId", "label"):
            if user.get(field) is not None:
                if not isinstance(user[field], str):
                    raise ValueError(f"{field} must be a string")
                user[field].encode("utf-8")
        user_id = _account_id(user)
        if not user_id or user_id in seen:
            raise ValueError("each user needs a unique nonempty userId or legacy label")
        seen.add(user_id)
        for field in ("password", "encrypted_password"):
            if field in user:
                if not isinstance(user[field], str):
                    raise ValueError(f"{field} must be a string")
                user[field].encode("utf-8")
    env = _env_section(data)
    if not isinstance(env, dict):
        raise ValueError("env must be an object")
    for key, value in env.items():
        key.encode("utf-8")
        if not key or "=" in key or "\0" in key:
            raise ValueError("env keys must be valid environment variable names")
        if value is not None and (not isinstance(value, str) or "\0" in value):
            raise ValueError("env values must be strings or null")
        if value is not None:
            value.encode("utf-8")
    interval = data.get("auto_refresh_interval", 0)
    if type(interval) is not int or interval not in (0, 5, 10, 30, 60):
        raise ValueError("auto_refresh_interval must be a supported interval")
    if type(data.get("dark_mode", False)) is not bool:
        raise ValueError("dark_mode must be a boolean")
    state = data.get("ui_state", {})
    if not isinstance(state, dict):
        raise ValueError("ui_state must be an object")
    for field in ("sort_key", "reservation_sort_key"):
        if field in state and not isinstance(state[field], str):
            raise ValueError(f"ui_state.{field} must be a string")
    for field in ("selected_user", "reservation_selected_user", "tier_filter"):
        if state.get(field) is not None and not isinstance(state[field], str):
            raise ValueError(f"ui_state.{field} must be a string or null")
    if "interlibrary_only" in state and type(state["interlibrary_only"]) is not bool:
        raise ValueError("ui_state.interlibrary_only must be a boolean")


class KeychainAccessError(Exception):
    """The OS keychain denied or failed access to the master key."""


class ConfigReadError(Exception):
    """Config I/O failed; further saves require an explicit successful reload."""


class ConfigStore:
    def __init__(self, path: Path | None = None):
        migrate_legacy = path is None
        if path is None:
            path = Path.home() / CONFIG_DIRNAME / "config.json"
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.path.parent, 0o700)
        except OSError:
            pass
        self._cipher: Fernet | None = None
        self.keychain_error: str | None = None
        self.config_error: str | None = None
        # 마스터키 불일치(InvalidToken)로 복호화에 실패한 userId 목록.
        # 이 비밀번호들은 복구가 불가능하므로 UI가 재입력을 안내해야 한다.
        self.decrypt_failed_users: list[str] = []
        if migrate_legacy:
            try:
                with self._transaction():
                    self._migrate_legacy()
            except ConfigReadError:
                logger.warning("Legacy migration could not obtain the config lock")

    @contextmanager
    def _transaction(self):
        # Lock a stable sidecar, never the config inode replaced by _write. Keep this
        # file after unlocking: deleting it would let processes lock different inodes.
        fd = None
        locked = False
        try:
            try:
                fd = os.open(self.path.with_name(self.path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
                deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
                while True:
                    try:
                        if os.name == "nt":
                            import msvcrt
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        locked = True
                        break
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                            raise
                        if time.monotonic() >= deadline:
                            raise TimeoutError("config is busy in another app instance") from exc
                        time.sleep(0.05)
            except OSError as exc:
                self.config_error = f"{self.path}: {exc}"
                raise ConfigReadError(self.config_error) from exc
            yield
        finally:
            if fd is not None:
                try:
                    if locked:
                        if os.name == "nt":
                            import msvcrt
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)

    def _migrate_legacy(self) -> None:
        """이전 이름(jenaonbot) 시절의 설정·마스터키를 새 위치로 옮긴다.

        Best-effort: 실패해도 앱 실행은 계속되며, 기존 설정은 건드리지 않는다.
        """
        new_cfg = Path.home() / CONFIG_DIRNAME / "config.json"
        old_cfg = Path.home() / LEGACY_CONFIG_DIRNAME / "config.json"
        if not new_cfg.exists() and old_cfg.exists():
            try:
                new_cfg.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(old_cfg, new_cfg)
                os.chmod(new_cfg, 0o600)
            except OSError:
                logger.warning("Legacy config migration failed", exc_info=True)
        try:
            if not keyring.get_password(KEYRING_SERVICE, MASTER_KEY_USERNAME):
                old_key = keyring.get_password(
                    LEGACY_KEYRING_SERVICE, MASTER_KEY_USERNAME
                )
                if old_key:
                    keyring.set_password(
                        KEYRING_SERVICE, MASTER_KEY_USERNAME, old_key
                    )
        except Exception:  # noqa: BLE001 - migration must never block startup
            logger.warning("Legacy keyring migration failed", exc_info=True)

    def _fail_keychain(self, message: str) -> KeychainAccessError:
        self.keychain_error = message
        logger.error("Keychain unavailable: %s", message)
        return KeychainAccessError(message)

    def _has_encrypted_passwords(self) -> bool:
        if not self.path.exists():
            return False
        try:
            data = json.loads(self.path.read_text())
        except (OSError, UnicodeError, json.JSONDecodeError):
            # An unreadable or corrupt config may still hold ciphertext; stay
            # conservative so the master key is never regenerated over it.
            return True
        users = data.get("users", []) if isinstance(data, dict) else None
        if not isinstance(users, list):
            return True
        return any(isinstance(u, dict) and u.get("encrypted_password") for u in users)

    def _get_cipher(self) -> Fernet:
        if self._cipher is not None:
            return self._cipher
        if self.keychain_error is not None:
            # Every keychain attempt can trigger an ACL prompt; once access has
            # failed this session, don't retry until the next load (app restart).
            raise KeychainAccessError(self.keychain_error)
        try:
            key = keyring.get_password(KEYRING_SERVICE, MASTER_KEY_USERNAME)
        except keyring.errors.KeyringError as exc:
            raise self._fail_keychain(f"keychain read denied or locked: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - backend failures must never crash the app
            raise self._fail_keychain(f"keychain read failed: {exc}") from exc
        if not key:
            if self._has_encrypted_passwords():
                # keyring reports no key, yet encrypted passwords exist on disk.
                # That usually means the read was denied rather than the key being
                # gone; generating a new key would orphan the stored passwords.
                raise self._fail_keychain(
                    "master key not readable while encrypted passwords exist; "
                    "refusing to generate a new key"
                )
            key = Fernet.generate_key().decode()
            try:
                keyring.set_password(KEYRING_SERVICE, MASTER_KEY_USERNAME, key)
            except Exception as exc:  # noqa: BLE001
                raise self._fail_keychain(f"keychain write failed: {exc}") from exc
        self._cipher = Fernet(key.encode())
        return self._cipher

    def _encrypt(self, plaintext: str) -> str:
        return self._get_cipher().encrypt(plaintext.encode()).decode()

    def _decrypt(self, ciphertext: str) -> str:
        try:
            return self._get_cipher().decrypt(ciphertext.encode()).decode()
        except InvalidToken:
            logger.warning("Failed to decrypt stored password; entry left untouched")
            return ""

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            _validate_config(data)
            return data
        except FileNotFoundError:
            return {}
        except (OSError, UnicodeError, ValueError) as exc:
            self.config_error = f"{self.path}: {exc}"
            logger.error("Config read failed; original file preserved: %s", self.config_error)
            raise ConfigReadError(self.config_error) from exc

    def _write(self, data: dict) -> None:
        # Atomic replace: a crash mid-write must not truncate the config,
        # which holds the only copy of the encrypted passwords.
        payload = json.dumps(data, indent=2)
        tmp_path = None
        try:
            fd, name = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
            tmp_path = Path(name)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, self.path)
        except BaseException as exc:
            if tmp_path is not None:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    # A leftover unique temp file cannot affect the config or
                    # the next writer. Report the original storage failure.
                    logger.warning("Could not remove uncommitted config temporary file")
            if isinstance(exc, OSError):
                self.config_error = f"{self.path}: {exc}"
                raise ConfigReadError(self.config_error) from exc
            raise

    def load(self) -> dict:
        self.keychain_error = None
        self.config_error = None
        self.decrypt_failed_users = []
        try:
            with self._transaction():
                return self._load_locked()
        except ConfigReadError:
            # Keep the app usable, but never treat this fallback as a new setup.
            # All saves remain blocked until a successful explicit reload.
            return {"users": []}

    def _load_locked(self) -> dict:
        data = self._read()
        users = data.get("users", [])

        migrated = False
        for user in users:
            if user.get("password"):
                try:
                    user["encrypted_password"] = self._encrypt(user["password"])
                except KeychainAccessError:
                    continue
                del user["password"]
                migrated = True
        if migrated:
            self._write(data)

        for user in users:
            enc = user.pop("encrypted_password", None)
            if not enc:
                user.setdefault("password", "")
                continue
            try:
                user["password"] = self._decrypt(enc)
            except KeychainAccessError:
                # An entry can carry both fields when migration was skipped;
                # keep the plaintext that survived instead of blanking it.
                user.setdefault("password", "")
                continue
            if not user["password"]:
                # _decrypt returns "" only on InvalidToken: ciphertext exists
                # but the master key no longer matches. Unrecoverable.
                self.decrypt_failed_users.append(user.get("userId") or "?")

        data["users"] = users
        return data

    def save(
        self,
        env: dict,
        users: list[dict],
        auto_refresh_interval: int = 0,
        dark_mode: bool = False,
        ui_state: dict | None = None,
    ) -> None:
        if self.config_error is not None:
            raise ConfigReadError(self.config_error)
        with self._transaction():
            existing = self._read()
            existing_users = {
                _account_id(u): u
                for u in existing.get("users", [])
                if isinstance(u, dict)
            }

            serialized_users = []
            for user in users:
                user_id = _account_id(user)
                user_out = {"userId": user_id}
                pw = user.get("password", "")
                encrypted = None
                if pw:
                    try:
                        encrypted = self._encrypt(pw)
                    except KeychainAccessError:
                        pass
                if encrypted:
                    user_out["encrypted_password"] = encrypted
                else:
                    # Can't encrypt (no plaintext in memory, or keychain access
                    # denied): keep whatever credential was already stored —
                    # ciphertext and/or a not-yet-migrated plaintext — instead of
                    # dropping it. New plaintext is never written to disk.
                    prev = existing_users.get(user_id, {})
                    if prev.get("encrypted_password"):
                        user_out["encrypted_password"] = prev["encrypted_password"]
                    if prev.get("password"):
                        user_out["password"] = prev["password"]
                serialized_users.append(user_out)

            payload = {
                "env": env,
                "users": serialized_users,
                "auto_refresh_interval": auto_refresh_interval,
                "dark_mode": dark_mode,
            }
            if ui_state is not None:
                payload["ui_state"] = ui_state
            elif "ui_state" in existing:
                payload["ui_state"] = existing["ui_state"]
            self._write(payload)

    def apply_env(self, data: dict | None = None) -> None:
        payload = data if data is not None else self._read()
        env_section = _env_section(payload)
        for key, value in env_section.items():
            if value is None:
                continue
            os.environ[key] = value
