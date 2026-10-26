# dsh-everything

[English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，为模型注册 **`everything_search`** 工具：借助本机 [Everything](https://www.voidtools.com/)（voidtools）索引，通过官方命令行 `es.exe` 实现**毫秒级**全盘文件/文件夹搜索。

当模型需要找文件时，不再递归遍历目录（glob），而是直接查询 Everything 预先建好的索引——即使磁盘上有数百万文件也是秒回。

## 环境要求

- **Windows**（Everything 是 Windows 独占应用；其他平台上插件会注册一个明确报错的占位工具）
- [Everything 1.4+](https://www.voidtools.com/zh-cn/downloads/) 与 [ES 命令行工具](https://www.voidtools.com/zh-cn/downloads/)（`es.exe`）——**缺失时插件会自动安装**（见下文）

### 自动安装后端（默认）

`autoInstall: true`（默认）时，插件在检测到后端缺失后会自行准备环境：

1. 从 voidtools.com 下载页解析**最新稳定版** ES CLI，下载压缩包并把 `es.exe` 解压到 `%LOCALAPPDATA%\dsh-everything\bin`（用户目录，无需管理员）。
2. 优先用 `winget install voidtools.Everything` 安装 **Everything**；没有 winget 时下载最新稳定版官方安装包静默运行——两种方式都可能弹**一次 UAC 授权框**。
3. 启动 Everything 并等待其 IPC 就绪后才执行搜索。

下载**始终直连优先**——无需任何代理工具，系统代理设置残留也不会影响安装；代理（`HTTPS_PROXY`/`HTTP_PROXY` 环境变量或 Windows 系统代理）只作为兜底。完整性校验：解析到的版本与 [`setup.js`](setup.js) 记录的已知良好版本一致时做 SHA256 校验；更新的上游版本改验 **voidtools 数字签名**；下载页不可达时回退到已知良好版本（SHA256 校验）。校验失败一律中止安装。

插件还会保持**自装**的 `es.exe` 不过时：启动时会比对文件版本与插件内置的已知良好版本，落后才升级，且只升级自己装的副本（用户自装的 es.exe 永不动）。

想完全自己装后端，可设 `autoInstall: false`：

```powershell
winget install --id voidtools.Everything --silent
Invoke-WebRequest https://www.voidtools.com/ES-1.1.0.37.x64.zip -OutFile ES.zip
Expand-Archive ES.zip -DestinationPath "C:\Program Files\Everything" -Force
Start-Process "C:\Program Files\Everything\Everything.exe"
```

## 安装

在 DSH 会话中让插件管理器安装本包目录（或发布后的 npm 包名）：

```
plugin_manager install_bundle，target = 本包目录的绝对路径
```

插件以 `dsh-everything` 激活，并为该 profile 下的所有 Agent 注册 `everything_search` 工具。

## 工具：everything_search

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` *（必填）* | string | Everything 搜索表达式：`report ext:docx`、`*.sln dm:thisweek`、`path:\projects\ ext:py`。空格 = 与，`\|` = 或，`!` = 非，双引号 = 精确短语。 |
| `path` | string | 限定在某目录及其子目录内（绝对路径）。 |
| `maxResults` | integer | 返回条数上限（默认 100，封顶 1000）。 |
| `offset` | integer | 跳过前 N 条（分页）。 |
| `sort` | string | 排序，如 `date-modified-descending`、`size-descending`、`name-ascending`。键：`name`、`path`、`size`、`extension`、`date-created`、`date-modified`、`date-accessed`、`run-count`，可加 `-ascending`/`-descending`。 |
| `regex` | boolean | 把 `query` 当作全路径正则表达式。 |
| `matchCase` | boolean | 区分大小写（默认不区分）。 |
| `wholeWord` | boolean | 整词匹配。 |
| `foldersOnly` / `filesOnly` | boolean | 只看文件夹 / 只看文件。 |
| `dateCreated` | boolean | 一并返回每个结果的创建时间。 |
| `countOnly` | boolean | 只返回匹配总数——判断存在性、估量级的最快方式。 |

返回 `{ query, total, truncated, results: [{ path, size, dateModified, dateCreated? }] }`，在会话里以搜索路径卡片展示。

典型查询：`report ext:docx` · `*.sln dm:thisweek` · `size:>500mb` · `notes !archive` · 最近改动文件用 `sort: date-modified-descending` + `dm:thisweek`。

> **范围说明**：只搜文件名和路径，不搜文件内容——内容搜索请继续用 `grep`。
> **覆盖说明**：结果取决于本机 Everything 索引——NTFS/reFS 磁盘与显式加入索引的目录；FAT/exFAT 可移动盘与网络共享通常不在覆盖范围。

## 配置

在 `cordis.patch.yml`（或你 profile 的 patch 层）中修改插件 `config`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `esPath` | 自动探测 | `es.exe` 的绝对路径。 |
| `everythingPath` | `esPath` 同目录 | `Everything.exe` 路径，供 autoStart 使用。 |
| `autoStart` | `true` | Everything 未运行时自动启动并等待其 IPC 就绪。 |
| `autoInstall` | `true` | 后端缺失时自动下载并安装 Everything + ES CLI（见上文）。 |
| `installDir` | `%LOCALAPPDATA%\dsh-everything` | 自动安装的 ES CLI 存放目录。 |
| `maxResults` | `100` | 单次返回条数默认上限。 |
| `timeoutMs` | `8000` | 单次 spawn 超时（毫秒）。 |

## 隐私

搜索范围是本机**所有已索引磁盘**，结果路径会作为工具输出发给模型。在目录结构敏感的机器上请注意，可用 `path` 参数收窄范围。

## 开发

```bash
node --test                # 单元测试（任意平台）
node --test test/integration.test.mjs   # 需要运行中的 Everything（Windows）
```

## 许可证

[MIT](LICENSE)
