import asyncio

import pytest

from songpa_core.http_utils import AuthError, _looks_like_login_failure, login


# 2026-08 실측: 잘못된 자격증명에 대한 응답 본문. HTTP 200에 JSESSIONID 쿠키까지
# 내려오므로 본문 문구 매칭이 실패를 걸러내는 유일한 방어선이다.
FAILURE_BODY_2026_08 = """
<script>
	try {window.top.fnLoadingHide();} catch (e) {}
</script>
	<script>
		alert("로그인 정보가 올바르지 않거나 가입된 회원이 아닙니다.");
	</script>
<form name="redirectForm" id="redirectForm" method="get" action="/intro/program/memberLogin.do" target="_top">
</form>
"""


def test_current_site_failure_message_is_recognized():
    assert _looks_like_login_failure(FAILURE_BODY_2026_08)


def test_login_with_empty_password_raises_before_any_request():
    """복호화 실패 등으로 비밀번호가 비면 미인증 세션으로 흘러가지 않고 즉시 실패한다."""
    with pytest.raises(AuthError):
        asyncio.run(login("someone", ""))
