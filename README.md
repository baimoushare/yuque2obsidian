# 语雀笔记导出 MD

一个以桌面端为主的语雀导出工具，目标是把语雀内容更完整地迁移为适合本地保存和 Obsidian 使用的 Markdown 资料。

当前项目已经具备这些核心能力：

- 桌面端登录、扫描知识库、树形勾选知识库与单篇文档
- Markdown 正文导出，并处理图片、附件与相对路径
- 失败日志 CSV 记录与按失败日志重导
- 增量导出、导出状态保存、暂停后继续
- 复杂内容增强导出，包括数据表、画板、电子表格、复杂块兜底
- Obsidian 适配，包括仓库直写、资源整理、Bases 相关落地能力
- Windows EXE 打包脚本与桌面发布链路

## 运行方式

### 1. 安装依赖

```powershell
npm install
```

如果需要桌面打包相关能力，再安装 Python 依赖：

```powershell
python -m pip install -r requirements.txt
```

### 2. 启动桌面端

```powershell
npm run desktop
```

### 3. 运行测试

```powershell
npm test
```

### 4. 构建 Windows EXE

```powershell
npm run build:exe
```

## 目录结构

项目当前推荐按下面的方式理解和维护：

- `desktop/`
桌面端前端界面资源。

- `src/`
Node.js 导出内核与语雀内容处理逻辑。

- `test/`
自动化测试。

- `docs/`
方案设计、版本总结、问题修复记录等项目文档。

- `images/`
README 或演示素材。

- `output/`
导出结果目录，属于运行产物，默认不纳入版本管理。

- `release/`
桌面打包产物目录，属于发布产物，默认不纳入版本管理。

- `desktop_app.py`
桌面程序入口。

- `desktop_retry.py`
按失败日志重导的辅助逻辑。

- `build_windows_exe.ps1`
Windows 打包脚本。

- `YuqueExporterObsidian.spec`
PyInstaller 打包配置。

## 本地文件约定

- `cookies.json`
本地登录态文件，保留在项目根目录供桌面端和打包产物使用，不建议提交到 Git。

- `desktop.settings.json`
本地桌面配置文件，不建议提交到 Git。

- `desktop-launch.log`
运行日志文件，属于临时产物，应忽略并定期清理。

## 文档索引

- [项目目录说明](./docs/项目目录说明.md)
- [软件基础功能总览](./docs/软件基础功能总览.md)
- [项目更新记录-桌面版重构](./docs/项目更新记录-桌面版重构.md)
- [软件更新说明](./docs/软件更新说明.md)
- [语雀数据表留存与 Obsidian 落地方案](./docs/语雀数据表留存与%20Obsidian%20落地方案.md)
- [链接拼接错乱问题修复记录-2026-03-25](./docs/链接拼接错乱问题修复记录-2026-03-25.md)
- [版本总结-近期提交与未提交更新-2026-04-17](./docs/版本总结-近期提交与未提交更新-2026-04-17.md)

## 当前建议

- 日常开发优先使用 `npm run desktop` 和 `npm test`
- 导出结果、运行日志、虚拟环境、手工验证目录不要再提交进 Git
- 如果准备正式封版，建议补一份最终发布说明，并统一对外版本号口径
