# dsh-everything 插件实施计划

## 目标

做一个名为 **dsh-everything** 的 Host 插件：向模型注册一个 `everything_search` 工具，通过本机 Everything（voidtools）的索引做全盘文件名/路径搜索，毫秒级返回结果，替代慢速的递归目录遍历。

## 后端依赖

- 插件本身不建索引，依赖本机的 **Everything 1.4**（voidtools）及其命令行工具 **`es.exe`**（ES CLI，与 Everything.exe 通过 IPC 通信）。
- 安装方式：winget/手动安装 Everything 1.4，从 voidtools 官网下载 `ES.zip` 解压出 `es.exe` 放到固定目录。
- 插件 Config 提供 `esPath` 配置项；未配置时按 PATH → 常见安装目录顺序自动探测。

## 架构：Host-only bundle（首版无 UI）

工作区新建一个 bundle 目录，包含：

```
dsh-everything/
├── package.json        # name: dsh-everything，声明 dsh.bundle.patch
├── cordis.patch.yml    # 插入插件行（id: dsh-everything）+ 默认 config
├── index.js            # Host 插件：apply 形式
├── locale/
│   ├── en.json         # meta.title / meta.description
│   └── zh.json         # 中文标题与描述
└── icon.svg            # 原创小图标
```

无依赖、无构建、无安装脚本，纯 JS。写完后用 `plugin_manager install_bundle`（target = 该目录绝对路径）装入当前 profile。

## index.js 设计

```js
export const inject = ['tools'];            // 硬依赖 tools 服务
export const Config = { /* JSON Schema */ }; // 配置校验
export function apply(ctx, config) { /* 注册工具 */ }
```

**Config（用户可在 patch 层调整，升级不丢）：**

| 字段 | 默认 | 说明 |
|---|---|---|
| `esPath` | `""`（自动探测） | es.exe 的绝对路径 |
| `maxResults` | `100` | 单次返回条数上限（对应 es `-n`） |
| `timeoutMs` | `8000` | 子进程超时 |

**工具定义（`ctx.tools.register`）：**

- **name**: `everything_search`
- **description**: 说明这是 Everything 索引搜索，语法为 Everything 搜索语法（通配、扩展名过滤 `ext:js;ts`、路径过滤、正则等），适合按文件名/路径定位，**不搜索文件内容**。
- **parameters**：
  - `query`（必填）：Everything 搜索表达式
  - `maxResults`（可选，默认取 Config）
  - `regex`（可选布尔）：把 query 当正则
  - `matchCase`（可选布尔）
  - `path`（可选）：限定在某目录下（拼进 query）
- **execute**：`child_process.spawn(esPath, [...args, '-n', limit, query])`（`stdio: pipe` 在 Windows 沙箱受限环境下可能 EPERM → 实现时退化为 PowerShell/直接 exec 兜底），按行解析 stdout，返回 `{ paths: string[], total, truncated }`。
- **isConcurrencySafe**: `true`（只读搜索，可并行）。
- **presentCall / presentResult**：用内置 search 卡片（`card: 'search', shape: 'paths'`），UI 里显示成路径列表，和原生 glob/grep 视觉一致。
- **错误处理**：es.exe 不存在 / Everything 未运行 / 超时，各自返回明确的结构化错误信息（含"请启动 Everything"提示），而不是崩溃。

## 实施步骤

1. 安装后端：装 Everything 1.4 + es.exe，启动 Everything（让它建索引），命令行手动验证 `es.exe test` 有输出。
2. 在仓库根目录写出上述文件。
3. 语法检查 index.js 与 JSON/YAML 合法性。
4. `plugin_manager install_bundle` 安装，确认 `application: applied`。
5. 用 `cordis_inspect_query`（Tool.listTools）确认 `everything_search` 对模型可见。
6. 实测一次搜索（如 `query: "ext:py"`），确认返回真实路径；插件管理界面核对标题/描述/图标（中英文）。

## 验收标准

- 模型工具列表里出现 `everything_search`，描述能让模型在"找文件"场景主动选用它。
- 一次典型查询（如找某文件名）在毫秒级返回正确路径列表，UI 显示为搜索路径卡片。
- Everything 未运行/未安装时返回可操作的错误提示而非异常。
