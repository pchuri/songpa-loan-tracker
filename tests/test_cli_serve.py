import threading
import urllib.error
import urllib.request

import pytest

from songpa_cli.serve import make_server


@pytest.fixture
def server():
    srv = make_server(b"<html>ok</html>", "secret-token")
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def _get(server, path):
    return urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}{path}", timeout=5)


def test_serves_only_the_token_page(server):
    with _get(server, "/secret-token.html?t=1") as response:
        assert response.read() == b"<html>ok</html>"
        assert response.headers["Cache-Control"] == "no-store"

    for path in ("/", "/accounts.json", "/../accounts.json", "/secret-token.html/x", "/other.html"):
        with pytest.raises(urllib.error.HTTPError) as exc:
            _get(server, path)
        assert exc.value.code == 404


def test_listens_on_loopback_only(server):
    assert server.server_address[0] == "127.0.0.1"
