# 第三方组件与来源声明

本项目自身代码以 [AGPL-3.0](./LICENSE) 分发（商业闭源使用见 [商业授权说明](./COMMERCIAL-LICENSE.md)）。
下列第三方组件按各自条款分发，**不受本项目控制**，本项目也不对其提供担保。

版本以 `package-lock.json` 与 `requirements.txt` 的锁定值为准；
`package.json` 中的 `^` 只是允许范围，不是实际安装版本。

## 上游致谢

功能设计阶段参考过以下项目，**本项目不包含其代码**：

- **renyunkang/yuque-exporter** — <https://github.com/renyunkang/yuque-exporter>（GPL-2.0）

本项目为独立实现，与该上游不存在衍生或补充关系，特此致谢。

## Node.js 直接依赖（运行时）

| 组件 | 声明范围 | 许可证 |
| --- | --- | --- |
| puppeteer | ^25.9.0 | Apache-2.0 |
| axios | ^1.20.0 | MIT |
| @steipete/sweet-cookie | ^0.4.2 | MIT |
| lz-string | 1.5.0 | MIT |
| esm | ^3.2.25 | MIT（npm 元数据未声明，以上游 LICENSE 文件为准） |
| jsonstream | ^1.0.3 | MIT 与 Apache-2.0 双许可文件并存，以上游 LICENSE 文件为准 |

说明：

- `esm` 与 `jsonstream` 在当前源码中已无引用，属历史残留依赖，计划后续清理。
- puppeteer 首次安装会下载 Chrome for Testing；分发打包产物时还需一并遵守
  Chromium / Chrome 自身的许可与版权声明。

## Python 依赖

**运行时**

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| pywebview | 4.0.1 | BSD-3-Clause |
| Pillow | 12.2.0 | MIT-CMU（HPND） |
| requests | 2.32.5 | Apache-2.0 |
| cryptography | 46.0.4 | Apache-2.0 或 BSD-3-Clause（双选） |

**打包期**

| 组件 | 版本 | 许可证 |
| --- | --- | --- |
| PyInstaller | 6.17.0 | GPL-2.0-or-later，附 bootloader 例外条款 |

PyInstaller 的 bootloader 例外允许将打包产物以其他许可证分发；本项目为 AGPL-3.0，
与 PyInstaller 的 GPL-2.0-or-later 不冲突，发布 EXE 不存在额外义务。

上表只列**直接依赖**。传递依赖（如 pywebview 依赖的 pythonnet / bottle、requests 依赖的
urllib3 / certifi）请查阅锁文件与各包自带 LICENSE。

## 商标

Yuque（语雀）与 Obsidian 是各自权利人的商标。本项目是独立的社区工具，
与语雀、Obsidian 及其运营方不存在任何官方关联、合作或背书关系。
项目中出现的相关名称仅用于说明兼容对象。

## 如何自行复核

```powershell
npm ls --all
.\.venv\Scripts\python.exe -m pip list
```

再逐个查看依赖包目录下的 `LICENSE` 文件。
