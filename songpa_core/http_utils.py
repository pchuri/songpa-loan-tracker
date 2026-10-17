from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.cookies import SimpleCookie
from urllib.parse import urljoin, urlparse

import aiohttp
from bs4 import BeautifulSoup

from songpa_core.config import CT, LOGIN_URL


class HttpError(Exception):
    """Base class for HTTP-related errors raised by this module."""


class FetchError(HttpError):
    """Raised when a request fails after exhausting retries."""


class AuthError(HttpError):
    """Raised when login fails or a session is no longer authenticated."""


class SessionError(AuthError):
    """세션이 바뀌었거나(쿠키 교체·리다이렉트·로그인 화면) 다른 페이지가 왔을 때.

    재시도해도 나아지지 않고, 같은 세션으로 계속 읽으면 다른 계정·빈 화면을 정상으로
    받아들일 수 있으므로 즉시 멈춘다. AuthError의 하위 클래스라 기존 except 절과 호환된다.
    """


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

FOOTER_MARKER = "<!-- footer -->"
LOGIN_FORM_ACTION_HINTS = ("memberloginproc", "memberlogin", "login.do", "loginform")


def _looks_like_login_failure(body: str) -> bool:
    return any(pattern in body for pattern in _LOGIN_FAILURE_PATTERNS)


def parse_cookie_header(cookie_header: str) -> dict:
    """'a=1; b=2' 형태의 Cookie 헤더를 dict로. 값은 로그에 남기지 않는다."""
    cookies = {}
    for part in (cookie_header or "").split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        if key:
            cookies[key] = value.strip()
    return cookies


def looks_like_login_page(text: str) -> bool:
    """로그인 화면(비밀번호 입력칸 또는 로그인 처리 폼)이면 True.

    실제 사이트 화면이 모든 페이지에 비밀번호 칸을 둔다면 이 검사는 조회를 막는 쪽으로
    실패한다. 잘못 통과하는 것보다 그쪽이 안전하다.
    """
    soup = BeautifulSoup(text or "", "html.parser")
    if soup.find("input", attrs={"type": lambda v: (v or "").lower() == "password"}):
        return True
    for form in soup.find_all("form"):
        action = (form.get("action") or "").lower()
        if any(hint in action for hint in LOGIN_FORM_ACTION_HINTS):
            return True
    return False


def _iter_response_set_cookies(response):
    """응답의 Set-Cookie를 (이름, 값, 속성 객체 또는 None)으로 내놓는다.

    aiohttp 응답은 SimpleCookie(Morsel)라 Max-Age/Expires 속성을 그대로 넘긴다.
    테스트용 가짜 응답의 {이름: 문자열} dict도 계속 받는다(속성 없음 -> None).
    """
    raw = getattr(response, "cookies", None)
    if raw is None:
        return
    if isinstance(raw, (SimpleCookie, dict)):
        for key, value in raw.items():
            attrs = value if hasattr(value, "value") and hasattr(value, "get") else None
            yield key, getattr(value, "value", value), attrs


def _response_set_cookies(response) -> dict:
    """응답의 Set-Cookie를 {이름: 값}으로. aiohttp 응답과 테스트용 가짜 응답 모두 지원."""
    return {key: value for key, value, _ in _iter_response_set_cookies(response)}


def _cookie_attr(attrs, name: str) -> str:
    if attrs is None:
        return ""
    try:
        value = attrs.get(name)
    except Exception:  # noqa: BLE001 - 속성을 못 읽으면 없는 것으로 본다
        return ""
    return str(value or "").strip()


def cookie_deletes_itself(attrs, now: datetime | None = None) -> bool:
    """Set-Cookie 속성이 쿠키 삭제(또는 판단할 수 없는 만료)를 뜻하면 True.

    Max-Age가 0 이하이거나, Expires가 이미 지났거나, 둘 중 하나를 해석할 수 없으면 True.
    판단할 수 없을 때 True를 돌려주는 것은 의도된 fail-closed 동작이다.
    """
    max_age = _cookie_attr(attrs, "max-age")
    if max_age:
        try:
            if int(max_age) <= 0:
                return True
        except ValueError:
            return True
        # 양수 Max-Age는 Expires보다 우선한다(RFC 6265 5.3).
        return False
    expires = _cookie_attr(attrs, "expires")
    if expires:
        try:
            when = parsedate_to_datetime(expires)
        except (TypeError, ValueError, IndexError):
            return True
        if when is None:
            return True
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return when <= (now or datetime.now(timezone.utc))
    return False


