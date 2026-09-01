import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from desktop_app import DesktopApi


class DesktopScanCompatibilityTests(unittest.TestCase):
    def create_api(self, payload):
        api = DesktopApi.__new__(DesktopApi)
        api._run_process_sync = lambda _command, _config: {"payload": payload}
        return api

    def test_detailed_scan_returns_warnings_and_counts(self):
        payload = {
            "books": [{"id": 1, "name": "正常知识库"}],
            "warnings": [{"bookId": "2", "bookName": "异常知识库", "message": "已跳过"}],
            "totalBooks": 2,
            "skippedBooks": 1,
        }
        api = self.create_api(payload)

        with patch("desktop_app.append_launch_log") as append_log:
            result = api.scanBooksDetailed({})

        self.assertEqual(result["books"], payload["books"])
        self.assertEqual(result["warnings"], payload["warnings"])
        self.assertEqual(result["totalBooks"], 2)
        self.assertEqual(result["skippedBooks"], 1)
        append_log.assert_called_once()

    def test_legacy_scan_keeps_returning_only_the_book_array(self):
        books = [{"id": 1, "name": "正常知识库"}]
        api = self.create_api({"books": books, "warnings": []})

        self.assertEqual(api.scanBooks({}), books)

    def test_crash_reports_never_overwrite_another_sync_scan_report(self):
        api = DesktopApi.__new__(DesktopApi)
        api._now_iso = lambda: "2026-09-01T12:00:00"
        api._find_recent_crash_dumps = lambda _started_at: []
        job = {
            "id": "sync",
            "kind": "scan",
            "startedAt": "2026-09-01T12:00:00",
            "lastProgress": None,
            "lastDocument": None,
        }

        with TemporaryDirectory() as temporary_dir, patch(
            "desktop_app.CRASH_REPORT_DIR", Path(temporary_dir)
        ), patch("desktop_app.append_launch_log"):
            first_path = api._write_crash_report(job, "scan", {}, "node", "cli.js", 1, {}, [], [])
            second_path = api._write_crash_report(job, "scan", {}, "node", "cli.js", 1, {}, [], [])

            self.assertNotEqual(first_path, second_path)
            self.assertTrue(Path(first_path).is_file())
            self.assertTrue(Path(second_path).is_file())


if __name__ == "__main__":
    unittest.main()
