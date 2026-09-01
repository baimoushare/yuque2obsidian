"""Windows 桌面端 OTA 更新核心。

更新源只承载静态文件：客户端先验证已签名的 manifest，再下载并校验 EXE；
真正替换正在运行的 EXE 时，由当前程序复制出的 helper 进程完成并负责回滚。
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


APP_ID = "yuque-exporter-obsidian"
APP_EXE_NAME = "YuqueExporterObsidian.exe"
USER_DATA_DIR_NAME = "YuqueExporterObsidian"
UPDATE_CHANNEL = "stable"
DEFAULT_UPDATE_BASE_URL = "https://update.baimoushare.cn/yuque2obsidian"
# 首次 OTA 签名密钥生成于本机用户数据目录；私钥绝不进入仓库或宝塔服务器。
UPDATE_PUBLIC_KEY_B64 = "j9ml8WhCfESa+i3NBmQKBkgsKvZ/aYmQLpIJDM/6lJE="
MANIFEST_MAX_BYTES = 512 * 1024
PACKAGE_MAX_BYTES = 2 * 1024 * 1024 * 1024
AUTO_CHECK_INTERVAL_SECONDS = 24 * 60 * 60
HEALTH_TIMEOUT_SECONDS = 40
SEMVER_RE = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class UpdateError(RuntimeError):
    """更新过程的可展示错误。"""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """OTA 不跟随重定向，避免签名清单把下载导向意外地址。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        raise UpdateError(f"更新服务器返回了不允许的重定向（HTTP {code}）。")


def utc_now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def atomic_write_text(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def atomic_write_json(path, value):
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def read_json_file(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


def parse_semver(value):
    match = SEMVER_RE.fullmatch(str(value or "").strip())
    if not match:
        raise UpdateError(f"不支持的版本号格式：{value!r}。OTA 仅接受 v主.次.修订 三段式版本号。")
    return tuple(int(part) for part in match.groups())


def compare_versions(left, right):
    """返回 left 相对于 right 的大小：-1、0、1。"""
    left_value = parse_semver(left)
    right_value = parse_semver(right)
    return (left_value > right_value) - (left_value < right_value)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def read_app_version(resource_dir):
    package_path = Path(resource_dir) / "package.json"
    package = read_json_file(package_path, {}) or {}
    version = str(package.get("version") or "").strip()
    try:
        parse_semver(version)
        return version
    except UpdateError:
        # 开发或历史安装包遗漏 package.json 时保持可运行，但不允许误判为新版本。
        return "0.0.0"


def get_user_data_dir():
    """返回与桌面端一致的当前用户运行数据目录。"""
    local_data_root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share"))
    return local_data_root / USER_DATA_DIR_NAME


def _is_within(path, parent):
    """路径必须位于 parent 内，且不能把同名兄弟目录误判为子目录。"""
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


def _decode_signature(signature_bytes):
    try:
        return base64.b64decode(signature_bytes.strip(), validate=True)
    except (ValueError, TypeError) as exc:
        raise UpdateError("更新签名文件格式无效。") from exc


def verify_manifest_signature(manifest_bytes, signature_bytes, public_key_b64=UPDATE_PUBLIC_KEY_B64):
    """验证 detached Ed25519 签名，失败时一律拒绝更新。"""
    try:
        public_key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64, validate=True))
        public_key.verify(_decode_signature(signature_bytes), manifest_bytes)
    except (ValueError, InvalidSignature) as exc:
        raise UpdateError("更新清单签名校验失败，已拒绝本次更新。") from exc


def _validate_https_url(raw_url, base_url):
    parsed = urllib.parse.urlparse(str(raw_url or ""))
    expected = urllib.parse.urlparse(str(base_url or ""))
    if parsed.scheme != "https" or not parsed.hostname:
        raise UpdateError("更新地址必须使用 HTTPS。")
    if parsed.username or parsed.password:
        raise UpdateError("更新地址不能包含用户名或密码。")
    if parsed.hostname.lower() != expected.hostname.lower():
        raise UpdateError("更新包地址不属于受信任的更新服务器。")
    expected_prefix = expected.path.rstrip("/") + "/"
    if not parsed.path.startswith(expected_prefix):
        raise UpdateError("更新包路径不属于受信任的更新目录。")
    return parsed