def check_cookie_rotation(response, pinned_cookies: dict | None) -> None:
    """고정한 세션 쿠키를 서버가 다른 값으로 바꾸거나 지우려 하면 SessionError.

    같은 값이라도 Max-Age<=0 이나 지난 Expires를 붙여 보내면 삭제이므로 SessionError다.
    오류 문구에 쿠키 이름·값을 넣지 않는다.
    """
    if not pinned_cookies:
        return
    for key, value, attrs in _iter_response_set_cookies(response):
        if key not in pinned_cookies:
            continue
        if value != pinned_cookies[key]:
            raise SessionError("세션 쿠키가 바뀌었습니다 (다른 기기 로그인 또는 세션 만료 가능). 결과를 쓰지 않습니다.")
        if cookie_deletes_itself(attrs):
            raise SessionError("서버가 세션 쿠키를 지웠습니다 (세션 만료 가능). 결과를 쓰지 않습니다.")


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str):
    """(scheme, host, port). 기본 포트는 채워 넣는다. 해석할 수 없으면 None."""
    parsed = urlparse(url or "")
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError:
        return None
    if port is None:
        port = _DEFAULT_PORTS.get(scheme)
    if not scheme or not host:
        return None
    return scheme, host, port


def _same_origin(a: str, b: str) -> bool:
    origin_a = _origin(a)
    return origin_a is not None and origin_a == _origin(b)


def _same_location(requested: str, final: str) -> bool:
    """scheme·호스트·포트(기본 포트 정규화)·경로가 모두 같아야 같은 위치로 본다."""
    return _same_origin(requested, final) and urlparse(requested).path == urlparse(final).path


async def login(userId, password, timeout=10):
    # 저장된 비밀번호가 복호화 실패 등으로 비어 있을 때 빈 값으로 로그인을
    # 시도하면 미인증 세션으로 이후 단계까지 흘러가 엉뚱한 오류로 보인다.
    if not password:
        raise AuthError("저장된 비밀번호가 없습니다. 설정에서 비밀번호를 다시 입력해 주세요.")

    data = {"userId": userId, "password": password}
    headers = {"Content-Type": CT}
    client_timeout = aiohttp.ClientTimeout(total=timeout)

    # 리다이렉트는 자동으로 따라가지 않는다. aiohttp는 307/308에서 자격증명이 담긴 본문을
    # Location으로 다시 POST하므로, 그 Location이 다른 호스트면 비밀번호가 그쪽으로 간다.
    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        async with session.post(LOGIN_URL, data=data, headers=headers, allow_redirects=False) as response:
            status, location, body = await _login_response_parts(response)

        current_url = LOGIN_URL
        redirected = False
        hops = 0
        while 300 <= status < 400:
            current_url = _login_redirect_target(current_url, status, location)
            hops += 1
            if hops > LOGIN_MAX_REDIRECTS:
                raise AuthError("로그인 응답의 이동이 너무 많습니다.")
            redirected = True
            # 같은 출처로의 301/302/303만, 자격증명 없이 GET으로 따라간다.
            async with session.get(current_url, allow_redirects=False) as response:
                status, location, body = await _login_response_parts(response)

        if status >= 400:
            raise AuthError(f"로그인 요청이 거부되었습니다 (HTTP {status})")
        if status < 200 or status >= 300:
            raise AuthError(f"로그인 응답을 해석할 수 없습니다 (HTTP {status})")

        if _looks_like_login_failure(body):
            raise AuthError("회원번호 또는 비밀번호가 올바르지 않습니다.")
        if redirected and looks_like_login_page(body):
            # 이동한 끝이 다시 로그인 화면이면 로그인되지 않은 것이다.
            raise AuthError("로그인 후 다시 로그인 화면으로 이동했습니다.")

        cookies = _site_cookie_header(session.cookie_jar, LOGIN_URL)

    if not cookies:
        raise AuthError("로그인 세션 쿠키를 받지 못했습니다.")

    # 한계: 실패 응답도 쿠키(JSESSIONID)를 주므로 쿠키가 있다는 것만으로 인증을 증명하지 못한다.
    # 실제 인증 여부는 이후 INDEX 조회(로그인 화면 검사·회원 표시 파싱)가 확인한다.
    return cookies


LOGIN_MAX_REDIRECTS = 5
_LOGIN_FOLLOWABLE_STATUSES = (301, 302, 303)


