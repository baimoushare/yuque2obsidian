import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from desktop_update import verify_manifest_signature


class OtaPublishTests(unittest.TestCase):
    def test_publish_script_generates_signed_static_upload_tree(self):
        project_root = PROJECT_ROOT
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            exe = root / "YuqueExporterObsidian.exe"
            key_path = root / "ed25519-private.pem"
            output = root / "ota-upload"
            exe.write_bytes(b"verified-test-exe")
            private_key = Ed25519PrivateKey.generate()
            key_path.write_bytes(
                private_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            )
            public_key = base64.b64encode(
                private_key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            ).decode("ascii")

            result = subprocess.run(
                [
                    sys.executable,
                    str(project_root / "tools" / "ota_publish.py"),
                    "--exe",
                    str(exe),
                    "--version",
                    "0.8.1",
                    "--private-key",
                    str(key_path),
                    "--output",
                    str(output),
                    "--title",
                    "测试发布",
                    "--note",
                    "测试说明",
                ],
                cwd=project_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONUTF8": "1"},
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            manifest_path = output / "stable" / "manifest.json"
            signature_path = output / "stable" / "manifest.sig"
            manifest_bytes = manifest_path.read_bytes()
            verify_manifest_signature(manifest_bytes, signature_path.read_bytes(), public_key)
            manifest = json.loads(manifest_bytes)
            self.assertEqual(manifest["version"], "0.8.1")
            self.assertTrue((output / "releases" / "v0.8.1" / "YuqueExporterObsidian-0.8.1-win-x64.exe").is_file())
            self.assertTrue((output / "上传顺序.txt").is_file())


if __name__ == "__main__":
    unittest.main()
