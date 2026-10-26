# dsh-everything

[中文文档](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the agent an **`everything_search`** tool: whole-disk file and folder search in **milliseconds**, powered by the local [Everything](https://www.voidtools.com/) (voidtools) index through its official command line `es.exe`.

Instead of recursively scanning directories (glob) when the model needs to locate a file, the agent asks Everything's pre-built index — instant even on drives with millions of files.

## Requirements

- **Windows** (Everything is a Windows-only application; on other platforms the plugin registers a stub that fails with a clear message)
- [Everything 1.4+](https://www.voidtools.com/downloads/) and the [ES command line tool](https://www.voidtools.com/downloads/) (`es.exe`) — **installed automatically on first use** (see below)

### Automatic backend setup (default)

With `autoInstall: true` (the default), the plugin provisions the backend by itself when it is missing:

1. Resolves the **latest stable** ES CLI from the voidtools.com downloads page, downloads the zip, and extracts `es.exe` to `%LOCALAPPDATA%\dsh-everything\bin` (per-user, no admin).
2. Installs **Everything** via `winget install voidtools.Everything` when winget is available, otherwise downloads the latest stable official setup and runs it silently — either path may show **one UAC prompt**.
3. Launches Everything and waits for its IPC before searching.

Downloads always go **direct first** — no proxy is needed, and a stale system-proxy setting can never break the install. A proxy (`HTTPS_PROXY`/`HTTP_PROXY` env, or the Windows system proxy) is only used as a fallback. Integrity: when the resolved version matches the known-good release recorded in [`setup.js`](setup.js), the download is SHA256-verified; a newer upstream release is verified by its **voidtools Authenticode signature** instead. If the downloads page is unreachable, the recorded known-good release (SHA256-verified) is used. Installs fail closed when verification fails.

The plugin also keeps its **self-installed** copy of `es.exe` current: on startup it compares the file version against the pinned known-good release and upgrades the copy it owns (user-managed installs are never touched).

Set `autoInstall: false` if you prefer to install the backend yourself:

```powershell
winget install --id voidtools.Everything --silent
Invoke-WebRequest https://www.voidtools.com/ES-1.1.0.37.x64.zip -OutFile ES.zip
Expand-Archive ES.zip -DestinationPath "C:\Program Files\Everything" -Force
Start-Process "C:\Program Files\Everything\Everything.exe"
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
| `sort` | string | e.g. `date-modified-descending`, `size-descending`, `name-ascending`. Keys: `name`, `path`, `size`, `extension`, `date-created`, `date-modified`, `date-accessed`, `run-count`, plus `-ascending`/`-descending`. |
| `regex` | boolean | Treat `query` as a full-path regular expression. |
| `matchCase` | boolean | Case-sensitive matching (default: insensitive). |
| `wholeWord` | boolean | Match whole words only. |
| `foldersOnly` / `filesOnly` | boolean | Restrict result type. |
| `dateCreated` | boolean | Also return each result's creation date. |
| `countOnly` | boolean | Return only the total match count — the fastest way to check existence or estimate volume. |

Returns `{ query, total, truncated, results: [{ path, size, dateModified, dateCreated? }] }` and renders in the chat as a search-paths card.

Typical queries: `report ext:docx` · `*.sln dm:thisweek` · `size:>500mb` · `notes !archive` · recently changed files with `sort: date-modified-descending` + `dm:thisweek`.

> **Scope note:** searches names and paths only, never file contents — content search stays with `grep`.
> **Coverage note:** results follow the local Everything index — NTFS/reFS drives and folders explicitly added to the index. FAT/exFAT removable drives and network shares are typically not covered.

## Configuration

Edit the plugin's `config` in `cordis.patch.yml` (or your profile's patch layer):

| Key | Default | Description |
|---|---|---|
| `esPath` | auto-detect | Absolute path to `es.exe`. |
| `everythingPath` | sibling of `esPath` | Absolute path to `Everything.exe`, used by autoStart. |
| `autoStart` | `true` | Launch Everything and wait for its IPC when it is not running. |
| `autoInstall` | `true` | Download & install Everything + ES CLI when missing (see above). |
| `installDir` | `%LOCALAPPDATA%\dsh-everything` | Where the auto-installed ES CLI lives. |
| `maxResults` | `100` | Default per-call result cap. |
| `timeoutMs` | `8000` | Per-spawn timeout (ms). |

## Privacy

The search scope is **every indexed drive** on the machine, and result paths are sent to the model as tool output. Keep that in mind on machines with sensitive directory layouts; use `path` to scope searches.

## Development

```bash
node --test                # unit tests (any platform)
node --test test/integration.test.mjs   # needs a running Everything (Windows)
```

## License

[MIT](LICENSE)
