import asyncio

import aiohttp

from songpa_core.config import CT, LOGIN_URL


class HttpError(Exception):
    """Base class for HTTP-related errors raised by this module."""


class FetchError(HttpError):
    """Raised when a request fails after exhausting retries."""


class AuthError(HttpError):
    """Raised when login fails or a session is no longer authenticated."""


_LOGIN_FAILURE_PATTERNS = (
    "비밀번호가 일치하지 않습니다",
    "회원번호가 일치하지 않습니다",
    "존재하지 않는 회원",
    "로그인에 실패",
    "회원정보가 없습니다",
    # 2026-08 현재 사이트가 실제로 내려주는 문구. 실패 응답도 HTTP 200에
    # JSESSIONID 쿠키까지 내려주므로, 이 목록이 실패를 걸러내는 유일한 방어선이다.
    "로그인 정보가 올바르지 않거나",
)


def _looks_like_login_failure(body: str) -> bool:
    return any(pattern in body for pattern in _LOGIN_FAILURE_PATTERNS)


async def login(userId, password, timeout=10):
    # 저장된 비밀번호가 복호화 실패 등으로 비어 있을 때 빈 값으로 로그인을
    # 시도하면 미인증 세션으로 이후 단계까지 흘러가 엉뚱한 오류로 보인다.
    if not password:
        raise AuthError("저장된 비밀번호가 없습니다. 설정에서 비밀번호를 다시 입력해 주세요.")

    data = {"userId": userId, "password": password}
    headers = {"Content-Type": CT}
    client_timeout = aiohttp.ClientTimeout(total=timeout)

    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        async with session.post(LOGIN_URL, data=data, headers=headers) as response:
            if response.status >= 400:
                raise AuthError(f"로그인 요청이 거부되었습니다 (HTTP {response.status})")
            body = await response.text()

        if _looks_like_login_failure(body):
            raise AuthError("회원번호 또는 비밀번호가 올바르지 않습니다.")

        cookies = '; '.join(f"{cookie.key}={cookie.value}" for cookie in session.cookie_jar)

    if not cookies:
        raise AuthError("로그인 세션 쿠키를 받지 못했습니다.")

    return cookies


async def fetch(url, session, max_retries=5, timeout=10):
    last_error: Exception | None = None
    for attempt in range(max_retries):
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as response:
                if response.status != 200:
                    raise FetchError(f"HTTP {response.status} from {url}")
                text = await response.text()
                if "<!-- footer -->" in text:
                    return text
                last_error = FetchError(f"Incomplete response from {url}: missing footer")
        except (aiohttp.ClientError, asyncio.TimeoutError, FetchError) as e:
            last_error = e

        if attempt < max_retries - 1:
            await asyncio.sleep(1)

    raise FetchError(f"Failed to fetch {url} after {max_retries} attempts") from last_error
