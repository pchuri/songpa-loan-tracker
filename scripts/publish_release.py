"""Stage complete desktop releases, then switch the compatible latest-build alias.

Default mode only validates local files. Publishing is restricted to main Actions
runs and must use the workflow's non-cancelling publication concurrency group.
"""
import argparse
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ALIAS = "latest-build"
FILES = (
    "songpa-loan-tracker-macos.zip",
    "songpa-loan-tracker-macos.zip.sha256",
    "songpa-loan-tracker-macos-build.json",
    "songpa-loan-tracker.exe",
    "version.json",
)


class PublicationError(RuntimeError):
    pass


def valid_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise PublicationError("Expected a full commit SHA")
    return value


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else hashlib.sha256(source.read()).hexdigest()


def validate_files(directory, sha):
    valid_sha(sha)
    paths = [directory / name for name in FILES]
    if any(not path.is_file() or path.is_symlink() or not path.stat().st_size for path in paths):
        raise PublicationError("Both complete, nonempty desktop artifacts are required")
    version = json.loads((directory / "version.json").read_text())
    mac = json.loads((directory / "songpa-loan-tracker-macos-build.json").read_text())
    if any(info.get("sha") != sha for info in (version, mac)):
        raise PublicationError("Artifact metadata does not match the workflow commit")
    if not isinstance(version.get("version"), str) or not version["version"] or mac.get("version") != version["version"]:
        raise PublicationError("Desktop artifact versions do not match")
    checksum = (directory / FILES[1]).read_text().split()
    if checksum != [digest(directory / FILES[0]), FILES[0]]:
        raise PublicationError("macOS ZIP checksum mismatch")
    manifest = {"sha": sha, "version": version["version"], "assets": {
        path.name: {"size": path.stat().st_size, "sha256": digest(path)} for path in paths
    }}
    manifest_path = directory / "release-manifest.json"
    if manifest_path.is_symlink():
        raise PublicationError("Manifest path must not be a symlink")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return paths + [manifest_path]


class GitHub:
    def __init__(self, repository, token):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            raise PublicationError("Invalid repository")
        self.base = f"https://api.github.com/repos/{repository}/"
        self.token = token

    def request(self, path, method="GET", data=None, optional=False, binary=False):
        url = path if path.startswith("https://") else self.base + path
        # Never send credentials to an arbitrary URL returned in metadata.
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc not in ("api.github.com", "uploads.github.com"):
            raise PublicationError("Untrusted GitHub API host")
        headers = {"Accept": "application/octet-stream" if binary else "application/vnd.github+json"}
        body = None
        if isinstance(data, bytes):
            body = data
            headers["Content-Type"] = "application/octet-stream"
        elif data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        # Authentication stays on the original API request, never a redirected asset host.
        request.add_unredirected_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            if optional and exc.code == 404:
                return None
            raise PublicationError(f"GitHub {method} failed with HTTP {exc.code}") from None
        return payload if binary else (json.loads(payload) if payload else None)

    def release(self, tag):
        # The tag endpoint can omit drafts; authenticated listing includes them.
        for page in range(1, 101):
            releases = self.request(f"releases?per_page=100&page={page}")
            for release in releases:
                if release["tag_name"] == tag:
                    return release
            if len(releases) < 100:
                return None
        raise PublicationError("Release pagination limit reached")

    def ref(self, tag):
        return self.request(f"git/ref/tags/{tag}", optional=True)

    def ensure_tag(self, tag, sha):
        ref = self.ref(tag)
        if ref is None:
            self.request("git/refs", "POST", {"ref": f"refs/tags/{tag}", "sha": sha})
        elif ref["object"].get("type") != "commit" or ref["object"].get("sha") != sha:
            raise PublicationError("Build tag already points to another commit")

    def head(self):
        return self.request("git/ref/heads/main")["object"]["sha"]

    def require_forward(self, before, after):
        valid_sha(before)
        if before != after and self.request(f"compare/{before}...{after}")["status"] != "ahead":
            raise PublicationError("Refusing an older or divergent publication")

    def upload(self, release, paths):
        url = release["upload_url"].split("{")[0]
        for path in paths:
            # Only drafts may be replaced on retry; never clobber live assets.
            assets = self.request(f"releases/{release['id']}/assets")
            for asset in assets:
                if asset["name"] == path.name:
                    self.request(f"releases/assets/{asset['id']}", "DELETE")
            self.request(url + "?name=" + urllib.parse.quote(path.name), "POST", path.read_bytes())


def verify_assets(release, paths):
    assets = {asset["name"]: asset for asset in release["assets"]}
    if len(assets) != len(release["assets"]) or set(assets) != {path.name for path in paths}:
        raise PublicationError("Staged asset set is incomplete or unexpected")
    for path in paths:
        asset = assets[path.name]
        if asset.get("state") != "uploaded" or asset.get("size") != path.stat().st_size or asset.get("digest") != "sha256:" + digest(path):
            raise PublicationError("Staged asset digest/size/state mismatch")


