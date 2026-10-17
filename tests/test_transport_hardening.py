"""전송 계층 방어(리다이렉트 미추종, 세션 쿠키 삭제 감지, 로그인 이동 정책). 네트워크 없이 가짜 세션만 쓴다."""
import asyncio
from http.cookies import SimpleCookie

import pytest

from songpa_core import http_utils
from songpa_core.config import INDEX_URL, LOGIN_URL
from songpa_core.http_utils import (
    AuthError,
    SessionError,
    _same_location,
    check_cookie_rotation,
    fetch,
    login,
)

SECRET = "s3cr3t-session-value"
GOOD_PAGE = "<div>ok</div><!-- footer -->"


class FakeResponse:
    def __init__(self, status=200, url=None, text="", cookies=None, headers=None):
        self.status = status
        self.url = url
        self._text = text
        self.cookies = cookies if cookies is not None else {}
        self.headers = headers or {}

    async def text(self):
        return self._text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeGetSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


def _cookie(name, value, **attrs):
    jar = SimpleCookie()
    jar[name] = value
    for key, attr_value in attrs.items():
        jar[name][key.replace("_", "-")] = attr_value
    return jar


# --- fetch: 리다이렉트 ---------------------------------------------------------

@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_fetch_never_follows_redirects_and_does_not_retry_them(status):
    session = FakeGetSession([
        FakeResponse(status=status, url=INDEX_URL, headers={"Location": "https://evil.example/login"})
        for _ in range(3)
    ])

    with pytest.raises(SessionError):
        asyncio.run(fetch(INDEX_URL, session, max_retries=3, pinned_cookies={"JSESSIONID": SECRET}))

    assert len(session.calls) == 1
    url, kwargs = session.calls[0]
    assert url == INDEX_URL
    assert kwargs["allow_redirects"] is False
    assert "timeout" in kwargs


@pytest.mark.parametrize("final_url", [
    "https://evil.example/intro/index.do",
    "http://splib.or.kr/intro/index.do",
    "https://splib.or.kr:8443/intro/index.do",
    "https://splib.or.kr/intro/program/memberLogin.do",
])
def test_fetch_rejects_a_final_location_with_a_different_origin_or_path(final_url):
    session = FakeGetSession([FakeResponse(url=final_url, text=GOOD_PAGE) for _ in range(3)])

    with pytest.raises(SessionError):
        asyncio.run(fetch(INDEX_URL, session, max_retries=3))

    assert len(session.calls) == 1


def test_fetch_accepts_the_same_location_with_an_explicit_default_port():
    session = FakeGetSession([FakeResponse(url="https://splib.or.kr:443/intro/index.do", text=GOOD_PAGE)])

    assert asyncio.run(fetch(INDEX_URL, session, max_retries=1)) == GOOD_PAGE
    assert session.calls[0][1]["allow_redirects"] is False


def test_same_location_compares_scheme_host_port_and_path():
    assert _same_location("https://splib.or.kr/a", "https://SPLIB.or.kr:443/a")
    assert _same_location("http://splib.or.kr/a", "http://splib.or.kr:80/a")
    assert not _same_location("https://splib.or.kr/a", "http://splib.or.kr/a")
    assert not _same_location("https://splib.or.kr/a", "https://splib.or.kr:444/a")
    assert not _same_location("https://splib.or.kr/a", "https://splib.or.kr/b")
    assert not _same_location("https://splib.or.kr/a", "https://splib.or.kr:bad/a")


# --- 세션 쿠키 삭제 -------------------------------------------------------------

@pytest.mark.parametrize("attrs", [
    {"max_age": "0"},
    {"max_age": "-1"},
    {"expires": "Thu, 01 Jan 1970 00:00:00 GMT"},
    {"max_age": "not-a-number"},
    {"expires": "garbage"},
])
def test_same_valued_pinned_cookie_that_deletes_itself_is_a_session_error(attrs):
    response = FakeResponse(cookies=_cookie("JSESSIONID", SECRET, **attrs))

    with pytest.raises(SessionError) as excinfo:
        check_cookie_rotation(response, {"JSESSIONID": SECRET})

    assert SECRET not in str(excinfo.value)
    assert "JSESSIONID" not in str(excinfo.value)


@pytest.mark.parametrize("attrs", [
    {},
    {"max_age": "3600"},
    {"expires": "Fri, 01 Jan 2100 00:00:00 GMT"},
    {"path": "/", "httponly": True},
])
def test_same_valued_nonexpired_pinned_cookie_is_harmless(attrs):
    response = FakeResponse(cookies=_cookie("JSESSIONID", SECRET, **attrs))

    check_cookie_rotation(response, {"JSESSIONID": SECRET})


def test_expired_cookie_that_is_not_pinned_is_ignored():
    response = FakeResponse(cookies=_cookie("tracking", "x", max_age="0"))

    check_cookie_rotation(response, {"JSESSIONID": SECRET})


def test_legacy_plain_string_cookie_dicts_are_still_supported():
    check_cookie_rotation(FakeResponse(cookies={"JSESSIONID": SECRET}), {"JSESSIONID": SECRET})
    with pytest.raises(SessionError) as excinfo:
        check_cookie_rotation(FakeResponse(cookies={"JSESSIONID": "other"}), {"JSESSIONID": SECRET})
    assert SECRET not in str(excinfo.value)


