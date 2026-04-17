# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=[('C:\\Program Files\\nodejs\\node.exe', 'bin')],
    datas=[('desktop', 'desktop'), ('src', 'src'), ('node_modules', 'node_modules'), ('cookies.json', '.'), ('desktop.settings.json', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='YuqueExporterObsidian',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['D:\\01. 个人创作\\编程工具\\01. PC软件\\09.语雀笔记导出MD\\build\\app-icon.ico'],
)
