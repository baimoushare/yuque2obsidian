import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import uuid
import base64
import mimetypes
from collections import deque
from datetime import datetime
from pathlib import Path

import webview

from desktop_retry import build_retry_export_plan

APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
# 运行时可写数据放到用户目录，避免安装到 Program Files 后无法保存配置，
# 也避免把登录态和日志散落在程序安装目录。
LOCAL_DATA_ROOT = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share"))
USER_DATA_DIR = LOCAL_DATA_ROOT / "YuqueExporterObsidian"
SETTINGS_FILE = USER_DATA_DIR / "desktop.settings.json"
LAUNCH_LOG_FILE = USER_DATA_DIR / "desktop-launch.log"
CRASH_REPORT_DIR = USER_DATA_DIR / "crash-reports"
LEGACY_SETTINGS_FILE = APP_DIR / "desktop.settings.json"
LEGACY_COOKIE_FILE = APP_DIR / "cookies.json"
SINGLE_INSTANCE_MUTEX = None


def migrate_legacy_runtime_files():
    """首次升级时把旧安装目录配置迁移到用户目录；不复制不存在的文件。"""
    try:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        if not SETTINGS_FILE.exists() and LEGACY_SETTINGS_FILE.exists():
            try:
                legacy_settings = json.loads(LEGACY_SETTINGS_FILE.read_text(encoding="utf-8-sig"))
                for key in ("encryptedBlockPasswords", "encryptedBlockPassword", "reencryptGlobalPassword", "jobControlPath"):
                    legacy_settings.pop(key, None)
                SETTINGS_FILE.write_text(json.dumps(legacy_settings, ensure_ascii=False, indent=2), encoding="utf-8")
            except (OSError, ValueError):
                pass
        target_cookie = USER_DATA_DIR / "cookies.json"
        if not target_cookie.exists() and LEGACY_COOKIE_FILE.exists():
            target_cookie.write_bytes(LEGACY_COOKIE_FILE.read_bytes())
    except Exception as exc:
        append_launch_log(f"RUNTIME_DATA_MIGRATION_FAILED error={exc}")


def append_launch_log(message):
    try:
        LAUNCH_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LAUNCH_LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(f"[{datetime.now().isoformat(timespec='seconds')}] {message}\n")
    except Exception:
        pass


def acquire_single_instance_guard():
    global SINGLE_INSTANCE_MUTEX

    if os.name != "nt":
        return True

    try:
        mutex_name = "Global\\YuqueExporterObsidianDesktop"
        handle = ctypes.windll.kernel32.CreateMutexW(None, False, mutex_name)
        if not handle:
            append_launch_log("SINGLE_INSTANCE mutex creation returned an empty handle; continuing without guard.")
            return True

        already_exists = ctypes.windll.kernel32.GetLastError() == 183
        if already_exists:
            ctypes.windll.kernel32.CloseHandle(handle)
            append_launch_log("SINGLE_INSTANCE existing instance detected; exiting duplicate launch.")
            return False

        SINGLE_INSTANCE_MUTEX = handle
        append_launch_log(f"SINGLE_INSTANCE acquired mutex={mutex_name}")
        return True
    except Exception as exc:
        append_launch_log(f"SINGLE_INSTANCE_FAILED error={exc}")
        return True


def release_single_instance_guard():
    global SINGLE_INSTANCE_MUTEX

    if os.name != "nt" or not SINGLE_INSTANCE_MUTEX:
        return

    try:
        ctypes.windll.kernel32.CloseHandle(SINGLE_INSTANCE_MUTEX)
    except Exception:
        pass
    SINGLE_INSTANCE_MUTEX = None


def load_ui_html():
    ui_dir = RESOURCE_DIR / "desktop" / "ui"
    index_html = (ui_dir / "index.html").read_text(encoding="utf-8")
    styles_css = (ui_dir / "styles.css").read_text(encoding="utf-8")
    app_js = (ui_dir / "app.js").read_text(encoding="utf-8")
    base_href = f'{ui_dir.resolve().as_uri().rstrip("/")}/'

    def to_data_uri(asset_name):
        asset_path = ui_dir / "assets" / asset_name
        mime_type, _ = mimetypes.guess_type(str(asset_path))
        encoded = base64.b64encode(asset_path.read_bytes()).decode("ascii")
        return f"data:{mime_type or 'application/octet-stream'};base64,{encoded}"

    embedded_assets = {
        "./assets/yuque.png": to_data_uri("yuque.png"),
        "./assets/obsidian.png": to_data_uri("obsidian.png"),
        "./assets/tree-expand.svg": to_data_uri("tree-expand.svg"),
        "./assets/tree-collapse.svg": to_data_uri("tree-collapse.svg"),
        "./assets/weixin.jpg": to_data_uri("weixin.jpg"),
        "./assets/zhifubao.jpg": to_data_uri("zhifubao.jpg"),
        "./assets/咖啡.png": to_data_uri("咖啡.png"),
    }

    html = index_html.replace(
        '<link rel="stylesheet" href="./styles.css" />',
        f"<style>\n{styles_css}\n</style>",
    )
    html = html.replace(
        '<script type="module" src="./app.js"></script>',
        f"<script>\n{app_js}\n</script>",
    )
    html = html.replace(
        "<head>",
        f'<head>\n    <base href="{base_href}" />',
        1,
    )
    for source_path, data_uri in embedded_assets.items():
        html = html.replace(source_path, data_uri)
    return html


