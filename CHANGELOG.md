# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.4.0] - 2026-10-27

### Added
- **HTTP fast channel**: searches are now served by Everything's built-in
  HTTP JSON server on `127.0.0.1` when it is available — no per-call
  `es.exe` spawn, native UTF-8, and exact totals for free. The plugin
  auto-enables the server itself (Everything ships it disabled AND
  policy-locked: `allow_http_server=0` in the ini next to
  `Everything.exe`; the GUI cannot unlock it) by patching both
  `Everything.ini` files, binding loopback only, and restarting the GUI
  once per session (`httpAutoEnable`, default on; `httpPort` default 5151,
  `0` disables; optional Basic auth via `httpUsername`/`httpPassword`).
  The `es.exe` CLI remains the always-available fallback and covers
  `dateCreated`, the extra sort keys, and `regex` + `path`/type-filter
  combinations the HTTP API cannot express.
- `exactTotal` (default `true`): set `false` to skip the extra
  match-count round-trip on full pages; the total then reports as a
  page-based lower bound (`≥N`, `totalExact: false`).
- Results now carry `channel` (`"http"`/`"es"`), `totalExact`, and `notes`
  (non-fatal query-interpretation remarks) so behavior is observable.
- A whole-query quoted phrase containing spaces (an exact multi-word
  match) is automatically converted to an equivalent regex — previously
  it degraded to ANDed words silently.

### Fixed
- `readExportText` no longer blocks the event loop while waiting out the
  es.exe export-file flush race (async retry instead of `Atomics.wait`),
  and a genuinely empty/missing export file now falls back to decoded
  stdout instead of reporting a fake empty result page.
- A `path` that does not exist (or points at a file) is rejected up front
  with `ES_INVALID_ARGS` instead of silently returning "no matches"
  (UNC paths are checked after a zero-result page).
- `truncated` is `true` whenever a full page is returned with an
  inexact total, not only when the exact count exceeds the page.

## [1.3.1] - 2026-10-27

### Fixed
- Multi-word queries (`*.docx dm:thisweek`) silently returned 0 results: the
  whole query string was handed to es.exe as ONE argument, which Everything
  then matched literally. Queries are now tokenized on whitespace (outside
  double quotes) and each term is passed as its own argument, restoring AND
  semantics. Quoted phrases without spaces keep their phrase meaning; quoted
  phrases containing spaces degrade to ANDed words (es.exe cannot express
  them positionally — use `regex=true` for exact multi-word matching).
- Non-ASCII file names came back as mojibake (`?????`): es.exe pipes results
  in the console/ANSI codepage, not UTF-8. Results are now read from es.exe's
  UTF-8 `-export-json` file instead, so Chinese/Japanese/emoji names survive
  the round trip on every codepage (with a decoded-stdout fallback for es.exe
  builds without `-export-json`).

## [1.3.0] - 2026-10-26

### Added
- `countOnly`: return just the total match count in one round-trip — the
  fastest way to check existence or estimate volume.
- `dateCreated`: include each result's creation date.
- ES CLI self-update: the plugin keeps its **self-installed** `es.exe`
  current against the pinned known-good release (user-managed installs are
  never touched).
- Tool description now documents search syntax quirks and the NTFS/reFS
  coverage limit (FAT/exFAT and network shares are typically not indexed).

### Fixed
- The background provisioning probe used the pre-resolution `esPath`
  (possibly null) instead of the freshly resolved path, which could log a
  spurious "auto-install failed" warning on auto-installed setups.
- Backend recovery (auto-install / auto-start retry) now also covers the
  count-only path, not just the search path.

## [1.2.0] - 2026-10-26

### Changed
- Auto-install now resolves the **latest stable** version from the
  voidtools.com downloads page instead of installing a pinned version; the
  recorded known-good releases remain as SHA256-verified fallbacks when the
  page is unreachable.
- Downloads try a **direct connection first**; a configured or system proxy
  is only a fallback, so machines without proxy tools (or with a stale
  proxy setting) install reliably.

### Added
- Newer-than-pinned upstream releases are verified by their voidtools
  Authenticode signature (with a raw .NET certificate-chain fallback when
  `Get-AuthenticodeSignature`'s module fails to load).

## [1.1.0] - 2026-10-26

### Added
- `autoInstall` (default on): when the backend is missing, the plugin
  downloads the pinned ES CLI (SHA256-verified) into
  `%LOCALAPPDATA%\dsh-everything\bin` and installs Everything via winget or
  the official silent setup, then starts it — fresh machines need no manual
  setup.
- Proxy-aware downloads: `HTTPS_PROXY`/`HTTP_PROXY` or the Windows system
  proxy, with fetch → curl.exe → PowerShell fallbacks.
- New `installDir` config key; new `ES_SETUP_FAILED` error code.

## [1.0.0] - 2026-10-26

### Added
- `everything_search` tool: whole-disk file/folder search through the local
  Everything (voidtools) index via `es.exe -json`, with size and
  date-modified columns.
- Everything search syntax pass-through: `path`, `regex`, `matchCase`,
  `wholeWord`, `foldersOnly` / `filesOnly` filters, `sort` order, and
  `offset` pagination.
- Exact total hit count via `-get-result-count`, fetched only when the page
  is full (truncation possible).
- `autoStart` (default on): launches `Everything.exe -startup` and waits for
  IPC when the index is not running.
- Built-in search-paths result card (`presentCall` / `presentResult`).
- Actionable, coded errors (`ES_NOT_FOUND`, `ES_NOT_RUNNING`, `ES_TIMEOUT`,
  `ES_ABORTED`, `ES_UNSUPPORTED_PLATFORM`, …); non-Windows platforms get a
  stub tool that fails with a clear platform message.
- English and Chinese plugin metadata and icon.