def validate_manifest(manifest, current_version, base_url):
    if not isinstance(manifest, dict):
        raise UpdateError("更新清单不是 JSON 对象。")
    if manifest.get("schemaVersion") != 1:
        raise UpdateError("更新清单版本不受支持。")
    if manifest.get("appId") != APP_ID or manifest.get("channel") != UPDATE_CHANNEL:
        raise UpdateError("更新清单不属于当前程序或更新频道。")

    version = str(manifest.get("version") or "").strip()
    if compare_versions(version, current_version) <= 0:
        return {"available": False, "version": version}

    package = manifest.get("package")
    if not isinstance(package, dict):
        raise UpdateError("更新清单缺少安装包信息。")
    if package.get("platform") != "windows-x64":
        raise UpdateError("更新包平台与当前 Windows x64 程序不匹配。")
    _validate_https_url(package.get("url"), base_url)
    try:
        size = int(package.get("size"))
    except (TypeError, ValueError) as exc:
        raise UpdateError("更新清单中的文件大小无效。") from exc
    if size <= 0 or size > PACKAGE_MAX_BYTES:
        raise UpdateError("更新包大小超出安全范围。")
    sha256 = str(package.get("sha256") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise UpdateError("更新清单中的 SHA-256 无效。")
    notes = manifest.get("notes") or []
    if not isinstance(notes, list):
        notes = []
    return {
        "available": True,
        "version": version,
        "title": str(manifest.get("title") or "新版本可用"),
        "notes": [str(item) for item in notes[:12]],
        "mandatory": bool(manifest.get("mandatory")),
        "package": {
            "url": str(package["url"]),
            "size": size,
            "sha256": sha256,
            "authenticodeThumbprint": str(package.get("authenticodeThumbprint") or "").upper(),
        },
    }


def _fetch_bytes(url, maximum_bytes):
    request = urllib.request.Request(url, headers={"User-Agent": f"YuqueExporterObsidian/{APP_ID}"})
    opener = urllib.request.build_opener(NoRedirectHandler())
    try:
        with opener.open(request, timeout=12) as response:
            length = response.headers.get("Content-Length")
            if length and int(length) > maximum_bytes:
                raise UpdateError("更新响应超过安全大小限制。")
            payload = response.read(maximum_bytes + 1)
    except UpdateError:
        raise
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise UpdateError(f"无法连接更新服务器：{exc}") from exc
    if len(payload) > maximum_bytes:
        raise UpdateError("更新响应超过安全大小限制。")
    return payload


def _verify_authenticode(path, expected_thumbprint):
    """仅当 manifest 显式声明证书指纹时强制验证 Authenticode。"""
    if not expected_thumbprint:
        return
    if os.name != "nt":
        raise UpdateError("当前平台不能验证 Windows Authenticode 签名。")
    script = (
        "$signature=Get-AuthenticodeSignature -LiteralPath $args[0];"
        "[PSCustomObject]@{Status=$signature.Status.ToString();Thumbprint=$signature.SignerCertificate.Thumbprint}|"
        "ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError("无法验证更新包的 Windows 签名。")
    details = read_json_file_from_text(result.stdout)
    actual = str((details or {}).get("Thumbprint") or "").replace(" ", "").upper()
    if str((details or {}).get("Status") or "") != "Valid" or actual != expected_thumbprint.replace(" ", ""):
        raise UpdateError("更新包的 Windows 签名或发布者证书不匹配。")


def read_json_file_from_text(value):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


class UpdateService:
    """桌面端生命周期中的更新状态、下载和安装准备。"""

    def __init__(self, user_data_dir, resource_dir, app_path=None, base_url=None, public_key_b64=UPDATE_PUBLIC_KEY_B64):
        self.user_data_dir = Path(user_data_dir)
        self.resource_dir = Path(resource_dir)
        self.app_path = Path(app_path).resolve() if app_path else None
        self.base_url = (base_url or DEFAULT_UPDATE_BASE_URL).rstrip("/")
        self.public_key_b64 = public_key_b64
        self.current_version = read_app_version(self.resource_dir)
        self.state_file = self.user_data_dir / "updates" / "update-state.json"
        self._lock = threading.RLock()
        self._cancel_download = threading.Event()
        self._state = self._load_state()

    def _load_state(self):
        state = read_json_file(self.state_file, {}) or {}
        return {
            "status": str(state.get("status") or "idle"),
            "message": str(state.get("message") or "尚未检查更新"),
            "lastCheckedAt": str(state.get("lastCheckedAt") or ""),
            "availableUpdate": state.get("availableUpdate") if isinstance(state.get("availableUpdate"), dict) else None,
            "downloadedPath": str(state.get("downloadedPath") or ""),
            "downloadedVersion": str(state.get("downloadedVersion") or ""),
            "progress": max(0, min(100, int(state.get("progress") or 0))),
            "error": str(state.get("error") or ""),
        }

    def _persist(self):
        atomic_write_json(self.state_file, self._state)

    def snapshot(self):
        with self._lock:
            return {
                **self._state,
                "currentVersion": self.current_version,
                "isPackaged": bool(self.app_path),
                "canInstall": bool(self.app_path and _directory_is_writable(self.app_path.parent)),
            }

    def should_auto_check(self):
        with self._lock:
            value = self._state.get("lastCheckedAt")
        if not value:
            return True
        try:
            previous = datetime.fromisoformat(value)
        except ValueError:
            return True
        return (datetime.now(previous.tzinfo) - previous).total_seconds() >= AUTO_CHECK_INTERVAL_SECONDS

    def check(self, force=False):
        if not force and not self.should_auto_check():
            return self.snapshot()
        with self._lock:
            if self._state["status"] == "checking":
                return self.snapshot()
            self._state.update({"status": "checking", "message": "正在检查更新…", "error": ""})
            self._persist()

        try:
            manifest_url = f"{self.base_url}/stable/manifest.json"
            signature_url = f"{self.base_url}/stable/manifest.sig"
            manifest_bytes = _fetch_bytes(manifest_url, MANIFEST_MAX_BYTES)
            signature_bytes = _fetch_bytes(signature_url, 16 * 1024)
            verify_manifest_signature(manifest_bytes, signature_bytes, self.public_key_b64)
            manifest = json.loads(manifest_bytes.decode("utf-8"))
            update = validate_manifest(manifest, self.current_version, self.base_url)
            with self._lock:
                self._state.update(
                    {
                        "status": "available" if update["available"] else "up-to-date",
                        "message": f"发现新版本 v{update['version']}" if update["available"] else "当前已是最新版本",
                        "lastCheckedAt": utc_now_iso(),
                        "availableUpdate": update if update["available"] else None,
                        "error": "",
                        "progress": 0,
                    }
                )
                self._persist()
        except (UnicodeDecodeError, ValueError, UpdateError) as exc:
            with self._lock:
                self._state.update({"status": "error", "message": "检查更新失败", "error": str(exc), "lastCheckedAt": utc_now_iso()})
                self._persist()
        return self.snapshot()

    def start_download(self):
        with self._lock:
            update = self._state.get("availableUpdate")
            if not update:
                raise UpdateError("尚未发现可下载的新版本，请先检查更新。")
            if self._state["status"] == "downloading":
                return self.snapshot()
            self._cancel_download.clear()
            self._state.update({"status": "downloading", "message": "正在下载更新…", "progress": 0, "error": ""})
            self._persist()
            thread = threading.Thread(target=self._download_worker, args=(update,), daemon=True, name="ota-download")
            thread.start()
        return self.snapshot()

    def cancel_download(self):
        self._cancel_download.set()
        return self.snapshot()

    def _download_worker(self, update):
        try:
            package = update["package"]
            _validate_https_url(package["url"], self.base_url)
            version = update["version"]
            stage_dir = self.user_data_dir / "updates" / "staging" / f"v{version}"
            stage_dir.mkdir(parents=True, exist_ok=True)
            target = stage_dir / f"YuqueExporterObsidian-{version}-win-x64.exe"
            partial = target.with_suffix(".exe.part")
            if partial.exists():
                partial.unlink()

            request = urllib.request.Request(package["url"], headers={"User-Agent": f"YuqueExporterObsidian/{self.current_version}"})
            opener = urllib.request.build_opener(NoRedirectHandler())
            with opener.open(request, timeout=25) as response, partial.open("wb") as output:
                advertised_length = response.headers.get("Content-Length")
                if advertised_length and int(advertised_length) != package["size"]:
                    raise UpdateError("更新服务器返回的文件大小与签名清单不一致。")
                received = 0
                while True:
                    if self._cancel_download.is_set():
                        raise UpdateError("更新下载已取消。")
                    chunk = response.read(1024 * 512)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > package["size"] or received > PACKAGE_MAX_BYTES:
                        raise UpdateError("更新包超过签名清单声明的安全大小。")
                    output.write(chunk)
                    with self._lock:
                        self._state["progress"] = min(99, int(received * 100 / package["size"]))
                        self._state["message"] = f"正在下载更新… {self._state['progress']}%"
                        self._persist()
            if received != package["size"]:
                raise UpdateError("更新包下载不完整。")
            if sha256_file(partial).lower() != package["sha256"]:
                raise UpdateError("更新包 SHA-256 校验失败，文件已拒绝使用。")
            _verify_authenticode(partial, package.get("authenticodeThumbprint"))
            os.replace(partial, target)
            with self._lock:
                self._state.update(
                    {
                        "status": "downloaded",
                        "message": "更新已下载，退出程序后即可安装。",
                        "downloadedPath": str(target),
                        "downloadedVersion": version,
                        "progress": 100,
                        "error": "",
                    }
                )
                self._persist()
        except (urllib.error.URLError, OSError, ValueError, UpdateError) as exc:
            try:
                if "partial" in locals() and partial.exists():
                    partial.unlink()
            except OSError:
                pass
            with self._lock:
                self._state.update({"status": "error", "message": "更新下载失败", "error": str(exc), "progress": 0})
                self._persist()

    def prepare_apply(self):
        with self._lock:
            update = self._state.get("availableUpdate")
            downloaded_path = Path(self._state.get("downloadedPath") or "")
            if self._state.get("status") != "downloaded" or not update or not downloaded_path.is_file():
                raise UpdateError("没有已验证的更新包可安装。")
        if not self.app_path:
            raise UpdateError("当前为开发模式，只支持检查更新，不能替换源码运行入口。")
        if not _directory_is_writable(self.app_path.parent):
            raise UpdateError("当前安装目录没有写入权限。请将程序放到当前用户可写目录后再更新。")
        if sha256_file(downloaded_path).lower() != update["package"]["sha256"]:
            raise UpdateError("已下载更新包的校验结果已失效，请重新下载。")

        token = uuid.uuid4().hex
        updates_root = self.user_data_dir / "updates"
        task_path = updates_root / "tasks" / f"apply-{token}.json"
        health_path = updates_root / "health" / f"{token}.json"
        helper_path = updates_root / "helpers" / f"update-runner-{token}.exe"
        helper_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.app_path, helper_path)
        task = {
            "schemaVersion": 1,
            "token": token,
            "pid": os.getpid(),
            "targetExe": str(self.app_path),
            "stagedExe": str(downloaded_path),
            "expectedVersion": update["version"],
            "expectedSha256": update["package"]["sha256"],
            "healthPath": str(health_path),
            "createdAt": utc_now_iso(),
        }
        atomic_write_json(task_path, task)
        subprocess.Popen([str(helper_path), "--apply-update", str(task_path)], cwd=str(helper_path.parent), close_fds=True)
        with self._lock:
            self._state.update({"status": "applying", "message": "正在关闭程序并安装更新…", "error": ""})
            self._persist()
        return {"status": "applying", "token": token, "version": update["version"]}

    def report_post_update_health(self, token, version):
        if not token or not version:
            return
        # 健康标记只认可新 EXE 自己读取到的版本。否则即使下载包被错误发布为
        # 旧版本，也不能让 helper 把“成功启动”误判为“成功更新”。
        if compare_versions(self.current_version, version) != 0:
            return
        health_path = self.user_data_dir / "updates" / "health" / f"{token}.json"
        atomic_write_json(health_path, {"token": token, "version": version, "reportedAt": utc_now_iso()})
        with self._lock:
            self._state.update(
                {
                    "status": "up-to-date",
                    "message": "更新已安装并成功启动。",
                    "availableUpdate": None,
                    "downloadedPath": "",
                    "downloadedVersion": "",
                    "progress": 0,
                    "error": "",
                }
            )
            self._persist()


def _directory_is_writable(directory):
    directory = Path(directory)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / f".ota-write-{uuid.uuid4().hex}.tmp"
        probe.write_text("probe", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _wait_for_process_exit(pid, timeout_seconds=45):
    if pid <= 0:
        return
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if os.name == "nt":
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            if str(pid) not in result.stdout:
                return
        else:
            try:
                os.kill(pid, 0)
            except OSError:
                return
        time.sleep(0.4)
    raise UpdateError("等待旧版本退出超时，已取消替换。")


def _write_helper_result(task, status, message):
    result_path = Path(task["healthPath"]).parent.parent / "results" / f"{task['token']}.json"
    atomic_write_json(result_path, {"status": status, "message": message, "finishedAt": utc_now_iso()})


def apply_update_task(task_path):
    """由复制出来的旧 EXE 调用；成功后返回 0，回滚后返回非零。"""
    task_path = Path(task_path).resolve()
    updates_root = get_user_data_dir() / "updates"
    tasks_dir = updates_root / "tasks"
    staging_dir = updates_root / "staging"
    health_dir = updates_root / "health"
    state_path = updates_root / "update-state.json"
    if task_path.parent != tasks_dir.resolve() or not re.fullmatch(r"apply-[0-9a-f]{32}\.json", task_path.name):
        raise UpdateError("更新任务路径不受信任，已拒绝执行。")

    task = read_json_file(task_path)
    if not isinstance(task, dict) or task.get("schemaVersion") != 1:
        raise UpdateError("更新任务文件无效。")
    target = Path(str(task.get("targetExe") or "")).resolve()
    staged = Path(str(task.get("stagedExe") or "")).resolve()
    expected_sha256 = str(task.get("expectedSha256") or "").lower()
    expected_version = str(task.get("expectedVersion") or "")
    health_path = Path(str(task.get("healthPath") or "")).resolve()
    token = str(task.get("token") or "")
    expected_stage_dir = (staging_dir / f"v{expected_version}").resolve()
    expected_stage_name = f"YuqueExporterObsidian-{expected_version}-win-x64.exe"
    expected_health_path = (health_dir / f"{token}.json").resolve()
    if (
        not re.fullmatch(r"[0-9a-f]{32}", token)
        or target.name != APP_EXE_NAME
        or not target.is_file()
        or not _is_within(staged, staging_dir)
        or staged.parent != expected_stage_dir
        or staged.name != expected_stage_name
        or not staged.is_file()
        or health_path != expected_health_path
        or not _is_within(health_path, health_dir)
    ):
        raise UpdateError("更新任务包含无效的程序或安装包路径。")
    state = read_json_file(state_path, {}) or {}
    if (
        Path(str(state.get("downloadedPath") or "")).resolve() != staged
        or str(state.get("downloadedVersion") or "") != expected_version
    ):
        raise UpdateError("更新任务与已验证下载包不匹配，已拒绝执行。")
    if sha256_file(staged).lower() != expected_sha256:
        raise UpdateError("安装前 SHA-256 二次校验失败。")

    _wait_for_process_exit(int(task.get("pid") or 0))
    target_dir = target.parent
    staged_near_target = target_dir / f"{target.name}.new"
    backup = target_dir / f"{target.name}.previous"
    history_dir = Path(task["healthPath"]).parent.parent / "history"
    history_dir.mkdir(parents=True, exist_ok=True)
    if staged_near_target.exists():
        staged_near_target.unlink()
    shutil.copy2(staged, staged_near_target)
    if sha256_file(staged_near_target).lower() != expected_sha256:
        staged_near_target.unlink(missing_ok=True)
        raise UpdateError("准备替换文件时 SHA-256 校验失败。")

    if backup.exists():
        archived_backup = history_dir / f"{target.name}.previous-{datetime.now().strftime('%Y%m%d-%H%M%S')}.exe"
        os.replace(backup, archived_backup)
    os.replace(target, backup)
    try:
        os.replace(staged_near_target, target)
        process = subprocess.Popen([str(target), "--post-update", str(task["token"]), expected_version], cwd=str(target_dir), close_fds=True)
        deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            marker = read_json_file(health_path, {}) or {}
            if marker.get("token") == task["token"] and marker.get("version") == expected_version:
                _write_helper_result(task, "success", "更新已安装并完成启动健康检查。")
                return 0
            if process.poll() is not None:
                break
            time.sleep(0.4)
        raise UpdateError("新版程序未在限定时间内完成健康检查。")
    except Exception as exc:
        failed_path = history_dir / f"{target.name}.failed-{datetime.now().strftime('%Y%m%d-%H%M%S')}.exe"
        try:
            if target.exists():
                os.replace(target, failed_path)
            os.replace(backup, target)
            subprocess.Popen([str(target)], cwd=str(target_dir), close_fds=True)
            _write_helper_result(task, "rolled-back", f"更新失败，已恢复上一版本：{exc}")
        except OSError as rollback_error:
            _write_helper_result(task, "rollback-failed", f"更新失败且回滚失败：{rollback_error}")
        return 1