def hide_console_window():
    if not getattr(sys, "frozen", False):
        return

    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            user32.ShowWindow(hwnd, 0)
    except Exception:
        pass


def get_hidden_subprocess_kwargs():
    if os.name != "nt":
        return {}

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0

    return {
        "creationflags": subprocess.CREATE_NO_WINDOW,
        "startupinfo": startupinfo,
    }


def resolve_node_command():
    bundled_node = RESOURCE_DIR / "bin" / "node.exe"
    if bundled_node.exists():
        return str(bundled_node)
    return "node"


if os.name == "nt":
    HRESULT = ctypes.c_long
    CLSCTX_INPROC_SERVER = 0x1
    COINIT_APARTMENTTHREADED = 0x2
    COINIT_DISABLE_OLE1DDE = 0x4
    RPC_E_CHANGED_MODE = -2147417850
    ERROR_CANCELLED_HRESULT = -2147023673
    FOS_PICKFOLDERS = 0x00000020
    FOS_FORCEFILESYSTEM = 0x00000040
    FOS_PATHMUSTEXIST = 0x00000800
    SIGDN_FILESYSPATH = 0x80058000

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_ulong),
            ("Data2", ctypes.c_ushort),
            ("Data3", ctypes.c_ushort),
            ("Data4", ctypes.c_ubyte * 8),
        ]

        @classmethod
        def from_string(cls, value):
            import uuid as uuid_module

            guid = cls()
            ctypes.memmove(ctypes.byref(guid), uuid_module.UUID(str(value)).bytes_le, ctypes.sizeof(cls))
            return guid

    class IFileDialog(ctypes.Structure):
        pass

    class IShellItem(ctypes.Structure):
        pass

    ShowProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p)
    ReleaseProto = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
    SetOptionsProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_uint)
    GetOptionsProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint))
    SetTitleProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_wchar_p)
    SetFolderProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p)
    GetResultProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
    GetDisplayNameProto = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_wchar_p))

    class IFileDialogVTable(ctypes.Structure):
        _fields_ = [
            ("QueryInterface", ctypes.c_void_p),
            ("AddRef", ctypes.c_void_p),
            ("Release", ReleaseProto),
            ("Show", ShowProto),
            ("SetFileTypes", ctypes.c_void_p),
            ("SetFileTypeIndex", ctypes.c_void_p),
            ("GetFileTypeIndex", ctypes.c_void_p),
            ("Advise", ctypes.c_void_p),
            ("Unadvise", ctypes.c_void_p),
            ("SetOptions", SetOptionsProto),
            ("GetOptions", GetOptionsProto),
            ("SetDefaultFolder", SetFolderProto),
            ("SetFolder", SetFolderProto),
            ("GetFolder", ctypes.c_void_p),
            ("GetCurrentSelection", ctypes.c_void_p),
            ("SetFileName", ctypes.c_void_p),
            ("GetFileName", ctypes.c_void_p),
            ("SetTitle", SetTitleProto),
            ("SetOkButtonLabel", ctypes.c_void_p),
            ("SetFileNameLabel", ctypes.c_void_p),
            ("GetResult", GetResultProto),
            ("AddPlace", ctypes.c_void_p),
            ("SetDefaultExtension", ctypes.c_void_p),
            ("Close", ctypes.c_void_p),
            ("SetClientGuid", ctypes.c_void_p),
            ("ClearClientData", ctypes.c_void_p),
            ("SetFilter", ctypes.c_void_p),
        ]

    class IShellItemVTable(ctypes.Structure):
        _fields_ = [
            ("QueryInterface", ctypes.c_void_p),
            ("AddRef", ctypes.c_void_p),
            ("Release", ReleaseProto),
            ("BindToHandler", ctypes.c_void_p),
            ("GetParent", ctypes.c_void_p),
            ("GetDisplayName", GetDisplayNameProto),
            ("GetAttributes", ctypes.c_void_p),
            ("Compare", ctypes.c_void_p),
        ]

    IFileDialog._fields_ = [("lpVtbl", ctypes.POINTER(IFileDialogVTable))]
    IShellItem._fields_ = [("lpVtbl", ctypes.POINTER(IShellItemVTable))]

    CLSID_FILE_OPEN_DIALOG = GUID.from_string("{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}")
    IID_I_FILE_OPEN_DIALOG = GUID.from_string("{D57C7288-D4AD-4768-BE02-9D969532D960}")
    IID_I_SHELL_ITEM = GUID.from_string("{43826D1E-E718-42EE-BC55-A1E261C37BFE}")

    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    user32 = ctypes.windll.user32

    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    ole32.CoInitializeEx.restype = HRESULT
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(GUID),
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    ole32.CoCreateInstance.restype = HRESULT
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole32.CoTaskMemFree.restype = None
    shell32.SHCreateItemFromParsingName.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_void_p,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    shell32.SHCreateItemFromParsingName.restype = HRESULT
    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = ctypes.c_void_p