def test_fetch_stops_without_retry_when_the_pinned_cookie_is_deleted():
    session = FakeGetSession([
        FakeResponse(url=INDEX_URL, text=GOOD_PAGE, cookies=_cookie("JSESSIONID", SECRET, max_age="0"))
        for _ in range(3)
    ])

    with pytest.raises(SessionError):
        asyncio.run(fetch(INDEX_URL, session, max_retries=3, pinned_cookies={"JSESSIONID": SECRET}))

    assert len(session.calls) == 1


# --- 로그인 이동 정책 -------------------------------------------------------------

def _jar(*cookies):
    morsels = []
    for name, value, domain in cookies:
        jar = SimpleCookie()
        jar[name] = value
        jar[name]["domain"] = domain
        morsels.append(jar[name])
    return morsels


class FakeLoginSession:
    def __init__(self, post_response, get_responses=(), cookie_jar=None):
        self.post_response = post_response
        self.get_responses = list(get_responses)
        self.cookie_jar = cookie_jar if cookie_jar is not None else _jar(("JSESSIONID", "abc", "splib.or.kr"))
        self.posts = []
        self.gets = []

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return self.post_response

    def get(self, url, **kwargs):
        self.gets.append((url, kwargs))
        return self.get_responses.pop(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def fake_login_session(monkeypatch):
    holder = {}

    def install(session):
        holder["session"] = session
        monkeypatch.setattr(http_utils.aiohttp, "ClientSession", lambda *a, **k: session)
        return session

    return install


SUCCESS_BODY = "<script>location.href='/intro/index.do';</script>"


def test_login_success_returns_site_cookies_and_never_auto_follows(fake_login_session):
    session = fake_login_session(FakeLoginSession(FakeResponse(text=SUCCESS_BODY)))

    assert asyncio.run(login("user", "pw")) == "JSESSIONID=abc"
    assert session.posts[0][0] == LOGIN_URL
    assert session.posts[0][1]["allow_redirects"] is False
    assert session.gets == []


@pytest.mark.parametrize("status", [307, 308])
def test_login_never_resends_credentials_on_307_or_308(fake_login_session, status):
    for location in ("https://evil.example/steal", "/intro/program/memberLoginProc2.do"):
        session = fake_login_session(FakeLoginSession(
            FakeResponse(status=status, headers={"Location": location})))

        with pytest.raises(AuthError) as excinfo:
            asyncio.run(login("user", "pw"))

        assert len(session.posts) == 1
        assert session.gets == []
        assert "evil.example" not in str(excinfo.value)


def test_login_refuses_a_redirect_to_another_origin(fake_login_session):
    for location in ("https://evil.example/", "http://splib.or.kr/intro/index.do",
                     "https://splib.or.kr:8443/intro/index.do"):
        session = fake_login_session(FakeLoginSession(
            FakeResponse(status=302, headers={"Location": location})))

        with pytest.raises(AuthError):
            asyncio.run(login("user", "pw"))

        assert session.gets == []


def test_login_follows_a_same_origin_302_with_get_and_no_credentials(fake_login_session):
    session = fake_login_session(FakeLoginSession(
        FakeResponse(status=302, headers={"Location": "/intro/index.do"}),
        get_responses=[FakeResponse(text="<div>main</div>")],
    ))

    assert asyncio.run(login("user", "pw")) == "JSESSIONID=abc"
    assert len(session.gets) == 1
    url, kwargs = session.gets[0]
    assert url == "https://splib.or.kr/intro/index.do"
    assert kwargs.get("allow_redirects") is False
    assert "data" not in kwargs


def test_login_redirect_that_lands_on_the_login_form_is_a_failure(fake_login_session):
    fake_login_session(FakeLoginSession(
        FakeResponse(status=302, headers={"Location": "/intro/program/memberLogin.do"}),
        get_responses=[FakeResponse(text='<form action="/intro/program/memberLoginProc.do">'
                                         '<input type="password" name="password"></form>')],
    ))

    with pytest.raises(AuthError):
        asyncio.run(login("user", "pw"))


def test_login_documented_failure_body_with_cookie_is_still_a_failure(fake_login_session):
    # test_login.py의 2026-08 실측 실패 본문과 같은 문구(HTTP 200 + 쿠키).
    failure_body = (
        '<script>alert("로그인 정보가 올바르지 않거나 가입된 회원이 아닙니다.");</script>'
        '<form name="redirectForm" method="get" action="/intro/program/memberLogin.do" target="_top"></form>'
    )
    fake_login_session(FakeLoginSession(FakeResponse(text=failure_body)))

    with pytest.raises(AuthError):
        asyncio.run(login("user", "pw"))


def test_login_ignores_cookies_for_other_hosts(fake_login_session):
    fake_login_session(FakeLoginSession(
        FakeResponse(text=SUCCESS_BODY),
        cookie_jar=_jar(("tracker", "zzz", "evil.example")),
    ))

    with pytest.raises(AuthError):
        asyncio.run(login("user", "pw"))


def test_login_too_many_same_origin_redirects_fail_closed(fake_login_session):
    loop_response = [FakeResponse(status=302, headers={"Location": "/intro/loop.do"}) for _ in range(10)]
    fake_login_session(FakeLoginSession(loop_response[0], get_responses=loop_response[1:]))

    with pytest.raises(AuthError):
        asyncio.run(login("user", "pw"))