def previous_sha(api, release):
    assets = [a for a in release["assets"] if a["name"] == "version.json"]
    if len(assets) != 1:
        raise PublicationError("Cannot safely archive a release without unique version metadata")
    return valid_sha(json.loads(api.request(assets[0]["url"], binary=True))["sha"])


def publish(api, directory, sha):
    paths = validate_files(directory, sha)
    if api.head() != sha:
        return "skipped stale workflow"
    current = api.release(ALIAS)
    old_sha = previous_sha(api, current) if current else None
    if current and (current.get("draft") or current.get("immutable")):
        raise PublicationError("Existing alias must be a mutable published release")
    if old_sha:
        api.require_forward(old_sha, sha)
    ref = api.ref(ALIAS)
    if ref:
        if ref["object"].get("type") != "commit":
            raise PublicationError("Alias must be a lightweight commit tag")
        api.require_forward(ref["object"]["sha"], sha)
    if old_sha == sha and ref and ref["object"]["sha"] == sha:
        manifest_assets = [a for a in current["assets"] if a["name"] == "release-manifest.json"]
        if len(manifest_assets) == 1:
            raw = api.request(manifest_assets[0]["url"], binary=True)
            manifest = json.loads(raw)
            if manifest.get("sha") != sha or manifest.get("version") != json.loads((directory / "version.json").read_text())["version"]:
                raise PublicationError("Published manifest metadata mismatch")
            expected = dict(manifest["assets"])
            expected["release-manifest.json"] = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            actual = {a["name"]: a for a in current["assets"]}
            if set(expected) != set(FILES) | {"release-manifest.json"} or set(actual) != set(expected):
                raise PublicationError("Published asset set mismatch")
            for name, info in expected.items():
                if actual[name].get("state") != "uploaded" or actual[name].get("size") != info["size"] or actual[name].get("digest") != "sha256:" + info["sha256"]:
                    raise PublicationError("Published asset integrity mismatch")
            return "already published"
    tag = "build-" + sha
    candidate = api.release(tag)
    if candidate and not candidate["draft"]:
        raise PublicationError("Refusing to replace a published build release")
    api.ensure_tag(tag, sha)
    if not candidate:
        candidate = api.request("releases", "POST", {"tag_name": tag, "target_commitish": sha,
            "name": "Latest build", "body": f"Automated desktop build from {sha}.", "draft": True, "prerelease": True})
    api.upload(candidate, paths)
    candidate = api.request(f"releases/{candidate['id']}")
    verify_assets(candidate, paths)
    if api.head() != sha:
        return "skipped stale workflow after staging"
    if current:
        archive = f"archive-{old_sha}-{current['id']}"
        if api.release(archive):
            raise PublicationError("Archive release already exists; refusing to overwrite it")
        api.ensure_tag(archive, old_sha)
        api.request(f"releases/{current['id']}", "PATCH", {"tag_name": archive,
            "target_commitish": old_sha, "name": "Archived build " + old_sha[:12]})
    # There is now a deliberate alias gap, never a visible mixed asset set.
    # On failure the archived release and staged draft survive; rerun to finish.
    if api.head() != sha:
        raise PublicationError("Main advanced after archiving; archive and draft preserved")
    if ref:
        api.request("git/refs/tags/" + ALIAS, "PATCH", {"sha": sha, "force": False})
    else:
        api.ensure_tag(ALIAS, sha)
    if api.head() != sha:
        raise PublicationError("Main advanced during alias switch; archive and draft preserved")
    api.request(f"releases/{candidate['id']}", "PATCH", {"tag_name": ALIAS,
        "target_commitish": sha, "draft": False, "prerelease": True})
    live = api.release(ALIAS)
    if not live or live["id"] != candidate["id"] or live["draft"] or api.ref(ALIAS)["object"]["sha"] != sha:
        raise PublicationError("Published alias verification failed")
    verify_assets(live, paths)
    return "published coherent latest-build"


def require_publish_context(sha):
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch") or os.environ.get("GITHUB_SHA") != sha:
        raise PublicationError("Publishing is restricted to the exact main Actions commit")
    repository = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GH_TOKEN")
    if not repository or not token:
        raise PublicationError("Missing Actions repository/token")
    return repository, token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if args.publish:
        repository, token = require_publish_context(args.sha)
        print(publish(GitHub(repository, token), args.directory, args.sha))
    else:
        validate_files(args.directory, args.sha)
        print("Complete desktop artifacts and commit metadata verified; no remote changes")


if __name__ == "__main__":
    main()