def _is_success_hresult(result):
    return int(result) >= 0


def _normalize_initial_directory(raw_path):
    value = str(raw_path or "").strip().strip('"')
    if not value:
        return ""

    candidate = Path(os.path.expandvars(value)).expanduser()
    if candidate.is_file():
        candidate = candidate.parent

    current = candidate
    while True:
        try:
            if current.exists() and current.is_dir():
                return str(current)
        except OSError:
            return ""

        if current.parent == current:
            return ""
        current = current.parent


def _release_com_object(pointer):
    if pointer:
        try:
            pointer.contents.lpVtbl.contents.Release(pointer)
        except Exception:
            pass


def choose_directory_native(initial_dir="", title="选择文件夹"):
    if os.name != "nt":
        return ""

    normalized_dir = _normalize_initial_directory(initial_dir)
    com_initialized = False
    dialog = None
    folder_item = None
    result_item = None
    display_name = ctypes.c_wchar_p()

    try:
        init_result = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
        if init_result == RPC_E_CHANGED_MODE:
            append_launch_log("NATIVE_FOLDER_DIALOG CoInitializeEx returned RPC_E_CHANGED_MODE; continuing with current COM apartment.")
        elif not _is_success_hresult(init_result):
            raise RuntimeError(f"CoInitializeEx failed: 0x{ctypes.c_uint(init_result).value:08X}")
        else:
            com_initialized = True

        dialog_ptr = ctypes.c_void_p()
        result = ole32.CoCreateInstance(
            ctypes.byref(CLSID_FILE_OPEN_DIALOG),
            None,
            CLSCTX_INPROC_SERVER,
            ctypes.byref(IID_I_FILE_OPEN_DIALOG),
            ctypes.byref(dialog_ptr),
        )
        if not _is_success_hresult(result):
            raise RuntimeError(f"CoCreateInstance failed: 0x{ctypes.c_uint(result).value:08X}")
        dialog = ctypes.cast(dialog_ptr, ctypes.POINTER(IFileDialog))

        options = ctypes.c_uint(0)
        result = dialog.contents.lpVtbl.contents.GetOptions(dialog, ctypes.byref(options))
        if not _is_success_hresult(result):
            raise RuntimeError(f"IFileDialog.GetOptions failed: 0x{ctypes.c_uint(result).value:08X}")

        options.value |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
        result = dialog.contents.lpVtbl.contents.SetOptions(dialog, options)
        if not _is_success_hresult(result):
            raise RuntimeError(f"IFileDialog.SetOptions failed: 0x{ctypes.c_uint(result).value:08X}")

        if title:
            result = dialog.contents.lpVtbl.contents.SetTitle(dialog, title)
            if not _is_success_hresult(result):
                raise RuntimeError(f"IFileDialog.SetTitle failed: 0x{ctypes.c_uint(result).value:08X}")

        if normalized_dir:
            folder_ptr = ctypes.c_void_p()
            result = shell32.SHCreateItemFromParsingName(
                normalized_dir,
                None,
                ctypes.byref(IID_I_SHELL_ITEM),
                ctypes.byref(folder_ptr),
            )
            if _is_success_hresult(result):
                folder_item = ctypes.cast(folder_ptr, ctypes.POINTER(IShellItem))
                dialog.contents.lpVtbl.contents.SetDefaultFolder(dialog, folder_item)
                dialog.contents.lpVtbl.contents.SetFolder(dialog, folder_item)
            else:
                append_launch_log(
                    f"NATIVE_FOLDER_DIALOG unable to resolve initial directory {normalized_dir}: 0x{ctypes.c_uint(result).value:08X}"
                )

        owner_handle = user32.GetForegroundWindow()
        result = dialog.contents.lpVtbl.contents.Show(dialog, owner_handle)
        if result == ERROR_CANCELLED_HRESULT:
            return ""
        if not _is_success_hresult(result):
            raise RuntimeError(f"IFileDialog.Show failed: 0x{ctypes.c_uint(result).value:08X}")

        result_ptr = ctypes.c_void_p()
        result = dialog.contents.lpVtbl.contents.GetResult(dialog, ctypes.byref(result_ptr))
        if not _is_success_hresult(result):
            raise RuntimeError(f"IFileDialog.GetResult failed: 0x{ctypes.c_uint(result).value:08X}")

        result_item = ctypes.cast(result_ptr, ctypes.POINTER(IShellItem))
        result = result_item.contents.lpVtbl.contents.GetDisplayName(result_item, SIGDN_FILESYSPATH, ctypes.byref(display_name))
        if not _is_success_hresult(result):
            raise RuntimeError(f"IShellItem.GetDisplayName failed: 0x{ctypes.c_uint(result).value:08X}")

        return display_name.value or ""
    finally:
        if display_name:
            try:
                ole32.CoTaskMemFree(ctypes.cast(display_name, ctypes.c_void_p))
            except Exception:
                pass
        _release_com_object(result_item)
        _release_com_object(folder_item)
        _release_com_object(dialog)
        if com_initialized:
            ole32.CoUninitialize()


