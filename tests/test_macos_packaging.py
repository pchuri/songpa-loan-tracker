"""Regression checks for artifact transfer flattening macOS framework links."""
import os
import plistlib
import shutil
from pathlib import Path

import pytest

from scripts.verify_macos_bundle import verify_round_trip


@pytest.fixture
def bundles(tmp_path):
    if os.name == "nt":
        pytest.skip("macOS bundle modes require POSIX filesystem semantics")
    original = tmp_path / "original" / "Test.app"
    contents = original / "Contents"
    binary = contents / "MacOS" / "Test"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"test executable")
    binary.chmod(0o755)
    (contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "Test"}))
    framework = contents / "Frameworks" / "QtCore.framework"
    version = framework / "Versions" / "A"
    (version / "Resources").mkdir(parents=True)
    (version / "QtCore").write_bytes(b"test framework")
    (version / "QtCore").chmod(0o755)
    try:
        (framework / "Versions/Current").symlink_to("A", target_is_directory=True)
        (framework / "QtCore").symlink_to("Versions/Current/QtCore")
        (framework / "Resources").symlink_to("Versions/Current/Resources", target_is_directory=True)
    except OSError:
        pytest.skip("Creating symlinks requires local OS privileges")
    extracted = tmp_path / "extracted" / "Test.app"
    shutil.copytree(original, extracted, symlinks=True)
    return original, extracted


def test_symlinks_modes_and_bytes_survive(bundles):
    verify_round_trip(*bundles)


def test_flattened_framework_is_rejected(bundles):
    original, extracted = bundles
    flattened = extracted.parent / "Flattened.app"
    shutil.copytree(original, flattened, symlinks=False)
    with pytest.raises(ValueError, match="Missing versioned framework symlinks"):
        verify_round_trip(original, flattened)


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable modes")
def test_lost_executable_permission_is_rejected(bundles):
    original, extracted = bundles
    (extracted / "Contents/MacOS/Test").chmod(0o644)
    with pytest.raises(ValueError, match="executable permission"):
        verify_round_trip(original, extracted)


def test_changed_resource_mode_is_rejected(bundles):
    original, extracted = bundles
    (extracted / "Contents/Info.plist").chmod(0o444)
    with pytest.raises(ValueError, match="Bundle changed during packaging"):
        verify_round_trip(original, extracted)


@pytest.mark.parametrize("change", ["bytes", "missing", "extra", "link"])
def test_archive_content_changes_are_rejected(bundles, change):
    original, extracted = bundles
    binary = extracted / "Contents/Frameworks/QtCore.framework/Versions/A/QtCore"
    if change == "bytes":
        binary.write_bytes(b"changed framework")
    elif change == "missing":
        (extracted / "Contents/Info.plist").rename(extracted / "Contents/Moved.plist")
    elif change == "extra":
        (extracted / "Contents/unexpected").write_text("extra")
    else:
        link = extracted / "Contents/Frameworks/QtCore.framework/QtCore"
        link.unlink()
        link.symlink_to("Versions/A/QtCore")
    with pytest.raises((ValueError, FileNotFoundError)):
        verify_round_trip(original, extracted)


@pytest.mark.parametrize("target", ["missing", "/outside", "../../../../../../outside"])
def test_broken_absolute_or_escaping_link_is_rejected(bundles, target):
    original, extracted = bundles
    (extracted / "Contents/unsafe").symlink_to(target)
    with pytest.raises(ValueError, match="symlink"):
        verify_round_trip(original, extracted)


def test_workflow_packages_and_verifies_before_upload():
    workflow = (Path(__file__).parents[1] / ".github/workflows/build.yml").read_text()
    macos = workflow.split("  build-windows:")[0]
    assert macos.index("Package and verify app bundle") < macos.index("Upload artifact")
    assert "path: dist/songpa-loan-tracker.app" not in macos
    assert "dist/songpa-loan-tracker-macos.zip" in macos
    assert "verify_macos_bundle.py" in macos
    assert macos.count("codesign --verify --deep --strict") == 2
    assert "if-no-files-found: error" in macos
    assert "continue-on-error:" not in macos
