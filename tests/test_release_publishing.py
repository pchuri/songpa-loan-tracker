"""Publication state-machine regressions; no real GitHub mutation or credentials."""
import copy
import hashlib
import json
from pathlib import Path

import pytest

from scripts.publish_release import FILES, GitHub, PublicationError, publish, require_publish_context, validate_files

OLD, NEW, ANCIENT, NEXT = ('a' * 40, 'b' * 40, 'c' * 40, 'd' * 40)


@pytest.fixture
def inputs(tmp_path):
    (tmp_path / FILES[0]).write_bytes(b'dummy zip')
    (tmp_path / FILES[1]).write_text(hashlib.sha256(b'dummy zip').hexdigest() + '  ' + FILES[0] + '\n')
    (tmp_path / FILES[2]).write_text(json.dumps({'sha': NEW, 'version': '1.0.1', 'time': 'mac'}))
    (tmp_path / FILES[3]).write_bytes(b'dummy windows exe')
    (tmp_path / FILES[4]).write_text(json.dumps({'sha': NEW, 'version': '1.0.1', 'time': 'windows'}))
    return tmp_path


class FakeGitHub:
    def __init__(self):
        self.refs = {'latest-build': ANCIENT}
        self.releases = {1: {'id': 1, 'tag_name': 'latest-build', 'draft': False,
                            'assets': [{'name': 'version.json', 'url': 'old-version'}]}}
        self.payloads = {'old-version': json.dumps({'sha': OLD}).encode()}
        self.calls = []
        self.head_values = [NEW] * 10
        self.fail_at = None
        self.bad_digest = False
        self.sequence = 2

    def head(self):
        return self.head_values.pop(0)

    def ref(self, tag):
        return {'object': {'type': 'commit', 'sha': self.refs[tag]}} if tag in self.refs else None

    def release(self, tag):
        return copy.deepcopy(next((r for r in self.releases.values() if r['tag_name'] == tag), None))

    def require_forward(self, before, after):
        if before == NEXT or after != NEW:
            raise PublicationError('Refusing older publication')

    def ensure_tag(self, tag, sha):
        if tag in self.refs and self.refs[tag] != sha:
            raise PublicationError('Conflicting tag')
        self.refs[tag] = sha
        self.calls.append(('ensure_tag', tag))

    def upload(self, release, paths):
        self.calls.append(('upload', release['id']))
        if self.fail_at == 'upload':
            raise PublicationError('upload failure')
        assets = []
        for path in paths:
            raw = path.read_bytes()
            url = 'asset-' + path.name
            self.payloads[url] = raw
            assets.append({'name': path.name, 'url': url, 'state': 'uploaded', 'size': len(raw),
                           'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()})
        if self.bad_digest:
            assets[0]['digest'] = 'bad'
        self.releases[release['id']]['assets'] = assets

    def request(self, path, method='GET', data=None, optional=False, binary=False):
        if binary:
            return self.payloads[path]
        if method == 'GET':
            return copy.deepcopy(self.releases[int(path.split('/')[-1])])
        self.calls.append((method, path, copy.deepcopy(data)))
        if path == 'releases':
            release = dict(data, id=self.sequence, assets=[])
            self.sequence += 1
            self.releases[release['id']] = release
            return copy.deepcopy(release)
        if path.startswith('git/refs/'):
            assert data['force'] is False
            if self.fail_at == 'tag':
                raise PublicationError('tag update failure')
            self.refs['latest-build'] = data['sha']
            return self.ref('latest-build')
        release_id = int(path.split('/')[-1])
        if release_id == 1 and self.fail_at == 'archive':
            raise PublicationError('archive failure')
        if data.get('draft') is False and self.fail_at == 'publish':
            raise PublicationError('publish failure')
        self.releases[release_id].update(data)
        return copy.deepcopy(self.releases[release_id])


def test_stage_both_platforms_before_archiving_and_publish(inputs):
    api = FakeGitHub()
    assert publish(api, inputs, NEW) == 'published coherent latest-build'
    assert api.release('latest-build')['id'] == 2
    assert api.ref('latest-build')['object']['sha'] == NEW
    assert api.release('archive-' + OLD + '-1')['id'] == 1
    assert api.refs['archive-' + OLD + '-1'] == OLD
    assert len(api.release('latest-build')['assets']) == 6
    assert next(i for i,c in enumerate(api.calls) if c[0] == 'upload') < next(i for i,c in enumerate(api.calls) if c[0] == 'PATCH')


@pytest.mark.parametrize('name', FILES)
def test_missing_platform_input_cannot_mutate_release(inputs, name):
    (inputs / name).unlink()
    api = FakeGitHub()
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.calls == []


@pytest.mark.parametrize('corruption', ['sha', 'version', 'zip', 'checksum', 'empty', 'symlink'])
def test_mixed_or_corrupt_inputs_are_rejected(inputs, corruption):
    if corruption in ('sha', 'version'):
        path = inputs / FILES[2]
        data = json.loads(path.read_text())
        data[corruption] = OLD if corruption == 'sha' else '2.0.0'
        path.write_text(json.dumps(data))
    elif corruption == 'zip':
        (inputs / FILES[0]).write_bytes(b'changed')
    elif corruption == 'checksum':
        (inputs / FILES[1]).write_text('bad\n')
    elif corruption == 'empty':
        (inputs / FILES[3]).write_bytes(b'')
    else:
        path = inputs / FILES[3]
        real = inputs / 'outside.exe'
        path.rename(real)
        try:
            path.symlink_to(real)
        except OSError:
            pytest.skip('OS does not permit symlink creation')
    with pytest.raises(PublicationError):
        validate_files(inputs, NEW)


def test_stale_workflow_does_not_stage_or_publish(inputs):
    api = FakeGitHub()
    api.head_values = [NEXT]
    assert publish(api, inputs, NEW) == 'skipped stale workflow'
    assert api.calls == []


def test_main_advancing_during_upload_preserves_current_release(inputs):
    api = FakeGitHub()
    api.head_values = [NEW, NEXT]
    assert publish(api, inputs, NEW) == 'skipped stale workflow after staging'
    assert api.release('latest-build')['id'] == 1
    assert api.refs['latest-build'] == ANCIENT


@pytest.mark.parametrize('failure', ['upload', 'archive'])
def test_failure_before_archive_keeps_live_release_and_tag(inputs, failure):
    api = FakeGitHub()
    api.fail_at = failure
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.release('latest-build')['id'] == 1
    assert api.refs['latest-build'] == ANCIENT


@pytest.mark.parametrize('failure', ['tag', 'publish'])
def test_switch_failure_preserves_archive_and_draft_and_retry_finishes(inputs, failure):
    api = FakeGitHub()
    api.fail_at = failure
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.release('latest-build') is None
    assert api.release('archive-' + OLD + '-1')['id'] == 1
    assert api.release('build-' + NEW)['draft'] is True
    api.fail_at = None
    api.head_values = [NEW] * 10
    assert publish(api, inputs, NEW) == 'published coherent latest-build'


def test_bad_uploaded_digest_cannot_touch_live_release(inputs):
    api = FakeGitHub()
    api.bad_digest = True
    with pytest.raises(PublicationError, match='digest'):
        publish(api, inputs, NEW)
    assert api.release('latest-build')['id'] == 1


def test_older_run_cannot_replace_newer_published_commit(inputs):
    api = FakeGitHub()
    api.payloads['old-version'] = json.dumps({'sha': NEXT}).encode()
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.calls == []


def test_rerunning_same_published_sha_is_noop_even_with_new_build_timestamps(inputs):
    api = FakeGitHub()
    publish(api, inputs, NEW)
    api.calls.clear()
    api.head_values = [NEW] * 10
    path = inputs / 'version.json'
    data = json.loads(path.read_text())
    data['time'] = 'rerun'
    path.write_text(json.dumps(data))
    assert publish(api, inputs, NEW) == 'already published'
    assert api.calls == []


def test_publish_context_blocks_prs_and_local_invocations(monkeypatch):
    for key in ['GITHUB_ACTIONS', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_SHA', 'GH_TOKEN']:
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(PublicationError):
        require_publish_context(NEW)
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    monkeypatch.setenv('GITHUB_REF', 'refs/heads/main')
    monkeypatch.setenv('GITHUB_EVENT_NAME', 'pull_request')
    monkeypatch.setenv('GITHUB_SHA', NEW)
    with pytest.raises(PublicationError):
        require_publish_context(NEW)


def test_workflow_has_one_serialized_main_publisher_and_read_only_builds():
    workflow = (Path(__file__).parents[1] / '.github/workflows/build.yml').read_text()
    assert 'permissions:\n  contents: read' in workflow
    assert workflow.count('contents: write') == 1
    assert workflow.count('--publish') == 1
    assert 'gh release upload' not in workflow
    assert 'continue-on-error:' not in workflow
    windows = workflow.split('  build-windows:')[1].split('  verify-release:')[0]
    assert 'run: cp version.json dist/version.json' in windows
    assert '            dist/version.json' in windows
    publisher = workflow.split('  publish-release:')[1]
    assert "if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'" in publisher
    assert 'needs: [verify-release]' in publisher
    assert 'group: songpa-latest-build-publication' in publisher
    assert 'cancel-in-progress: false' in publisher


def test_api_authentication_is_not_forwarded_to_asset_redirects(monkeypatch):
    observed = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return b''
    def fake_open(request, **kwargs):
        observed.append(request)
        return Response()
    monkeypatch.setattr('urllib.request.urlopen', fake_open)
    assert GitHub('owner/repo', 'fake-secret').request('releases/assets/1', 'DELETE') is None
    assert 'Authorization' not in observed[0].headers
    assert observed[0].unredirected_hdrs['Authorization'] == 'Bearer fake-secret'
    GitHub('owner/repo', 'fake-secret').request('releases/assets/1', binary=True)
    import urllib.request
    redirected = urllib.request.HTTPRedirectHandler().redirect_request(observed[1], None, 302, '', {}, 'https://release-assets.githubusercontent.com/dummy')
    assert redirected.get_header('Authorization') is None
    with pytest.raises(PublicationError):
        GitHub('owner/repo', 'fake-secret').request('https://api.github.com@evil.example/data')


@pytest.mark.parametrize('heads', [[NEW, NEW, NEXT], [NEW, NEW, NEW, NEXT]])
def test_head_change_during_switch_fails_closed_with_archive_and_draft(inputs, heads):
    api = FakeGitHub()
    api.head_values = heads
    with pytest.raises(PublicationError, match='Main advanced'):
        publish(api, inputs, NEW)
    assert api.release('latest-build') is None
    assert api.release('archive-' + OLD + '-1') is not None
    assert api.release('build-' + NEW)['draft'] is True


def test_conflicting_build_tag_does_not_touch_alias(inputs):
    api = FakeGitHub()
    api.refs['build-' + NEW] = OLD
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.release('latest-build')['id'] == 1
    assert api.refs['latest-build'] == ANCIENT


def test_missing_legacy_metadata_requires_review_without_mutation(inputs):
    api = FakeGitHub()
    api.releases[1]['assets'] = []
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.calls == []


def test_immutable_release_requires_review_without_mutation(inputs):
    api = FakeGitHub()
    api.releases[1]['immutable'] = True
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.calls == []


def test_public_build_release_is_never_clobbered(inputs):
    api = FakeGitHub()
    api.releases[3] = {'id': 3, 'tag_name': 'build-' + NEW, 'draft': False, 'assets': []}
    with pytest.raises(PublicationError):
        publish(api, inputs, NEW)
    assert api.calls == []


def test_first_install_without_alias_creates_matching_ref_and_complete_release(inputs):
    api = FakeGitHub()
    api.refs.clear()
    api.releases.clear()
    assert publish(api, inputs, NEW) == 'published coherent latest-build'
    assert api.refs['latest-build'] == NEW


def test_corrupted_published_manifest_is_not_silently_replaced(inputs):
    api = FakeGitHub()
    publish(api, inputs, NEW)
    api.calls.clear()
    api.head_values = [NEW] * 10
    api.releases[2]['assets'][0]['digest'] = 'bad'
    with pytest.raises(PublicationError, match='integrity'):
        publish(api, inputs, NEW)
    assert api.calls == []


def test_release_creation_hints_do_not_require_historical_workflow_permissions(inputs):
    api = FakeGitHub()
    publish(api, inputs, NEW)
    release_writes = [c for c in api.calls if c[0] in ('POST', 'PATCH') and c[1].startswith('releases')]
    assert len(release_writes) == 3
    assert all(c[2]['target_commitish'] == 'main' for c in release_writes)
    assert api.refs['latest-build'] == NEW
    assert api.refs['archive-' + OLD + '-1'] == OLD
