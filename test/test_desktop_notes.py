import csv
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch
from desktop_app import DesktopApi
from desktop_retry import build_note_retry_plan


class DesktopNotesTests(unittest.TestCase):
    def make_api(self, directory):
        api = DesktopApi.__new__(DesktopApi)
        api.jobs = {}
        api._default_settings = lambda: {"outputDir": directory}
        def create(kind):
            api.jobs["note-job"] = {"id": "note-job", "kind": kind, "status": "running"}
            return "note-job"
        api._create_job = create
        api._run_process_job = MagicMock()
        return api

    def test_scan_uses_background_command_and_control(self):
        with TemporaryDirectory() as directory:
            api = self.make_api(directory)
            with patch("desktop_app.USER_DATA_DIR", Path(directory)):
                self.assertEqual(api.startNoteScan(), {"jobId": "note-job"})
            self.assertEqual(api._run_process_job.call_args.args[1], "scan-notes")
            self.assertEqual(api.jobs["note-job"]["kind"], "note-scan")

    def test_export_requires_explicit_matching_account_selection(self):
        with TemporaryDirectory() as directory:
            api = self.make_api(directory)
            for config in ({}, {"noteAccountScope": "1", "selectedNoteKeys": []}, {"noteAccountScope": "1", "selectedNoteKeys": ["yuque-note:2:3"]}):
                with self.assertRaises(ValueError):
                    api.startNoteExport(config)
            api._run_process_job.assert_not_called()
            api.startNoteExport({"noteAccountScope": "1", "selectedNoteKeys": ["yuque-note:1:3"]})
            self.assertEqual(api._run_process_job.call_args.args[1], "export-notes")

    def test_notes_tasks_do_not_overlap_other_export(self):
        with TemporaryDirectory() as directory:
            api = self.make_api(directory)
            api.jobs = {"old": {"id": "old", "kind": "export", "status": "running"}}
            with self.assertRaises(ValueError):
                api.startNoteScan()
            with self.assertRaises(ValueError):
                api.startNoteExport({"noteAccountScope": "1", "selectedNoteKeys": ["yuque-note:1:3"]})

    def test_retry_routes_only_notes_without_scanning_books(self):
        with TemporaryDirectory() as directory:
            file = Path(directory) / "failed.csv"
            with file.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["语雀路径"])
                writer.writerows([["yuque-note:1:3"], ["yuque-note:1:3"]])
            plan = build_note_retry_plan(file)
            self.assertEqual(plan["selectedNoteKeys"], ["yuque-note:1:3"])
            api = self.make_api(directory)
            api.scanBooks = MagicMock()
            result = api.startRetryExportFromFailureCsv({"failureCsvPath": str(file)})
            self.assertTrue(result["noteRetry"])
            api.scanBooks.assert_not_called()
            self.assertFalse(api._run_process_job.call_args.args[2]["incrementalExport"])

    def test_old_entries_cannot_overlap_note_scan(self):
        with TemporaryDirectory() as directory:
            for method in ("startExport", "startDocumentSourceExport", "startDocumentSourceScan"):
                api = self.make_api(directory)
                api.jobs = {"scan": {"id": "scan", "kind": "note-scan", "status": "running"}}
                with self.assertRaises(ValueError):
                    getattr(api, method)({})
                api._run_process_job.assert_not_called()

    def test_failed_payload_remains_error_with_report_available(self):
        with TemporaryDirectory() as directory:
            api = self.make_api(directory)
            api.jobs = {"job": {"status": "running", "logs": []}}
            api._run_process = MagicMock(return_value={"payload": {"status": "failed", "source": "notes", "reportPath": "report.json"}})
            api._now_iso = lambda: "now"
            api._cleanup_job_control_file = MagicMock()
            api._run_process_async("job", "export-notes", {})
            self.assertEqual(api.jobs["job"]["status"], "error")
            self.assertEqual(api.jobs["job"]["result"]["reportPath"], "report.json")

    def test_mixed_or_multi_account_retry_is_rejected(self):
        with TemporaryDirectory() as directory:
            file = Path(directory) / "failed.csv"
            for identities in (["yuque-note:1:3", "https://www.yuque.com/a/b/c"], ["yuque-note:1:3", "yuque-note:2:4"]):
                with file.open("w", encoding="utf-8-sig", newline="") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["语雀路径"])
                    writer.writerows([[value] for value in identities])
                with self.assertRaises(ValueError):
                    build_note_retry_plan(file)

if __name__ == "__main__":
    unittest.main()
