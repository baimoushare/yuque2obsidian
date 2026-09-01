# OTA 自动更新实施与发布说明

## 1. 当前边界

- 客户端只支持 Windows x64 单文件 EXE 的稳定版更新。
- 第一个包含 OTA 的 `v0.8.0` 需要用户手动安装一次；从 `v0.8.1` 起可通过应用内更新。
- 开发模式 `py desktop_app.py` 可以检查更新，但禁止替换源码运行入口。
- 安装目录不可写、存在登录/扫描/导出任务时，客户端拒绝安装，当前版本保持不变。

## 2. 宝塔目录与公开地址

宝塔目录：

```text
C:/wwwroot/update.baimoushare.cn/yuque2obsidian
```

假定站点根目录为 `C:/wwwroot/update.baimoushare.cn`，客户端访问：

```text
https://update.baimoushare.cn/yuque2obsidian
```

服务器目录结构：

```text
yuque2obsidian/
├─ stable/
│  ├─ manifest.json
│  └─ manifest.sig
└─ releases/
   └─ v0.8.1/
      ├─ YuqueExporterObsidian-0.8.1-win-x64.exe
      └─ release-notes.md
```

- `releases/v*` 发布后不覆盖。
- `stable/manifest.json` 只指向当前稳定版本。
- 不开启目录浏览。
- 只允许 HTTPS；客户端拒绝 HTTP、重定向、站外下载地址和带用户名密码的 URL。

## 3. 签名密钥

- 客户端内置 Ed25519 公钥，只接受该公钥签名的 `manifest.json`。
- 当前本机私钥位于：`%LOCALAPPDATA%\YuqueExporterObsidian\ota-signing\ed25519-private.pem`。
- 私钥不进入 Git、不上传宝塔、不写入日志，也不应通过聊天或截图发送。
- 如迁移到新发布电脑，应离线复制私钥，并在复制后核验公钥仍与客户端内置公钥一致。

## 4. 本地发布流程

1. 更新 `package.json` 的三段式版本号，并更新 `CHANGELOG.md`。
2. 运行 Node、Python 测试及 `npm run build:exe`。
3. 可选配置 `YUQUE_CODE_SIGN_CERT_THUMBPRINT` 进行 Windows Authenticode 签名。
4. 生成宝塔待上传目录：

```powershell
$key = Join-Path $env:LOCALAPPDATA 'YuqueExporterObsidian\ota-signing\ed25519-private.pem'
.\publish_ota.ps1 `
  -Version 0.8.1 `
  -Title '简短更新标题' `
  -Note '第一条重要变化' `
  -Note '第二条重要变化' `
  -PrivateKeyPath $key
```

5. 脚本输出 `release/ota-upload/`；按照其中 `上传顺序.txt` 上传到宝塔目录。
6. 上传后访问 `https://update.baimoushare.cn/yuque2obsidian/stable/manifest.json`，确认版本、包地址、文件大小和 SHA-256 正确。

## 5. 宝塔/Nginx 建议

```nginx
location = /yuque2obsidian/stable/manifest.json {
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
}

location = /yuque2obsidian/stable/manifest.sig {
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
}

location /yuque2obsidian/releases/ {
    autoindex off;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}
```

站点必须启用有效 TLS 证书；manifest 不应被 CDN 长时间缓存，版本 EXE 可以长期缓存。

## 6. 更新时序与回滚

```text
检查签名清单 → 下载 EXE → SHA-256/可选 Authenticode 校验
→ 复制当前 EXE 为 helper → 退出主程序 → helper 替换 EXE
→ 启动新版 → WebView 加载完成写健康标记 → 成功
                                      └ 未完成 → 恢复 .previous
```

- 每次替换前保留 `YuqueExporterObsidian.exe.previous`。
- 更新失败的 EXE 和旧备份转移到用户数据目录 `updates/history/`。
- 关闭程序或中断下载不会覆盖当前可运行版本。

## 7. 发布验收

- 用隔离目录手动安装 `v0.8.0`。
- 服务器发布 `v0.8.1` manifest 和 EXE。
- 在 `v0.8.0` 设置弹窗中检查、下载、安装，确认新版本启动。
- 使用故意无健康标记的测试包，确认 helper 自动恢复 `.previous`。
- 篡改 manifest、manifest.sig、SHA-256 或 EXE 任一项，确认客户端拒绝安装。
- 确认导出任务运行期间“安装并重启”被拒绝。
