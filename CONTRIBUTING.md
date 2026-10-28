# 参与贡献

感谢你愿意改进这个项目。提交前请先读这一页，能省掉大量来回沟通。

## 先开 Issue，再写代码

- **缺陷**：先用「缺陷报告」模板提交，确认可复现后再动手
- **新功能**：先提交「功能建议」说明场景，避免写完被判定超出范围
- 小改动（错别字、注释、单行修复）可以直接提 PR

## 环境准备

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 提交前必须自测

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s test -p 'test_*.py'
```

PR 描述里请如实写明：跑了哪些测试、结果如何、哪些**没跑**以及原因。
CI 会跑同样两组测试，但本地先过一遍能省时间。

## 代码约定

- 保持现有风格，不要顺手重排无关代码或改格式
- 复杂逻辑、关键流程、容易误解的实现请写**中文注释**
- 新增行为要配测试；修复缺陷优先补一条能复现该缺陷的测试
- 不引入未使用的依赖；不为了「以后可能用到」增加抽象

## 不要提交这些

- `cookies.json`、`desktop.settings.json`、`.yuque-login-profile/`
- `release/`、`output/`、`runtime-validation/`、`crash-reports/`、`*.log`
- 任何真实笔记正文、截图中的真实账号信息
- 任何密钥、令牌、私钥

提交前自查：

```powershell
git status --short
git diff --cached
```

## 隐私红线

导出的语雀内容可能包含个人、团队或受版权保护的信息。
**请勿**把真实导出结果、登录截图、Cookie 贴到 Issue、PR 或测试用例里。
写测试请使用构造的假数据。

## 许可证与贡献授权

本项目采用 AGPL-3.0 + 商业授权双许可（详见 [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)）。

提交代码即表示你同意：

1. 你的贡献以 AGPL-3.0 授权给本项目及所有使用者；
2. 你授予维护者以其他许可证（含商业授权）再许可该贡献的权利。

这是维持双许可模式所必需的。若你不接受第 2 条，请改为提交 Issue 描述需求，
由维护者自行实现。

另外请确认：你提交的代码由你自己编写，没有复制来源不明或许可证不兼容的片段。
如需引入第三方代码，请先在 Issue 中说明来源与许可证。

## 提交信息

- 使用中文或英文均可，一句话说清「做了什么」
- 涉及行为的改动请说明「为什么」
- 不要把多个不相关改动塞进同一个提交
