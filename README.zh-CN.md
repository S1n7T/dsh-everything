# dsh-everything

[English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，为模型注册 **`everything_search`** 工具：借助本机 [Everything](https://www.voidtools.com/)（voidtools）索引，通过官方命令行 `es.exe` 实现**毫秒级**全盘文件/文件夹搜索。

当模型需要找文件时，不再递归遍历目录（glob），而是直接查询 Everything 预先建好的索引——即使磁盘上有数百万文件也是秒回。

## 环境要求

- **Windows**（Everything 是 Windows 独占应用；其他平台上插件会注册一个明确报错的占位工具）
- 已安装并运行 [Everything 1.4+](https://www.voidtools.com/zh-cn/downloads/)
- [ES 命令行工具](https://www.voidtools.com/zh-cn/downloads/)（`es.exe`）

一键装好后端：

```powershell
winget install --id voidtools.Everything --location "D:\Everything" --silent
Invoke-WebRequest https://www.voidtools.com/ES-1.1.0.37.x64.zip -OutFile ES.zip
Expand-Archive ES.zip -DestinationPath "D:\Everything" -Force
Start-Process "D:\Everything\Everything.exe"
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
| `sort` | string | 排序，如 `date-modified-descending`、`size-descending`、`name-ascending`。 |
| `regex` | boolean | 把 `query` 当作全路径正则表达式。 |
| `matchCase` | boolean | 区分大小写（默认不区分）。 |
| `wholeWord` | boolean | 整词匹配。 |
| `foldersOnly` / `filesOnly` | boolean | 只看文件夹 / 只看文件。 |

返回 `{ query, total, truncated, results: [{ path, size, dateModified }] }`，在会话里以搜索路径卡片展示。

> **范围说明**：只搜文件名和路径，不搜文件内容——内容搜索请继续用 `grep`。

## 配置

在 `cordis.patch.yml`（或你 profile 的 patch 层）中修改插件 `config`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `esPath` | 自动探测 | `es.exe` 的绝对路径。 |
| `everythingPath` | `esPath` 同目录 | `Everything.exe` 路径，供 autoStart 使用。 |
| `autoStart` | `true` | Everything 未运行时自动启动并等待其 IPC 就绪。 |
| `maxResults` | `100` | 单次返回条数默认上限。 |
| `timeoutMs` | `8000` | 单次 spawn 超时（毫秒）。 |

## 隐私

搜索范围是本机**所有已索引磁盘**，结果路径会作为工具输出发给模型。在目录结构敏感的机器上请注意，可用 `path` 参数收窄范围。

## 开发

```bash
node --test test/          # 单元测试（任意平台）
node --test test/integration.test.mjs   # 需要运行中的 Everything（Windows）
```

## 许可证

[MIT](LICENSE)