async def _login_response_parts(response):
    status = response.status
    headers = getattr(response, "headers", None) or {}
    location = headers.get("Location", "") or ""
    body = await response.text()
    return status, location, body


def _login_redirect_target(current_url: str, status: int, location: str) -> str:
    """로그인 응답의 이동 대상을 검사한다. 따라가도 되면 절대 URL, 아니면 AuthError.

    - 307/308은 자격증명을 다시 보내라는 뜻이라 대상과 무관하게 거부한다.
    - 301/302/303이라도 로그인 주소와 출처(scheme·호스트·포트)가 다르면 거부한다.
    오류 문구에 대상 주소를 넣지 않는다.
    """
    if status not in _LOGIN_FOLLOWABLE_STATUSES:
        raise AuthError(f"로그인 응답의 이동을 따라가지 않습니다 (HTTP {status}).")
    if not location:
        raise AuthError("로그인 응답이 이동 대상을 알려주지 않았습니다.")
    target = urljoin(current_url, location)
    if not _same_origin(LOGIN_URL, target):
        raise AuthError("로그인 응답이 다른 사이트로 이동시키려 해 중단했습니다.")
    return target


def _cookie_matches_host(cookie, host: str) -> bool:
    domain = _cookie_attr(cookie, "domain").lstrip(".").lower()
    if not domain:
        # aiohttp 쿠키 저장소는 항상 domain을 채운다. 비어 있으면 판단 근거가 없어 예전처럼 둔다.
        return True
    return host == domain or host.endswith("." + domain)


def _site_cookie_header(cookie_jar, url: str) -> str:
    """쿠키 저장소에서 url 호스트에 해당하는 쿠키만 'a=1; b=2'로."""
    host = (urlparse(url).hostname or "").lower()
    return '; '.join(
        f"{cookie.key}={cookie.value}" for cookie in cookie_jar if _cookie_matches_host(cookie, host)
    )


def validate_page(url: str, response_url: str, status: int, text: str) -> None:
    """목록·INDEX 페이지를 받아들이기 전의 검사. 실패하면 SessionError/FetchError.

    - 3xx(리다이렉트)는 세션 문제로 본다(SessionError, 재시도하지 않음)
    - 상태 200
    - 최종 URL의 scheme·호스트·포트·경로가 요청과 같음(로그인 화면 등으로 리다이렉트되지 않음)
    - 로그인 화면이 아님
    - footer 표시가 있음(잘린 응답이 아님)
    """
    if 300 <= status < 400:
        raise SessionError(f"요청한 페이지가 다른 곳으로 이동하라고 응답했습니다 (HTTP {status}, 세션 만료 가능).")
    if status != 200:
        raise FetchError(f"HTTP {status}")
    if response_url and not _same_location(url, response_url):
        raise SessionError("요청한 페이지가 아닌 다른 페이지로 이동했습니다 (세션 만료 가능).")
    if looks_like_login_page(text):
        raise SessionError("로그인 화면이 왔습니다 (세션 만료 가능).")
    if FOOTER_MARKER not in text:
        raise FetchError("응답이 완전하지 않습니다 (footer 없음).")


async def fetch(url, session, max_retries=5, timeout=10, pinned_cookies=None):
    """GET 후 검증된 본문을 돌려준다.

    네트워크 오류·잘린 응답만 재시도한다. 세션 문제(SessionError: 리다이렉트, 로그인 화면,
    쿠키 교체)는 재시도해도 같은 결과이거나 더 나쁘므로 바로 올린다. 읽기 전용 GET에만 쓴다.
    오류 문구에 쿠키·본문을 넣지 않는다.

    리다이렉트는 따라가지 않는다(allow_redirects=False). 세션 헤더에 고정한 Cookie가
    리다이렉트 대상 호스트로 먼저 나간 뒤에야 최종 URL을 검사하는 일이 없도록 하기 위함이다.
    """
    last_error: Exception | None = None
    for attempt in range(max_retries):
        try:
            async with session.get(
                url, timeout=aiohttp.ClientTimeout(total=timeout), allow_redirects=False
            ) as response:
                text = await response.text()
                check_cookie_rotation(response, pinned_cookies)
                validate_page(url, str(getattr(response, "url", "") or ""), response.status, text)
                return text
        except SessionError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, FetchError) as e:
            last_error = e

        if attempt < max_retries - 1:
            await asyncio.sleep(1)

    raise FetchError(f"Failed to fetch {url} after {max_retries} attempts") from last_error
