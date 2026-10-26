# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