class DesktopApi:
    def __init__(self):
        self.window = None
        self.jobs = {}

    def attach_window(self, window):
        self.window = window

    def loadSettings(self):
        if not SETTINGS_FILE.exists():
            return self._default_settings()
        try:
            # 兼容历史配置中的 UTF-8 BOM。
            loaded = json.loads(SETTINGS_FILE.read_text(encoding="utf-8-sig"))
            return self._normalize_settings(loaded or {})
        except (OSError, ValueError) as exc:
            # 配置损坏时回退默认值，并保留现场，避免整个桌面端无法启动。
            corrupt_path = SETTINGS_FILE.with_name(
                f"{SETTINGS_FILE.stem}.corrupt-{datetime.now().strftime('%Y%m%d-%H%M%S')}{SETTINGS_FILE.suffix}"
            )
            try:
                SETTINGS_FILE.replace(corrupt_path)
            except OSError:
                pass
            append_launch_log(f"SETTINGS_LOAD_FAILED path={SETTINGS_FILE} error={exc}")
            return self._default_settings()

    def saveSettings(self, settings):
        merged = self._normalize_settings(settings or {})
        # 密码只在本次任务内存中存在，不写入配置文件。
        persisted = {
            key: value
            for key, value in merged.items()
            if key not in {"encryptedBlockPasswords", "encryptedBlockPassword", "reencryptGlobalPassword", "jobControlPath"}
        }
        USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS_FILE.with_name(f".{SETTINGS_FILE.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(persisted, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, SETTINGS_FILE)
        return merged

    def chooseOutputDir(self, currentPath=""):
        return self._choose_directory(currentPath, "选择导出目录")

    def chooseVaultDir(self, currentPath=""):
        return self._choose_directory(currentPath, "选择 Obsidian 仓库目录")

    def chooseFailureCsv(self, currentPath=""):
        initial_dir = ""
        initial_value = str(currentPath or "").strip().strip('"')
        if initial_value:
            candidate = Path(os.path.expandvars(initial_value)).expanduser()
            if candidate.is_file():
                initial_dir = str(candidate.parent)
            elif candidate.is_dir():
                initial_dir = str(candidate)

        if not self.window:
            return initial_value if Path(initial_value).is_file() else ""

        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG,
            directory=initial_dir,
            allow_multiple=False,
            file_types=("CSV files (*.csv)", "All files (*.*)"),
        )
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

    def startRetryExportFromFailureCsv(self, config=None):
        merged = self._default_settings()
        merged.update(config or {})
        failure_csv_path = str(merged.get("failureCsvPath") or "").strip()
        if not failure_csv_path:
            raise ValueError("请先选择失败日志 CSV。")

        books = self.scanBooks(merged)
        retry_plan = build_retry_export_plan(merged, failure_csv_path, books)
        result = self.startExport(retry_plan["config"])
        result.update(
            {
                "outputDir": retry_plan["outputDir"],
                "rowCount": retry_plan["rowCount"],
                "documentCount": retry_plan["documentCount"],
                "bookCount": retry_plan["bookCount"],
                "selectedBooks": retry_plan["selectedBooks"],
                "selectedDocuments": retry_plan["selectedDocuments"],
                "unmatchedDocuments": retry_plan["unmatchedDocuments"],
                "failureCsvPath": retry_plan["failureCsvPath"],
            }
        )
        return result

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
        job["requestedStatus"] = "paused"
        job["status"] = "pausing"
        job["logs"].append("Pause requested. The current document will finish before pausing.")
        job["logs"].append("If the exporter stops responding, it will be force-paused automatically in 15 seconds.")
        job["updatedAt"] = self._now_iso()
        self._schedule_forced_shutdown(
            job,
            requested_status="paused",
            grace_seconds=15,
            log_message="Force-paused the exporter because it did not respond to the pause request in time.",
        )
        return {"status": job["status"]}

    def cancelExport(self, jobId):
        job = self.jobs.get(jobId)
        if not job:
            return {"status": "missing"}
        control_path = job.get("controlPath")
        if control_path:
            Path(control_path).write_text(json.dumps({"action": "stop"}, ensure_ascii=False), encoding="utf-8")
        job["requestedStatus"] = "cancelled"
        job["status"] = "stopping"
        job["logs"].append("Stop requested. The current progress will be saved.")
        job["logs"].append("If the exporter does not stop by itself, it will be force-stopped automatically in 5 seconds.")
        job["updatedAt"] = self._now_iso()
        self._schedule_forced_shutdown(
            job,
            requested_status="cancelled",
            grace_seconds=5,
            log_message="Force-stopped the exporter because it did not respond to the stop request in time.",
        )
        if control_path:
            return {"status": job["status"]}
        process = job.get("process")
        if process and process.poll() is None:
            process.terminate()
            job["status"] = "cancelled"
            job["logs"].append("Task cancelled.")
        return {"status": job["status"]}

    def shutdown_jobs(self):
        """窗口关闭时停止所有 Node 子进程，避免留下孤儿浏览器/导出进程。"""
        for job in list(self.jobs.values()):
            process = job.get("process")
            if not process or process.poll() is not None:
                continue
            try:
                process.terminate()
                process.wait(timeout=3)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
            self._cleanup_job_control_file(job)

    def _schedule_forced_shutdown(self, job, requested_status, grace_seconds, log_message):
        if not job:
            return

        process = job.get("process")
        if not process or process.poll() is not None:
            return

        token = f"{job.get('id')}:{requested_status}:{time.time()}"
        job["terminationToken"] = token
        job["requestedStatus"] = requested_status

        def worker():
            time.sleep(max(grace_seconds, 0))
            current_job = self.jobs.get(job.get("id"))
            if not current_job:
                return
            if current_job.get("terminationToken") != token:
                return

            current_process = current_job.get("process")
            if not current_process or current_process.poll() is not None:
                return

            current_job["forcedTermination"] = True
            current_job["logs"].append(log_message)
            current_job["updatedAt"] = self._now_iso()
            append_launch_log(
                f"JOB_FORCE_STOP id={current_job.get('id')} requestedStatus={requested_status} pid={getattr(current_process, 'pid', '')}"
            )

            try:
                current_process.terminate()
            except Exception:
                pass

            try:
                current_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    current_process.kill()
                except Exception:
                    pass

            self._cleanup_job_control_file(current_job)

        threading.Thread(target=worker, daemon=True).start()

    def _cleanup_job_control_file(self, job):
        control_path = job.get("controlPath")
        if not control_path:
            return
        try:
            control_file = Path(control_path)
            if control_file.exists():
                control_file.unlink()
        except Exception:
            pass

    def openOutputDir(self, outputDir):
        if outputDir and os.path.isdir(outputDir):
            os.startfile(outputDir)
            return True
        return False

    def _choose_directory(self, current_path="", title="选择文件夹"):
        native_result = ""
        try:
            native_result = choose_directory_native(current_path, title)
        except Exception as exc:
            append_launch_log(f"NATIVE_FOLDER_DIALOG_FAILED title={title} path={current_path} error={exc}")

        if os.name == "nt":
            return native_result

        if not self.window:
            return ""

        result = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else ""

    def _default_settings(self):
        return {
            "browserPath": "",
            "cookiePath": str(USER_DATA_DIR / "cookies.json"),
            "outputDir": str(USER_DATA_DIR / "output"),
            "obsidianVaultPath": "",
            # 不默认安装社区插件；用户需要在界面中明确选择后才执行。
            "obsidianSetupMode": "none",
            "vaultExportLayout": "direct-to-vault",
            "vaultExportSubdir": "语雀导出",
            "downloadImages": True,
            "downloadAttachments": True,
            "incrementalExport": True,
            "failureCsvPath": "",
            "datatableExportMode": "structured-first",
            "encryptedBlockPasswords": [],
            "encryptedBlockPassword": "",
            "reencryptEncryptedBlocksMode": "global",
            "reencryptGlobalPassword": "",
            "complexBlockMode": "auto",
            "diagramExportMode": "auto",
            "diagramSnapshotMode": "fallback-only",
            "assetLayout": "book_assets",
            "jobControlPath": "",
        }

    def _normalize_settings(self, settings):
        merged = self._default_settings()
        merged.update(settings or {})
        merged["cookiePath"] = self._normalize_cookie_path(merged.get("cookiePath"))
        merged["failureCsvPath"] = str(merged.get("failureCsvPath") or "").strip()
        merged["obsidianVaultPath"] = str(merged.get("obsidianVaultPath") or "").strip()
        merged["obsidianSetupMode"] = self._normalize_obsidian_setup_mode(merged.get("obsidianSetupMode"))
        merged["vaultExportLayout"] = self._normalize_vault_export_layout(merged.get("vaultExportLayout"))
        merged["vaultExportSubdir"] = self._normalize_vault_export_subdir(merged.get("vaultExportSubdir"))
        merged["reencryptEncryptedBlocksMode"] = self._normalize_reencrypt_mode(
            merged.get("reencryptEncryptedBlocksMode")
        )
        merged["reencryptGlobalPassword"] = str(merged.get("reencryptGlobalPassword") or "")
        merged["complexBlockMode"] = self._normalize_complex_block_mode(merged.get("complexBlockMode"))
        merged["diagramExportMode"] = self._normalize_diagram_export_mode(merged.get("diagramExportMode"))
        merged["diagramSnapshotMode"] = self._normalize_diagram_snapshot_mode(merged.get("diagramSnapshotMode"))
        return merged

    def _normalize_cookie_path(self, cookie_path):
        default_path = USER_DATA_DIR / "cookies.json"
        if not cookie_path:
            return str(default_path)

        candidate = Path(cookie_path)
        if not candidate.is_absolute():
            candidate = APP_DIR / candidate

        if candidate.exists():
            return str(candidate)

        if candidate.parent.exists():
            return str(candidate)

        if candidate.name.lower() == "cookies.json":
            return str(default_path)

        return str(candidate)

    def _normalize_obsidian_setup_mode(self, value):
        normalized = str(value or "").strip().lower()
        if normalized == "bases+community":
            return "bases+community"
        if normalized == "bases":
            return "bases"
        return "none"

    def _normalize_vault_export_layout(self, value):
        return "direct-to-vault" if str(value or "").strip().lower() == "direct-to-vault" else "output-only"

    def _normalize_vault_export_subdir(self, value):
        normalized = str(value or "").strip().replace("\\", "/").strip("/")
        return normalized

    def _normalize_complex_block_mode(self, value):
        normalized = str(value or "").strip().lower()
        if normalized in {"snapshot-first", "structured-first", "skip", "auto"}:
            return normalized
        return "auto"

    def _normalize_diagram_export_mode(self, value):
        normalized = str(value or "").strip().lower()
        if normalized in {"auto", "portable", "obsidian-editable"}:
            return normalized
        return "auto"

    def _normalize_diagram_snapshot_mode(self, value):
        normalized = str(value or "").strip().lower()
        if normalized in {"disabled", "fallback-only", "supplemental"}:
            return normalized
        return "fallback-only"

    def _normalize_reencrypt_mode(self, value):
        normalized = str(value or "").strip().lower()
        if normalized in {"global", "matched-block"}:
            return normalized
        return "off"

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
            "lastProgress": None,
            "lastDocument": None,
            "crashReportPath": None,
            "requestedStatus": "",
            "forcedTermination": False,
            "terminationToken": "",
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
            job["terminationToken"] = ""
            job["updatedAt"] = self._now_iso()
            self._cleanup_job_control_file(job)

    def _run_process_sync(self, command, config):
        temp_job = {
            "id": "sync",
            "kind": command,
            "logs": [],
            "events": [],
            "status": "running",
            "process": None,
            "lastProgress": None,
            "lastDocument": None,
            "crashReportPath": None,
            "startedAt": self._now_iso(),
            "updatedAt": self._now_iso(),
        }
        return self._run_process(command, config, temp_job)

    def _run_process(self, command, config, job):
        merged = self._normalize_settings(config or {})
        config_summary = self._summarize_config_for_log(merged)
        node_command = resolve_node_command()
        cli_entry = str(RESOURCE_DIR / "src" / "cli.js")
        stdout_tail = deque(maxlen=120)
        event_tail = deque(maxlen=40)

        env = os.environ.copy()
        # 不把 Cookie/密码放入环境变量：同用户进程可枚举环境变量。
        env.pop("YUQUE_EXPORTER_CONFIG", None)
        env["YUQUE_EXPORTER_CONFIG_STDIN"] = "1"
        append_launch_log(
            f"JOB_START id={job.get('id')} kind={job.get('kind')} command={command} "
            f"node={node_command} cli={cli_entry} cwd={RESOURCE_DIR} "
            f"config={json.dumps(config_summary, ensure_ascii=False)}"
        )
        process = subprocess.Popen(
            [node_command, cli_entry, command],
            cwd=str(RESOURCE_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            **get_hidden_subprocess_kwargs(),
        )
        job["process"] = process
        try:
            if process.stdin is not None:
                process.stdin.write(json.dumps(merged, ensure_ascii=False))
                process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

        final_payload = None
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            stdout_tail.append(line)

            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                job["logs"].append(line)
                job["updatedAt"] = self._now_iso()
                continue

            job["events"].append(payload)
            if len(job["events"]) > 1000:
                del job["events"][:-500]
            event_tail.append(self._compact_event_for_log(payload))
            self._update_job_progress_snapshot(job, payload)
            if payload.get("message"):
                job["logs"].append(payload["message"])
                if len(job["logs"]) > 1000:
                    del job["logs"][:-500]
            if payload.get("type") == "result":
                final_payload = payload
            job["updatedAt"] = self._now_iso()

        exit_code = process.wait()
        append_launch_log(
            f"JOB_END id={job.get('id')} command={command} exit={self._format_exit_code(exit_code)} "
            f"result_status={(final_payload or {}).get('status', '')}"
        )
        if self._should_treat_process_exit_as_user_requested(job, exit_code, final_payload):
            requested_status = job.get("requestedStatus") or "cancelled"
            forced_payload = final_payload or {
                "type": "result",
                "status": requested_status,
                "forced": True,
                "message": "The exporter was stopped by the desktop app after a user pause/stop request.",
            }
            append_launch_log(
                f"JOB_FORCE_STOP_ACCEPTED id={job.get('id')} command={command} status={requested_status} exit={self._format_exit_code(exit_code)}"
            )
            return {"payload": forced_payload}
        if exit_code != 0 or not final_payload or final_payload.get("status") == "error":
            crash_report_path = self._write_crash_report(
                job=job,
                command=command,
                config_summary=config_summary,
                node_command=node_command,
                cli_entry=cli_entry,
                exit_code=exit_code,
                final_payload=final_payload,
                stdout_tail=list(stdout_tail),
                event_tail=list(event_tail),
            )
            error_message = self._build_process_error_message(
                command=command,
                exit_code=exit_code,
                final_payload=final_payload,
                job=job,
                crash_report_path=crash_report_path,
            )
            raise RuntimeError(error_message)

        return {"payload": final_payload}

    def _should_treat_process_exit_as_user_requested(self, job, exit_code, final_payload):
        requested_status = job.get("requestedStatus") or ""
        if requested_status not in {"paused", "cancelled"}:
            return False

        if final_payload and final_payload.get("status") == requested_status:
            return True

        if final_payload and final_payload.get("status") == "error" and not job.get("forcedTermination"):
            return False

        return bool(job.get("forcedTermination"))

    def _serialize_job(self, job):
        config = job.get("config") or {}
        safe_config = {
            key: value
            for key, value in config.items()
            if key not in {"encryptedBlockPasswords", "encryptedBlockPassword", "reencryptGlobalPassword", "cookiePath"}
        }
        return {
            "id": job["id"],
            "kind": job["kind"],
            "status": job["status"],
            "logs": job["logs"][-400:],
            "events": job["events"][-400:],
            "result": job["result"],
            "error": job["error"],
            "config": safe_config,
            "lastProgress": job.get("lastProgress"),
            "lastDocument": job.get("lastDocument"),
            "crashReportPath": job.get("crashReportPath"),
            "startedAt": job.get("startedAt"),
            "updatedAt": job.get("updatedAt"),
        }

    def _now_iso(self):
        return datetime.now().isoformat()

    def _update_job_progress_snapshot(self, job, payload):
        if not isinstance(payload, dict):
            return

        if payload.get("type") == "progress":
            snapshot = {
                "phase": payload.get("phase") or "",
                "status": payload.get("status") or "",
                "book": payload.get("book") or "",
                "doc": payload.get("doc") or "",
                "message": payload.get("message") or "",
                "percent": payload.get("percent"),
                "bookPercent": payload.get("bookPercent"),
                "targetMdPath": payload.get("targetMdPath") or "",
            }
            job["lastProgress"] = snapshot
            if snapshot["doc"] or snapshot["targetMdPath"]:
                job["lastDocument"] = snapshot

    def _summarize_config_for_log(self, config):
        selected_books = config.get("selectedBooks") or []
        selected_documents = config.get("selectedDocuments") or []
        fully_selected_books = config.get("fullySelectedBooks") or []
        encrypted_passwords = config.get("encryptedBlockPasswords") or []
        return {
            "cookiePath": config.get("cookiePath") or "",
            "outputDir": config.get("outputDir") or "",
            "browserPath": config.get("browserPath") or "",
            "obsidianVaultPath": config.get("obsidianVaultPath") or "",
            "obsidianSetupMode": config.get("obsidianSetupMode") or "none",
            "vaultExportLayout": config.get("vaultExportLayout") or "output-only",
            "vaultExportSubdir": config.get("vaultExportSubdir") or "",
            "selectedBookCount": len(selected_books),
            "fullySelectedBookCount": len(fully_selected_books),
            "selectedDocumentCount": len(selected_documents),
            "downloadImages": bool(config.get("downloadImages", True)),
            "downloadAttachments": bool(config.get("downloadAttachments", True)),
            "incrementalExport": bool(config.get("incrementalExport", True)),
            "datatableExportMode": config.get("datatableExportMode") or "",
            "reencryptEncryptedBlocksMode": config.get("reencryptEncryptedBlocksMode") or "off",
            "hasReencryptGlobalPassword": bool(config.get("reencryptGlobalPassword")),
            "complexBlockMode": config.get("complexBlockMode") or "",
            "diagramExportMode": config.get("diagramExportMode") or "",
            "diagramSnapshotMode": config.get("diagramSnapshotMode") or "",
            "assetLayout": config.get("assetLayout") or "",
            "forceReauth": bool(config.get("forceReauth")),
            "hasJobControlPath": bool(config.get("jobControlPath")),
            "encryptedPasswordCount": len(encrypted_passwords),
        }

    def _compact_event_for_log(self, payload):
        if not isinstance(payload, dict):
            return str(payload)

        compact = {
            "type": payload.get("type"),
            "phase": payload.get("phase"),
            "status": payload.get("status"),
            "book": payload.get("book"),
            "doc": payload.get("doc"),
            "message": payload.get("message"),
            "error": payload.get("error"),
        }
        return json.dumps({key: value for key, value in compact.items() if value not in (None, "")}, ensure_ascii=False)

    def _build_process_error_message(self, command, exit_code, final_payload, job, crash_report_path):
        reported_error = (final_payload or {}).get("error")
        if reported_error:
            message = reported_error
        else:
            message = f"Command {command} failed with exit code {self._format_exit_code(exit_code)}."

        if exit_code and exit_code >= 0xC0000000:
            message += " Windows detected a native child-process crash."

        last_document = job.get("lastDocument") or {}
        if last_document.get("book") or last_document.get("doc"):
            message += f" Last document: {last_document.get('book', '')} / {last_document.get('doc', '')}."

        if crash_report_path:
            message += f" Diagnostic log: {crash_report_path}"

        return message

    def _write_crash_report(self, job, command, config_summary, node_command, cli_entry, exit_code, final_payload, stdout_tail, event_tail):
        try:
            CRASH_REPORT_DIR.mkdir(parents=True, exist_ok=True)
            report_path = CRASH_REPORT_DIR / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{command}-{job.get('id', 'sync')[:8]}.log"
            recent_dumps = self._find_recent_crash_dumps(job.get("startedAt"))
            lines = [
                f"timestamp={self._now_iso()}",
                f"jobId={job.get('id')}",
                f"jobKind={job.get('kind')}",
                f"command={command}",
                f"exitCode={exit_code}",
                f"formattedExitCode={self._format_exit_code(exit_code)}",
                f"nodeCommand={node_command}",
                f"nodeExists={Path(node_command).exists() if node_command != 'node' else 'system-node'}",
                f"cliEntry={cli_entry}",
                f"cliExists={Path(cli_entry).exists()}",
                f"resourceDir={RESOURCE_DIR}",
                f"resourceDirExists={RESOURCE_DIR.exists()}",
                f"cwd={RESOURCE_DIR}",
                f"python={sys.executable}",
                f"frozen={getattr(sys, 'frozen', False)}",
                "",
                "[config-summary]",
                json.dumps(config_summary, ensure_ascii=False, indent=2),
                "",
                "[last-progress]",
                json.dumps(job.get("lastProgress") or {}, ensure_ascii=False, indent=2),
                "",
                "[last-document]",
                json.dumps(job.get("lastDocument") or {}, ensure_ascii=False, indent=2),
                "",
                "[final-payload]",
                json.dumps(final_payload or {}, ensure_ascii=False, indent=2),
                "",
                "[recent-events]",
                *event_tail,
                "",
                "[stdout-tail]",
                *stdout_tail,
            ]
            if recent_dumps:
                lines.extend([
                    "",
                    "[recent-crash-dumps]",
                    *recent_dumps,
                ])
            report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            job["crashReportPath"] = str(report_path)
            append_launch_log(f"JOB_CRASH_REPORT id={job.get('id')} path={report_path}")
            return str(report_path)
        except Exception as exc:
            append_launch_log(f"JOB_CRASH_REPORT_FAILED id={job.get('id')} error={exc}")
            return ""

    def _find_recent_crash_dumps(self, started_at=None, max_items=8):
        local_app_data = os.environ.get("LOCALAPPDATA")
        if not local_app_data:
            return []

        crash_dump_dir = Path(local_app_data) / "CrashDumps"
        if not crash_dump_dir.exists():
            return []

        started_at_value = None
        if started_at:
            try:
                started_at_value = datetime.fromisoformat(str(started_at))
            except ValueError:
                started_at_value = None

        try:
            dumps = sorted(
                crash_dump_dir.glob("*.dmp"),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
        except Exception:
            return []

        formatted = []
        for dump in dumps[:max_items]:
            try:
                stat = dump.stat()
                modified_at = datetime.fromtimestamp(stat.st_mtime)
                if started_at_value and modified_at < started_at_value:
                    continue
                formatted.append(
                    f"{dump} | modified={modified_at.isoformat(timespec='seconds')} | bytes={stat.st_size}"
                )
            except Exception:
                formatted.append(str(dump))
        return formatted

    def _format_exit_code(self, exit_code):
        if exit_code is None:
            return "unknown"
        if exit_code < 0:
            return str(exit_code)
        if exit_code > 255:
            return f"{exit_code} (0x{exit_code:08X})"
        return str(exit_code)


def main():
    hide_console_window()
    if not acquire_single_instance_guard():
        return
    migrate_legacy_runtime_files()
    os.chdir(RESOURCE_DIR)
    ui_entry = RESOURCE_DIR / "desktop" / "ui" / "index.html"
    styles_entry = RESOURCE_DIR / "desktop" / "ui" / "styles.css"
    app_entry = RESOURCE_DIR / "desktop" / "ui" / "app.js"
    append_launch_log(f"APP_DIR={APP_DIR}")
    append_launch_log(f"RESOURCE_DIR={RESOURCE_DIR}")
    append_launch_log(f"CWD={Path.cwd()}")
    append_launch_log(f"UI_ENTRY={ui_entry}")
    append_launch_log(f"UI_ENTRY_EXISTS={ui_entry.exists()}")
    append_launch_log(f"STYLES_ENTRY_EXISTS={styles_entry.exists()}")
    append_launch_log(f"APP_JS_EXISTS={app_entry.exists()}")
    api = DesktopApi()
    ui_html = load_ui_html()
    append_launch_log(f"UI_HTML_LENGTH={len(ui_html)}")
    window = webview.create_window(
        "语雀导出到 Obsidian",
        html=ui_html,
        js_api=api,
        width=1900,
        height=1040,
        min_size=(1500, 860),
        text_select=True,
    )
    api.attach_window(window)
    try:
        window.events.closing += api.shutdown_jobs
    except Exception as exc:
        append_launch_log(f"WINDOW_CLOSE_HANDLER_FAILED error={exc}")
    append_launch_log("WEBVIEW_START")
    try:
        webview.start(debug=False)
    finally:
        release_single_instance_guard()


if __name__ == "__main__":
    main()


