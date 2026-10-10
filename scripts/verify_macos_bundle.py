"""Check that packaging preserved a PyInstaller macOS app without changing it.

This compares symlinks (without following them), POSIX modes, and file bytes.
CI separately verifies the original and extracted bundles with codesign. Neither
check is Developer ID signing, notarization, or a Gatekeeper override.
"""
import argparse
import hashlib
import os
import plistlib
import stat
from pathlib import Path


def bundle_snapshot(bundle: Path) -> dict:
    if bundle.is_symlink() or not bundle.is_dir():
        raise ValueError(f"Not an app directory: {bundle}")
    entries = {}

    def visit(path):
        relative = path.relative_to(bundle).as_posix()
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            target = os.readlink(path)
            if os.path.isabs(target):
                raise ValueError(f"Absolute symlink: {relative}")
            try:
                path.resolve(strict=True).relative_to(bundle.resolve())
            except (OSError, RuntimeError, ValueError) as exc:
                raise ValueError(f"Broken or escaping symlink: {relative}") from exc
            # Symlink permission bits are not meaningful on every platform.
            entries[relative] = ("link", target)
        elif stat.S_ISDIR(mode):
            entries[relative] = ("directory", stat.S_IMODE(mode))
            for child in sorted(path.iterdir()):
                visit(child)
        elif stat.S_ISREG(mode):
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            entries[relative] = ("file", stat.S_IMODE(mode), digest.hexdigest())
        else:
            raise ValueError(f"Unsupported bundle entry: {relative}")

    visit(bundle)
    with (bundle / "Contents/Info.plist").open("rb") as stream:
        executable = plistlib.load(stream)["CFBundleExecutable"]
    if not isinstance(executable, str) or not executable or Path(executable).name != executable:
        raise ValueError("Invalid CFBundleExecutable")
    executable_path = bundle / "Contents/MacOS" / executable
    if not executable_path.is_file() or not executable_path.stat().st_mode & 0o111:
        raise ValueError("Missing executable or executable permission")
    if not any(path.endswith(".framework/Versions/Current") and entry[0] == "link"
               for path, entry in entries.items()):
        raise ValueError("Missing versioned framework symlinks")
    return entries


def verify_round_trip(original: Path, extracted: Path) -> None:
    before, after = bundle_snapshot(original), bundle_snapshot(extracted)
    changed = sorted(path for path in before.keys() | after.keys()
                     if before.get(path) != after.get(path))
    if changed:
        raise ValueError("Bundle changed during packaging: " + ", ".join(changed[:10]))
    links = sum(entry[0] == "link" for entry in before.values())
    print(f"Bundle round trip verified: {len(before)} entries, {links} symlinks; modes and bytes match")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("extracted", type=Path)
    arguments = parser.parse_args()
    verify_round_trip(arguments.original, arguments.extracted)
