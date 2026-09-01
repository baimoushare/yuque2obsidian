"""生成可手动上传宝塔的 OTA 静态发布目录，不保存服务器凭据。"""

import argparse
import base64
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.hazmat.primitives import serialization

from desktop_update import APP_ID, DEFAULT_UPDATE_BASE_URL, UPDATE_CHANNEL, parse_semver


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def normalize_version(value):
    value = str(value or "").strip().lstrip("v")
    parse_semver(value)
    return value


def sign_manifest(manifest_bytes, private_key_path):
    private_key = serialization.load_pem_private_key(Path(private_key_path).read_bytes(), password=None)
    return base64.b64encode(private_key.sign(manifest_bytes)).decode("ascii") + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", required=True, help="已通过本地验收的 Windows EXE")
    parser.add_argument("--version", required=True, help="三段式版本号，例如 0.8.1")
    parser.add_argument("--private-key", required=True, help="本机 Ed25519 私钥 PEM 路径")
    parser.add_argument("--output", required=True, help="生成的待上传目录")
    parser.add_argument("--base-url", default=DEFAULT_UPDATE_BASE_URL)
    parser.add_argument("--title", required=True, help="更新标题")
    parser.add_argument("--note", action="append", default=[], help="一条更新说明，可重复传入")
    parser.add_argument("--authenticode-thumbprint", default="", help="可选：EXE 签名证书指纹")
    args = parser.parse_args()

    version = normalize_version(args.version)
    exe_path = Path(args.exe).resolve()
    private_key_path = Path(args.private_key).resolve()
    output_root = Path(args.output).resolve()
    if not exe_path.is_file():
        raise SystemExit(f"EXE 不存在：{exe_path}")
    if not private_key_path.is_file():
        raise SystemExit(f"Ed25519 私钥不存在：{private_key_path}")

    file_name = f"YuqueExporterObsidian-{version}-win-x64.exe"
    release_dir = output_root / "releases" / f"v{version}"
    stable_dir = output_root / "stable"
    release_dir.mkdir(parents=True, exist_ok=True)
    stable_dir.mkdir(parents=True, exist_ok=True)
    target_exe = release_dir / file_name
    shutil.copy2(exe_path, target_exe)

    package = {
        "platform": "windows-x64",
        "url": f"{args.base_url.rstrip('/')}/releases/v{version}/{file_name}",
        "size": target_exe.stat().st_size,
        "sha256": sha256_file(target_exe),
    }
    if args.authenticode_thumbprint.strip():
        package["authenticodeThumbprint"] = args.authenticode_thumbprint.replace(" ", "").upper()
    manifest = {
        "schemaVersion": 1,
        "appId": APP_ID,
        "channel": UPDATE_CHANNEL,
        "version": version,
        "publishedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "title": args.title.strip(),
        "notes": [note.strip() for note in args.note if note.strip()],
        "mandatory": False,
        "package": package,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (stable_dir / "manifest.json").write_bytes(manifest_bytes)
    (stable_dir / "manifest.sig").write_text(sign_manifest(manifest_bytes, private_key_path), encoding="ascii")
    notes = "\n".join([f"# v{version} | {args.title.strip()}", "", *[f"- {item}" for item in manifest["notes"]], ""])
    (release_dir / "release-notes.md").write_text(notes, encoding="utf-8")

    upload_order = "\n".join(
        [
            "上传顺序：",
            f"1. releases/v{version}/{file_name}",
            f"2. releases/v{version}/release-notes.md",
            "3. stable/manifest.sig",
            "4. stable/manifest.json（最后覆盖）",
            "",
            "宝塔目标目录：C:/wwwroot/update.baimoushare.cn/yuque2obsidian",
        ]
    )
    (output_root / "上传顺序.txt").write_text(upload_order + "\n", encoding="utf-8")
    print(f"OTA 上传目录已生成：{output_root}")
    print(f"manifest SHA-256：{hashlib.sha256(manifest_bytes).hexdigest()}")


if __name__ == "__main__":
    main()
