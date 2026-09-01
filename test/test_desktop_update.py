import base64
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import desktop_update
from desktop_update import (
    UpdateError,
    UpdateService,
    apply_update_task,
    compare_versions,
    validate_manifest,
    verify_manifest_signature,
    _terminate_process,
)


class DesktopUpdateTests(unittest.TestCase):
    def _manifest(self, version="0.8.1"):
        return {
            "schemaVersion": 1,
            "appId": "yuque-exporter-obsidian",
            "channel": "stable",
            "version": version,
            "title": "测试更新",
            "notes": ["修复测试问题"],
            "mandatory": False,
            "package": {
                "platform": "windows-x64",
                "url": "https://update.baimoushare.cn/yuque2obsidian/releases/v0.8.1/YuqueExporterObsidian-0.8.1-win-x64.exe",
                "size": 12,
                "sha256": "a" * 64,
            },
        }

    def test_compare_versions_requires_three_part_semver(self):
        self.assertEqual(compare_versions("0.8.0", "0.7.9"), 1)
        self.assertEqual(compare_versions("v0.8.0", "0.8.0"), 0)
        with self.assertRaises(UpdateError):
            compare_versions("0.8", "0.7.0")

    def test_signed_manifest_is_accepted_and_tampering_is_rejected(self):
        private_key = Ed25519PrivateKey.generate()
        public_key = base64.b64encode(
            private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        ).decode("ascii")
        raw = json.dumps(self._manifest(), ensure_ascii=False).encode("utf-8")
        signature = base64.b64encode(private_key.sign(raw))

        verify_manifest_signature(raw, signature, public_key)
        with self.assertRaises(UpdateError):
            verify_manifest_signature(raw + b" ", signature, public_key)

    def test_manifest_rejects_foreign_package_url_and_old_version(self):
        foreign = self._manifest()
        foreign["package"]["url"] = "https://example.com/update.exe"
        with self.assertRaises(UpdateError):
            validate_manifest(foreign, "0.8.0", "https://update.baimoushare.cn/yuque2obsidian")

        old = self._manifest("0.8.0")
        result = validate_manifest(old, "0.8.0", "https://update.baimoushare.cn/yuque2obsidian")
        self.assertFalse(result["available"])

    def test_update_service_reads_detached_signed_manifest(self):
        private_key = Ed25519PrivateKey.generate()
        public_key = base64.b64encode(
            private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        ).decode("ascii")
        manifest_bytes = (json.dumps(self._manifest(), ensure_ascii=False) + "\n").encode("utf-8")
        signature = base64.b64encode(private_key.sign(manifest_bytes))

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "package.json").write_text('{"version":"0.8.0"}', encoding="utf-8")
            service = UpdateService(root / "data", root, base_url="https://update.baimoushare.cn/yuque2obsidian", public_key_b64=public_key)

            with patch("desktop_update._fetch_bytes", side_effect=[manifest_bytes, signature]):
                state = service.check(force=True)

        self.assertEqual(state["status"], "available")
        self.assertEqual(state["availableUpdate"]["version"], "0.8.1")

    def test_health_marker_rejects_a_version_different_from_the_running_exe(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "package.json").write_text('{"version":"0.8.0"}', encoding="utf-8")
            service = UpdateService(root / "data", root)

            service.report_post_update_health("a" * 32, "0.8.1")

            self.assertFalse((root / "data" / "updates" / "health" / f"{'a' * 32}.json").exists())

    def test_check_network_failure_is_retryable_instead_of_stuck_checking(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "package.json").write_text('{"version":"0.8.0"}', encoding="utf-8")
            service = UpdateService(root / "data", root)

            with patch("desktop_update._fetch_bytes", side_effect=urllib.error.URLError("offline")):
                failed = service.check(force=True)
            self.assertEqual(failed["status"], "error")

            private_key = Ed25519PrivateKey.generate()
            public_key = base64.b64encode(
                private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
            ).decode("ascii")
            manifest_bytes = (json.dumps(self._manifest(), ensure_ascii=False) + "\n").encode("utf-8")
            signature = base64.b64encode(private_key.sign(manifest_bytes))
            service.public_key_b64 = public_key
            with patch("desktop_update._fetch_bytes", side_effect=[manifest_bytes, signature]):
                recovered = service.check(force=True)
            self.assertEqual(recovered["status"], "available")

    def test_terminate_process_releases_a_live_failed_update_process(self):
        process = MagicMock()
        process.poll.return_value = None

        _terminate_process(process)

        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)

    def test_helper_replaces_program_and_waits_for_health_marker(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            user_data = root / "YuqueExporterObsidian"
            updates = user_data / "updates"
            target = root / "YuqueExporterObsidian.exe"
            token = "a" * 32
            staged = updates / "staging" / "v0.8.1" / "YuqueExporterObsidian-0.8.1-win-x64.exe"
            health = updates / "health" / f"{token}.json"
            target.write_bytes(b"old-version")
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(b"new-version")
            (updates / "tasks").mkdir(parents=True, exist_ok=True)
            (updates / "update-state.json").write_text(
                json.dumps({"downloadedPath": str(staged), "downloadedVersion": "0.8.1"}), encoding="utf-8"
            )
            task = {
                "schemaVersion": 1,
                "token": token,
                "pid": 123,
                "targetExe": str(target),
                "stagedExe": str(staged),
                "expectedVersion": "0.8.1",
                "expectedSha256": desktop_update.sha256_file(staged),
                "healthPath": str(health),
            }
            task_path = updates / "tasks" / f"apply-{token}.json"
            task_path.write_text(json.dumps(task), encoding="utf-8")

            def launch_new(*_args, **_kwargs):
                health.parent.mkdir(parents=True, exist_ok=True)
                health.write_text(json.dumps({"token": token, "version": "0.8.1"}), encoding="utf-8")
                return MagicMock(poll=lambda: None)

            with patch("desktop_update.get_user_data_dir", return_value=user_data), patch("desktop_update._wait_for_process_exit"), patch("desktop_update.subprocess.Popen", side_effect=launch_new):
                result = apply_update_task(task_path)

            self.assertEqual(result, 0)
            self.assertEqual(target.read_bytes(), b"new-version")
            self.assertEqual((root / "YuqueExporterObsidian.exe.previous").read_bytes(), b"old-version")

    def test_helper_restores_previous_version_when_health_check_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            user_data = root / "YuqueExporterObsidian"
            updates = user_data / "updates"
            target = root / "YuqueExporterObsidian.exe"
            token = "b" * 32
            staged = updates / "staging" / "v0.8.1" / "YuqueExporterObsidian-0.8.1-win-x64.exe"
            health = updates / "health" / f"{token}.json"
            target.write_bytes(b"old-version")
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(b"new-version")
            (updates / "tasks").mkdir(parents=True, exist_ok=True)
            (updates / "update-state.json").write_text(
                json.dumps({"downloadedPath": str(staged), "downloadedVersion": "0.8.1"}), encoding="utf-8"
            )
            task = {
                "schemaVersion": 1,
                "token": token,
                "pid": 123,
                "targetExe": str(target),
                "stagedExe": str(staged),
                "expectedVersion": "0.8.1",
                "expectedSha256": desktop_update.sha256_file(staged),
                "healthPath": str(health),
            }
            task_path = updates / "tasks" / f"apply-{token}.json"
            task_path.write_text(json.dumps(task), encoding="utf-8")
            process = MagicMock()
            process.poll.return_value = 0

            with patch("desktop_update.get_user_data_dir", return_value=user_data), patch("desktop_update._wait_for_process_exit"), patch("desktop_update.HEALTH_TIMEOUT_SECONDS", 0), patch(
                "desktop_update.subprocess.Popen", return_value=process
            ):
                result = apply_update_task(task_path)

            self.assertEqual(result, 1)
            self.assertEqual(target.read_bytes(), b"old-version")
            result_file = root / "updates" / "results" / "token.json"
            result_file = updates / "results" / f"{token}.json"
            self.assertEqual(json.loads(result_file.read_text(encoding="utf-8"))["status"], "rolled-back")

    def test_helper_rejects_task_with_untrusted_target_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            user_data = root / "YuqueExporterObsidian"
            updates = user_data / "updates"
            token = "c" * 32
            staged = updates / "staging" / "v0.8.1" / "YuqueExporterObsidian-0.8.1-win-x64.exe"
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(b"new-version")
            (updates / "tasks").mkdir(parents=True, exist_ok=True)
            (updates / "update-state.json").write_text(
                json.dumps({"downloadedPath": str(staged), "downloadedVersion": "0.8.1"}), encoding="utf-8"
            )
            target = root / "OtherProgram.exe"
            target.write_bytes(b"old-version")
            task_path = updates / "tasks" / f"apply-{token}.json"
            task_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "token": token,
                        "pid": 123,
                        "targetExe": str(target),
                        "stagedExe": str(staged),
                        "expectedVersion": "0.8.1",
                        "expectedSha256": desktop_update.sha256_file(staged),
                        "healthPath": str(updates / "health" / f"{token}.json"),
                    }
                ),
                encoding="utf-8",
            )
            with patch("desktop_update.get_user_data_dir", return_value=user_data):
                with self.assertRaises(UpdateError):
                    apply_update_task(task_path)


if __name__ == "__main__":
    unittest.main()
