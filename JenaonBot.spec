# -*- mode: python ; coding: utf-8 -*-

import os

block_cipher = None

# Ad-hoc signing gives the bundle a new identity on every rebuild, so macOS
# re-prompts for keychain access and "Always Allow" never sticks. Signing with a
# stable identity fixes that, but the identity only exists on the developer's
# machine — CI has none, so this stays opt-in via the environment.
codesign_identity = os.environ.get("CODESIGN_IDENTITY") or None
# PyInstaller signs with the hardened runtime enabled; see the plist for why
# library validation has to be turned off for a self-signed identity.
entitlements_file = "resources/entitlements.plist" if codesign_identity else None

a = Analysis(
    ['src/main_app.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'core',
        'core.config',
        'core.splib',
        'core.splib_utils',
        'core.http_utils',
        'src',
        'src.book_status',
        'src.config_store',
        'src.main_window',
        'src.reservation_status',
        'src.styles',
        'src.widgets',
        'src.widgets.book_card',
        'src.widgets.elided_label',
        'src.widgets.flow_layout',
        'src.widgets.reservation_card',
        'src.widgets.summary_bar',
        'src.widgets.user_filter_bar',
        'keyring.backends.macOS',
        'keyring.backends.Windows',
        'keyring.backends.SecretService',
        'keyring.backends.chainer',
        'keyring.backends.fail',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='JenaonBot',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=codesign_identity,
    entitlements_file=entitlements_file,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='JenaonBot',
)

app = BUNDLE(
    coll,
    name='JenaonBot.app',
    icon='resources/jenaonbot.icns',
    bundle_identifier='com.jenaonbot.desktop',
    info_plist={
        'NSPrincipalClass': 'NSApplication',
        'NSHighResolutionCapable': 'True',
        'CFBundleShortVersionString': '1.0.0',
        'CFBundleVersion': '1.0.0',
        'NSHumanReadableCopyright': 'Copyright © 2025',
    },
)
