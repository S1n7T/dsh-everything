# dsh-everything

[中文文档](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the agent an **`everything_search`** tool: whole-disk file and folder search in **milliseconds**, powered by the local [Everything](https://www.voidtools.com/) (voidtools) index through its official command line `es.exe`.

Instead of recursively scanning directories (glob) when the model needs to locate a file, the agent asks Everything's pre-built index — instant even on drives with millions of files.

## Requirements

- **Windows** (Everything is a Windows-only application; on other platforms the plugin registers a stub that fails with a clear message)
- [Everything 1.4+](https://www.voidtools.com/downloads/) installed and running
- [ES command line tool](https://www.voidtools.com/downloads/) (`es.exe`)

Quick backend setup:

```powershell
winget install --id voidtools.Everything --location "D:\Everything" --silent
Invoke-WebRequest https://www.voidtools.com/ES-1.1.0.37.x64.zip -OutFile ES.zip
Expand-Archive ES.zip -DestinationPath "D:\Everything" -Force
Start-Process "D:\Everything\Everything.exe"
```

## Installation

In a DSH session, ask the agent or call the plugin manager:

```
plugin_manager install_bundle with target = this package directory (or the npm spec once published)
```

The plugin activates as `dsh-everything` and registers the `everything_search` tool for every agent in the profile.

## Tool: `everything_search`

| Parameter | Type | Description |
|---|---|---|
| `query` *(required)* | string | Everything search expression: `report ext:docx`, `*.sln dm:thisweek`, `path:\projects\ ext:py`. Space = AND, `\|` = OR, `!` = NOT, quotes = exact phrase. |
| `path` | string | Restrict to a directory and its subtree (absolute path). |
| `maxResults` | integer | Result cap (default 100, ceiling 1000). |
| `offset` | integer | Skip leading results (pagination). |
| `sort` | string | e.g. `date-modified-descending`, `size-descending`, `name-ascending`. |
| `regex` | boolean | Treat `query` as a full-path regular expression. |
| `matchCase` | boolean | Case-sensitive matching (default: insensitive). |
| `wholeWord` | boolean | Match whole words only. |
| `foldersOnly` / `filesOnly` | boolean | Restrict result type. |

Returns `{ query, total, truncated, results: [{ path, size, dateModified }] }` and renders in the chat as a search-paths card.

> **Scope note:** searches names and paths only, never file contents — content search stays with `grep`.

## Configuration

Edit the plugin's `config` in `cordis.patch.yml` (or your profile's patch layer):

| Key | Default | Description |
|---|---|---|
| `esPath` | auto-detect | Absolute path to `es.exe`. |
| `everythingPath` | sibling of `esPath` | Absolute path to `Everything.exe`, used by autoStart. |
| `autoStart` | `true` | Launch Everything and wait for its IPC when it is not running. |
| `maxResults` | `100` | Default per-call result cap. |
| `timeoutMs` | `8000` | Per-spawn timeout (ms). |

## Privacy

The search scope is **every indexed drive** on the machine, and result paths are sent to the model as tool output. Keep that in mind on machines with sensitive directory layouts; use `path` to scope searches.

## Development

```bash
node --test test/          # unit tests (any platform)
node --test test/integration.test.mjs   # needs a running Everything (Windows)
```

## License

[MIT](LICENSE)
