# dsh-everything

[English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，为模型注册 **`everything_search`** 工具：借助本机 [Everything](https://www.voidtools.com/)（voidtools）索引，实现**毫秒级**全盘文件/文件夹搜索。

当模型需要找文件时，不再递归遍历目录（glob），而是直接查询 Everything 预先建好的索引——即使磁盘上有数百万文件也是秒回。内部走两条通道：优先用 Everything 内置的 HTTP JSON 服务（仅绑定 127.0.0.1，插件会自动启用——每次调用无需再拉起进程、原生 UTF-8、精确总数免费自带），官方命令行 `es.exe` 作为兜底，覆盖 HTTP 服务表达不了的一切查询。

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

在 DSH 会话中让插件管理器安装 npm 包名：

```
plugin_manager install_bundle，target = dsh-everything
```

插件以 `dsh-everything` 激活，并为该 profile 下的所有 Agent 注册 `everything_search` 工具。已发布到 npm（[`dsh-everything`](https://www.npmjs.com/package/dsh-everything)），直接用本包目录安装也可以。

## 工具：everything_search

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` *（必填）* | string | Everything 搜索表达式：`report ext:docx`、`*.sln dm:thisweek`、`path:\projects\ ext:py`。空格 = 与，`\|` = 或，`!` = 非。多词查询会自动拆分为 es.exe 的独立搜索词。 |
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
| `exactTotal` | boolean | 默认 `true`。设 `false` 时整页结果不再额外做一次计数往返，总数显示为 `≥N` 下界。 |

返回 `{ query, total, totalExact, truncated, results: [{ path, size, dateModified, dateCreated? }], channel, notes }`（`channel` 为 `"http"` 或 `"es"`；`notes` 携带查询解释说明），在会话里以搜索路径卡片展示。

典型查询：`report ext:docx` · `*.sln dm:thisweek` · `size:>500mb` · `notes !archive` · 最近改动文件用 `sort: date-modified-descending` + `dm:thisweek`。

> **短语怪癖**：带引号的短语只匹配文件名的“名字部分”，所以 `"report.docx"` 永远搜不到——直接写不带引号的 `report.docx`。**整条查询**就是一个含空格的引号短语（精确多词匹配）时，插件会自动转换成等价正则；与其他词混用的引号短语会退化为逐词 AND 并在 `notes` 里说明（这类场景请显式用 `regex=true`）。
> **编码**：HTTP 通道原生 UTF-8；es.exe 兜底通道从其 UTF-8 `-export-json` 输出读取——无论哪条通道，非 ASCII 文件名（中文、日文、emoji 等）都完整回传、不再乱码。

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
| `timeoutMs` | `8000` | 单次调用超时（毫秒）。 |
| `httpPort` | `5151` | 快速通道的 Everything HTTP 服务端口；设 `0` 完全关闭 HTTP 通道。 |
| `httpAutoEnable` | `true` | HTTP 服务未开启时，每会话一次：自动改写 Everything 自身配置（解锁+启用+仅回环绑定）并重启其 GUI。设 `false` 则永不触碰 Everything 的配置。 |
| `httpUsername` / `httpPassword` | `''` | HTTP 服务的可选 Basic 认证凭据。 |

### 快速通道：内置 HTTP 服务

Everything 1.4 自带 HTTP JSON 服务，但**默认是关闭且被策略锁死的**——安装版会在 `Everything.exe` 旁写入 `allow_http_server=0`，GUI 里也解不了锁。`httpAutoEnable: true`（默认）时插件会亲自翻开这个开关（每会话一次）：同时补丁两份 `Everything.ini`、把服务**只绑定到 127.0.0.1**、重启 Everything GUI，之后搜索都走 HTTP。后台索引服务全程不受影响。

HTTP 通道覆盖：普通搜索、`path`/`foldersOnly`/`filesOnly` 范围限定、`countOnly`、分页，以及 `name`/`path`/`size`/`date-modified` 排序键。其余——`dateCreated`、其他排序键、`regex` 搭配 `path` 或类型过滤——自动改走 es.exe 通道。HTTP 服务起不来（端口被占、Everything 未安装）时插件静默留在 es.exe 通道、稍后重试；`path` 指向不存在的路径会直接报错，而不是返回空结果。

## 隐私

搜索范围是本机**所有已索引磁盘**，结果路径会作为工具输出发给模型。在目录结构敏感的机器上请注意，可用 `path` 参数收窄范围。HTTP 快速通道只监听 `127.0.0.1`——不向网络暴露任何东西。

## 开发

```bash
node --test                # 单元测试（任意平台）
node --test test/integration.test.mjs   # 需要运行中的 Everything（Windows）
```

## 许可证

[MIT](LICENSE)
