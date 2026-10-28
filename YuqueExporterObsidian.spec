# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    # Node.js 由构建脚本通过 --add-binary 注入，避免写死开发者本机路径。
    binaries=[],
    # 登录 Cookie 和本地配置必须由用户首次运行时生成，不能进入公开构建产物。
    datas=[('desktop', 'desktop'), ('src', 'src'), ('node_modules', 'node_modules'), ('package.json', '.')],
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
    # 正式构建由 build_windows_exe.ps1 提供临时 ICO 图标。
    icon=None,
)
