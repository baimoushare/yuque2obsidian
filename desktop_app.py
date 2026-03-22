import json
import os
import subprocess
import threading
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import webview


ROOT_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = ROOT_DIR / "desktop.settings.json"


class DesktopApi:
    def __init__(self):
        self.window = None
        self.jobs = {}

    def attach_window(self, window):
        self.window = window

    def loadSettings(self):
        if not SETTINGS_FILE.exists():
            return self._default_settings()
        loaded = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        merged = self._default_settings()
        merged.update(loaded or {})
        return merged

    def saveSettings(self, settings):
        merged = self._default_settings()
        merged.update(settings or {})
        SETTINGS_FILE.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        return merged

    def chooseOutputDir(self):
        if not self.window:
            return ""
        result = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else ""

    def startLogin(self, config=None):
        job_id = self._create_job("login")
        self._run_process_job(job_id, "login", config or {})
        return {"jobId": job_id}

    def getLoginStatus(self, config=None):
        try:
            result = self._run_process_sync("whoami", config or {})
            payload = result.get("payload") or {}
            return {
                "loggedIn": bool(payload.get("loggedIn")),
                "user": payload.get("user") or None,
            }
        except Exception:
            return {
                "loggedIn": False,
                "user": None,
            }

    def scanBooks(self, config=None):
        result = self._run_process_sync("scan", config or {})
        payload = result.get("payload") or {}
        return payload.get("books", [])

    def startExport(self, config=None):
        running_export = next(
            (
                job for job in self.jobs.values()
                if job.get("kind") == "export" and job.get("status") in {"running", "pausing", "stopping"}
            ),
            None,
        )
        if running_export:
            return {"jobId": running_export["id"], "reused": True}

        job_id = self._create_job("export")
        merged = self._default_settings()
        merged.update(config or {})
        merged["jobControlPath"] = str(Path(merged["outputDir"]) / f".yuque-export-control-{job_id}.json")
        job = self.jobs[job_id]
        job["config"] = merged
        job["controlPath"] = merged["jobControlPath"]
        self._run_process_job(job_id, "export", merged)
        return {"jobId": job_id}

    def getJobStatus(self, jobId):
        job = self.jobs.get(jobId)
        if not job:
            return {"status": "missing", "logs": [], "events": []}
        return self._serialize_job(job)

    def pauseExport(self, jobId):
        job = self.jobs.get(jobId)
        if not job:
            return {"status": "missing"}
        if job.get("kind") != "export":
            return {"status": job["status"]}
        if job.get("status") != "running":
            return {"status": job["status"]}

        control_path = job.get("controlPath")
        if control_path:
            Path(control_path).write_text(json.dumps({"action": "pause"}, ensure_ascii=False), encoding="utf-8")
        job["status"] = "pausing"
        job["logs"].append("Pause requested. The current document will finish before pausing.")
        job["updatedAt"] = self._now_iso()
        return {"status": job["status"]}

    def cancelExport(self, jobId):
        job = self.jobs.get(jobId)
        if not job:
            return {"status": "missing"}
        control_path = job.get("controlPath")
        if control_path:
            Path(control_path).write_text(json.dumps({"action": "stop"}, ensure_ascii=False), encoding="utf-8")
            job["status"] = "stopping"
            job["logs"].append("Stop requested. The current progress will be saved.")
            job["updatedAt"] = self._now_iso()
            return {"status": job["status"]}
        process = job.get("process")
        if process and process.poll() is None:
            process.terminate()
            job["status"] = "cancelled"
            job["logs"].append("Task cancelled.")
        return {"status": job["status"]}

    def openOutputDir(self, outputDir):
        if outputDir and os.path.isdir(outputDir):
            os.startfile(outputDir)
            return True
        return False

    def _default_settings(self):
        return {
            "browserPath": "",
            "cookiePath": str(ROOT_DIR / "cookies.json"),
            "outputDir": str(ROOT_DIR / "output"),
            "downloadImages": True,
            "downloadAttachments": True,
            "incrementalExport": True,
            "encryptedBlockPasswords": [],
            "encryptedBlockPassword": "",
            "complexBlockMode": "snapshot-first",
            "assetLayout": "book_assets",
            "jobControlPath": "",
        }

    def _create_job(self, kind):
        job_id = str(uuid.uuid4())
        self.jobs[job_id] = {
            "id": job_id,
            "kind": kind,
            "status": "running",
            "logs": [],
            "events": [],
            "result": None,
            "error": None,
            "process": None,
            "startedAt": self._now_iso(),
            "updatedAt": self._now_iso(),
        }
        return job_id

    def _run_process_job(self, job_id, command, config):
        thread = threading.Thread(
            target=self._run_process_async,
            args=(job_id, command, config),
            daemon=True,
        )
        thread.start()

    def _run_process_async(self, job_id, command, config):
        job = self.jobs[job_id]
        try:
            result = self._run_process(command, config, job)
            payload = result.get("payload") or {}
            payload_status = payload.get("status") or "success"
            if payload_status in {"paused", "cancelled"}:
                job["status"] = payload_status
            else:
                job["status"] = "success"
            job["result"] = payload
        except Exception as exc:
            job["status"] = "error"
            job["error"] = str(exc)
            job["logs"].append(str(exc))
        finally:
            job["process"] = None
            job["updatedAt"] = self._now_iso()

    def _run_process_sync(self, command, config):
        temp_job = {"logs": [], "events": [], "status": "running", "process": None}
        return self._run_process(command, config, temp_job)

    def _run_process(self, command, config, job):
        merged = self._default_settings()
        merged.update(config or {})

        env = os.environ.copy()
        env["YUQUE_EXPORTER_CONFIG"] = json.dumps(merged, ensure_ascii=False)
        process = subprocess.Popen(
            ["node", str(ROOT_DIR / "src" / "cli.js"), command],
            cwd=str(ROOT_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
        )
        job["process"] = process

        final_payload = None
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue

            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                job["logs"].append(line)
                job["updatedAt"] = self._now_iso()
                continue

            job["events"].append(payload)
            if payload.get("message"):
                job["logs"].append(payload["message"])
            if payload.get("type") == "result":
                final_payload = payload
            job["updatedAt"] = self._now_iso()

        exit_code = process.wait()
        if exit_code != 0 or not final_payload or final_payload.get("status") == "error":
            error_message = (final_payload or {}).get("error") or f"Command {command} failed with exit code {exit_code}."
            raise RuntimeError(error_message)

        return {"payload": final_payload}

    def _serialize_job(self, job):
        return {
            "id": job["id"],
            "kind": job["kind"],
            "status": job["status"],
            "logs": job["logs"][-400:],
            "events": job["events"][-400:],
            "result": job["result"],
            "error": job["error"],
            "config": job.get("config"),
            "startedAt": job.get("startedAt"),
            "updatedAt": job.get("updatedAt"),
        }

    def _now_iso(self):
        from datetime import datetime
        return datetime.now().isoformat()


def start_static_server():
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main():
    api = DesktopApi()
    static_server = start_static_server()
    ui_url = f"http://127.0.0.1:{static_server.server_port}/desktop/ui/index.html"
    window = webview.create_window(
        "语雀导出到 Obsidian",
        url=ui_url,
        js_api=api,
        width=1480,
        height=960,
        min_size=(1260, 820),
        text_select=True,
    )
    api.attach_window(window)
    try:
        webview.start(debug=False)
    finally:
        static_server.shutdown()
        static_server.server_close()


if __name__ == "__main__":
    main()
