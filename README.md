# 语雀笔记导出 MD

一个面向 Windows 桌面的语雀内容导出工具，将知识库和文档迁移为适合本地保存、归档和 Obsidian 使用的 Markdown 资料。

## 功能

- 桌面端登录、扫描知识库、树形选择知识库或单篇文档
- 导出 Markdown 正文，并处理图片、附件和相对路径
- 失败日志 CSV、失败记录重导、增量导出和暂停后继续
- 数据表、电子表格、画板和复杂块的结构化导出与降级兜底
- Obsidian 仓库直写、资源整理、Bases 相关落地
- Windows EXE 打包脚本和运行时验证测试

## 环境要求

- Windows 10/11
- Node.js 22.12 或更新版本（Puppeteer 25 要求）
- Python 3.11 或更新版本
- 首次运行需要能访问语雀，并在浏览器中完成登录

## 安装与运行

建议使用 npm，仓库同时保留 `package-lock.json`，不需要使用 Yarn。

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

启动桌面端：

```powershell
npm run desktop
```

运行测试：

```powershell
npm test
python -m unittest discover -s test -p 'test_*.py'
```

构建 Windows EXE：

```powershell
npm run build:exe
```

打包脚本会从当前机器查找 Node.js，并将其作为运行时文件带入 EXE；不会把登录 Cookie 或个人桌面配置打进公开构建产物。

如已配置 Windows 代码签名证书，可将证书指纹写入环境变量 `YUQUE_CODE_SIGN_CERT_THUMBPRINT`；构建脚本会调用 `signtool.exe` 签名并验证。没有证书时仍会生成包含 SHA-256 的 `release/manifest.json`，但 Windows 不会显示受信任发布者。

## 目录结构

- `desktop/`：桌面端界面资源
- `src/`：Node.js 导出内核和语雀内容处理逻辑
- `test/`：Node.js 与 Python 自动化测试
- `docs/`：方案设计、版本记录和问题修复文档
- `images/`：README 或演示素材
- `desktop_app.py`：桌面程序入口
- `desktop_retry.py`：失败日志重导辅助逻辑
- `build_windows_exe.ps1`：Windows 打包脚本
- `YuqueExporterObsidian.spec`：PyInstaller 配置参考

以下目录属于本地运行或构建产物，不应提交到版本库：

`output/`、`release/`、`runtime-validation/`、`.yuque-login-profile/`、`cookies.json`、`desktop.settings.json`、`crash-reports/`。

## 登录态与隐私

- 登录 Cookie 默认保存在 `%LOCALAPPDATA%\\YuqueExporterObsidian\\cookies.json`，Windows 下使用当前用户 DPAPI 保护。
- 浏览器登录资料保存在用户数据目录下的 `.yuque-login-profile/`。
- `desktop.settings.json` 只保存普通导出选项；加密块密码仅在本次任务内存中使用，不会持久化。
- 发布脚本不会把 Cookie 或个人配置打进 EXE；分享前仍需检查 `release/`、日志和导出内容。
- 导出的语雀内容可能包含个人、团队或受版权保护的信息，请在分享前确认你拥有相应授权。

## 已知限制

- 语雀页面结构或接口调整后，部分导出功能可能需要同步修改。
- 复杂画板、数据表和特殊块会根据结构完整度选择 Mermaid、Excalidraw、附件或 PNG 等输出形式。
- 语雀账号权限、团队空间和加密内容的可导出范围取决于当前登录账号。
- 本项目不是语雀或 Obsidian 官方产品，也不代表与其存在官方关联。

## 文档

- [项目目录说明](./docs/项目目录说明.md)
- [软件基础功能总览](./docs/软件基础功能总览.md)
- [软件更新说明](./docs/软件更新说明.md)
- [OTA 自动更新实施与发布说明](./docs/OTA自动更新实施与发布说明.md)
- [语雀数据表留存与 Obsidian 落地方案](./docs/语雀数据表留存与%20Obsidian%20落地方案.md)

## 开源许可

本项目使用 GNU GPL v3，详见 [LICENSE](./LICENSE)。第三方依赖按各自许可证分发。

Yuque and Obsidian are trademarks of their respective owners. This project is an independent community tool and is not officially affiliated with either organization.

## 反馈

提交 Issue 时请删除 Cookie、登录资料、真实导出内容、个人路径和其他敏感信息。安全问题请不要直接公开粘贴凭据或会话数据。
