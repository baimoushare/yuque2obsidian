import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from desktop_app import DesktopApi


class DesktopDocumentSourceBridgeTests(unittest.TestCase):
    def create_api(self, payload):
        api = DesktopApi.__new__(DesktopApi)
        api._run_process_sync = MagicMock(return_value={"payload": payload})
        return api

    def test_scan_returns_explicit_document_entries_and_excluded_items(self):
        payload = {
            "documents": [{"documentKey": "yuque:book-1:doc-1"}],
            "excluded": [{"itemType": "book-entry", "status": "not-expanded"}],
            "excludedCount": 1,
            "totalItems": 2,
            "pageCount": 1,
        }
        api = self.create_api(payload)

        result = api.scanDocumentSources({"cookiePath": "private-path"})

        self.assertEqual(result["documents"], payload["documents"])
        self.assertEqual(result["excluded"], payload["excluded"])
        self.assertEqual(result["totalItems"], 2)
        api._run_process_sync.assert_called_once_with("scan-sources", {"cookiePath": "private-path"})

    def test_scan_rejects_malformed_response_instead_of_showing_empty_list(self):
        api = self.create_api({"documents": []})

        with self.assertRaisesRegex(RuntimeError, "不能将错误当成空列表"):
            api.scanDocumentSources({})

    def test_source_scan_runs_as_background_job_with_control_file(self):
        with TemporaryDirectory() as temporary_dir:
            api = DesktopApi.__new__(DesktopApi)
            api.jobs = {}
            api._default_settings = lambda: {"outputDir": "D:/isolated-output"}

            def create_job(kind):
                api.jobs["job-scan"] = {"id": "job-scan", "kind": kind, "status": "running"}
                return "job-scan"

            api._create_job = create_job
            api._run_process_job = MagicMock()

            with patch("desktop_app.USER_DATA_DIR", Path(temporary_dir)):
                result = api.startDocumentSourceScan({"downloadImages": False})

            self.assertEqual(result, {"jobId": "job-scan"})
            job_id, command, config = api._run_process_job.call_args.args
            self.assertEqual(job_id, "job-scan")
            self.assertEqual(command, "scan-sources")
            self.assertFalse(config["downloadImages"])
            self.assertEqual(Path(config["jobControlPath"]).parent, Path(temporary_dir) / "job-controls")

    def test_source_scan_stop_waits_for_the_current_page_to_finish(self):
        with TemporaryDirectory() as temporary_dir:
            control_path = Path(temporary_dir) / "source-scan-control.json"
            api = DesktopApi.__new__(DesktopApi)
            api.jobs = {
                "job-scan": {
                    "id": "job-scan",
                    "kind": "source-scan",
                    "status": "running",
                    "logs": [],
                    "controlPath": str(control_path),
                    "updatedAt": "",
                },
            }
            api._now_iso = lambda: "now"
            api._schedule_forced_shutdown = MagicMock()

            result = api.cancelExport("job-scan")

            self.assertEqual(result, {"status": "stopping"})
            self.assertEqual(api.jobs["job-scan"]["status"], "stopping")
            self.assertEqual(json.loads(control_path.read_text(encoding="utf-8"))["action"], "stop")
            self.assertEqual(api._schedule_forced_shutdown.call_args.kwargs["grace_seconds"], 125)

    def test_source_export_requires_a_nonblank_explicit_selection(self):
        api = DesktopApi.__new__(DesktopApi)
        api._default_settings = lambda: {"outputDir": "D:/isolated-output"}
        api._create_job = MagicMock()
        api._run_process_job = MagicMock()

        for selected_keys in ([], ["  "], None):
            with self.subTest(selected_keys=selected_keys):
                with self.assertRaisesRegex(ValueError, "至少一篇"):
                    api.startDocumentSourceExport({"selectedDocumentKeys": selected_keys})

        api._create_job.assert_not_called()
        api._run_process_job.assert_not_called()

    def test_source_export_uses_export_job_controls_without_reusing_book_command(self):
        with TemporaryDirectory() as temporary_dir:
            api = DesktopApi.__new__(DesktopApi)
            api.jobs = {}
            api._default_settings = lambda: {"outputDir": temporary_dir, "selectedDocumentKeys": []}

            def create_job(kind):
                api.jobs["job-source"] = {"id": "job-source", "kind": kind, "status": "running"}
                return "job-source"

            api._create_job = create_job
            api._run_process_job = MagicMock()

            result = api.startDocumentSourceExport({
                "selectedDocumentKeys": ["yuque:book-1:doc-1"],
                "downloadImages": False,
            })

            self.assertEqual(result, {"jobId": "job-source"})
            api._run_process_job.assert_called_once()
            job_id, command, config = api._run_process_job.call_args.args
            self.assertEqual(job_id, "job-source")
            self.assertEqual(command, "export-sources")
            self.assertEqual(config["selectedDocumentKeys"], ["yuque:book-1:doc-1"])
            self.assertFalse(config["downloadImages"])
            self.assertEqual(Path(config["jobControlPath"]).parent, Path(temporary_dir))

    def test_source_retry_dispatches_direct_identity_command_without_scanning_books(self):
        with TemporaryDirectory() as temporary_dir:
            api = DesktopApi.__new__(DesktopApi)
            api.jobs = {}
            api._default_settings = lambda: {"outputDir": temporary_dir}

            def create_job(kind):
                api.jobs["job-retry"] = {"id": "job-retry", "kind": kind, "status": "running"}
                return "job-retry"

            api._create_job = create_job
            api._run_process_job = MagicMock()
            api.scanBooks = MagicMock(side_effect=AssertionError("retry must not scan knowledge bases"))
            plan = {
                "failureCsvPath": str(Path(temporary_dir) / "failures.csv"),
                "outputDir": temporary_dir,
                "rowCount": 2,
                "documentCount": 1,
                "selectedDocumentKeys": ["yuque:book-1:doc-1"],
                "retrySourceDocuments": [{
                    "documentKey": "yuque:book-1:doc-1",
                    "canonicalUrl": "https://www.yuque.com/owner/book/doc",
                }],
            }

            with patch("desktop_app.build_source_retry_plan", return_value=plan):
                result = api.startRetryExportFromFailureCsv({
                    "failureCsvPath": plan["failureCsvPath"],
                })

            self.assertTrue(result["sourceRetry"])
            self.assertEqual(result["bookCount"], 0)
            self.assertEqual(result["selectedDocumentKeys"], plan["selectedDocumentKeys"])
            api.scanBooks.assert_not_called()
            command = api._run_process_job.call_args.args[1]
            self.assertEqual(command, "export-source-retry")


if __name__ == "__main__":
    unittest.main()
