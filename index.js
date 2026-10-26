/**
 * dsh-everything: model-facing `everything_search` tool backed by the local
 * Everything (voidtools) index through the official ES command line (es.exe).
 *
 * The tool spawns es.exe with a fixed argv vector (no shell layer), parses its
 * `-json` output, and projects results onto the built-in search-paths card.
 * No external npm dependencies. Windows only: Everything itself is a Windows
 * application, so on other platforms a stub tool is registered that fails with
 * a clear platform message instead of a confusing spawn error.
 *
 * Config (set in cordis.patch.yml):
 *   esPath         absolute path to es.exe (default: well-known locations, then auto-install)
 *   everythingPath absolute path to Everything.exe (default: sibling of esPath / standard locations)
 *   autoStart      launch Everything.exe when the index is not running (default: true)
 *   autoInstall    download & install Everything + ES CLI when missing (default: true)
 *   installDir     where the auto-installed ES CLI lives (default: %LOCALAPPDATA%\dsh-everything)
 *   maxResults     default per-call result cap (default: 100, ceiling: 1000)
 *   timeoutMs      per-spawn timeout in milliseconds (default: 8000)
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as win32path } from 'node:path';
import { ensureBackend, EverythingError } from './setup.js';

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESULTS_CEILING = 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
const AUTOSTART_WAIT_MS = 15000;
const SETUP_BUDGET_MS = 240000;

/** Fallback candidates when the patch config does not pin `esPath`. */
const ES_CANDIDATES = [
  'D:\\Everything\\es.exe',
  'C:\\Program Files\\Everything\\es.exe',
  'C:\\Program Files (x86)\\Everything\\es.exe',
];

const SORT_NAME_RE = /^[a-z][a-z0-9-]*(-(ascending|descending))?$/i;

export { EverythingError };

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveEsPath(config) {
  if (config && typeof config.esPath === 'string' && config.esPath.trim().length > 0) {
    return config.esPath.trim();
  }
  for (const candidate of ES_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null; // nothing found — auto-install or PATH fallback decides
}

function resolveEverythingPath(config, esPath) {
  if (config && typeof config.everythingPath === 'string' && config.everythingPath.trim().length > 0) {
    return config.everythingPath.trim();
  }
  if (typeof esPath === 'string' && /es\.exe$/i.test(esPath)) return win32path.join(win32path.dirname(esPath), 'Everything.exe');
  return 'Everything.exe';
}

/** Run es.exe once and resolve with its raw stdout. Errors are classified into actionable codes. */
function runEs(esPath, argv, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        esPath,
        argv,
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, signal },
        (error, stdout, stderr) => {
          const stderrText = typeof stderr === 'string' ? stderr.trim() : '';
          if (error) {
            const detail = `${stderrText} ${error.message ?? ''}`;
            if (error.signal === 'SIGTERM' || /abort/i.test(error.message ?? '')) {
              reject(new EverythingError('everything_search: the call was aborted (tool timeout or caller cancellation).', 'ES_ABORTED'));
              return;
            }
            if (error.killed || /timed out/i.test(error.message ?? '')) {
              reject(new EverythingError(`everything_search: es.exe timed out after ${timeoutMs}ms; narrow the query and retry.`, 'ES_TIMEOUT'));
              return;
            }
            if (/ENOENT/.test(detail)) {
              reject(new EverythingError(`everything_search: es.exe not found at "${esPath}". Install Everything 1.4 plus the ES command line tool, or set esPath in the plugin config.`, 'ES_NOT_FOUND'));
              return;
            }
            if (/not running|IPC|find Everything|connect/i.test(detail)) {
              reject(new EverythingError('everything_search: Everything is not running.', 'ES_NOT_RUNNING'));
              return;
            }
            reject(new EverythingError(`everything_search: es.exe failed (${error.code ?? 'unknown'})${stderrText ? `: ${stderrText}` : ''}`, 'ES_FAILED'));
            return;
          }
          if (/not running|IPC|find Everything/i.test(stderrText)) {
            reject(new EverythingError('everything_search: Everything is not running.', 'ES_NOT_RUNNING'));
            return;
          }
          resolve(typeof stdout === 'string' ? stdout : '');
        }
      );
    } catch (error) {
      reject(new EverythingError(`everything_search: could not launch es.exe at "${esPath}": ${error?.message ?? error}`, 'ES_SPAWN_FAILED'));
      return;
    }
    void child;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Launch Everything.exe detached and poll its IPC until it answers or the budget runs out. */
async function autoStartEverything(everythingPath, esPath, signal) {
  if (!existsSync(everythingPath)) {
    throw new EverythingError(
      `everything_search: Everything is not running and Everything.exe was not found at "${everythingPath}". Start Everything manually or set everythingPath in the plugin config.`,
      'ES_NOT_RUNNING'
    );
  }
  try {
    spawn(everythingPath, ['-startup'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (error) {
    throw new EverythingError(`everything_search: failed to launch Everything.exe: ${error?.message ?? error}`, 'ES_SPAWN_FAILED');
  }
  const deadline = Date.now() + AUTOSTART_WAIT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new EverythingError('everything_search: the call was aborted (tool timeout or caller cancellation).', 'ES_ABORTED');
    try {
      await runEs(esPath, ['-get-everything-version'], 3000, signal);
      return;
    } catch (error) {
      if (!(error instanceof EverythingError) || error.code !== 'ES_NOT_RUNNING') throw error;
      await sleep(500);
    }
  }
  throw new EverythingError('everything_search: Everything was started but did not answer within 15s; retry the search.', 'ES_NOT_RUNNING');
}

/**
 * Shared search flag vector (everything except output formatting and result
 * window). NOTE: `-regex` consumes the search text as its own value, so the
 * query must be appended here, last.
 */
function buildSearchFlags(args, query) {
  const argv = [];
  if (args.matchCase === true) argv.push('-case');
  if (args.wholeWord === true) argv.push('-whole-words');
  if (args.foldersOnly === true) argv.push('/ad');
  else if (args.filesOnly === true) argv.push('/a-d');
  if (typeof args.path === 'string' && args.path.trim().length > 0) argv.push('-path', args.path.trim());
  if (typeof args.sort === 'string' && args.sort.trim().length > 0) {
    const sort = args.sort.trim();
    if (!SORT_NAME_RE.test(sort)) {
      throw new EverythingError(`everything_search: invalid sort "${sort}"; use e.g. "date-modified-descending", "size", "name-ascending".`, 'ES_INVALID_ARGS');
    }
    argv.push('-sort', sort);
  }
  if (args.regex === true) argv.push('-regex', query);
  else argv.push(query);
  return argv;
}

function parseResults(stdout) {
  const text = stdout.trim();
  if (text.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new EverythingError(`everything_search: could not parse es.exe JSON output: ${error?.message ?? error}`, 'ES_PARSE_FAILED');
  }
  if (!Array.isArray(parsed)) return [];
  const results = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || typeof item.filename !== 'string') continue;
    const entry = { path: item.filename };
    if (typeof item.size === 'number') entry.size = item.size;
    if (typeof item.date_modified === 'string') entry.dateModified = item.date_modified;
    results.push(entry);
  }
  return results;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderResults(value) {
  const lines = [];
  const { query, total, truncated, results } = value;
  if (results.length === 0) {
    lines.push(`Everything "${query}": no matches.`);
    return lines.join('\n');
  }
  lines.push(`Everything "${query}": ${results.length} of ${total} result(s)${truncated ? ' (truncated, refine the query, raise maxResults, or page with offset)' : ''}:`);
  for (const entry of results) {
    const meta = [entry.size !== undefined ? formatSize(entry.size) : null, entry.dateModified ?? null]
      .filter(Boolean)
      .join(', ');
    lines.push(meta ? `${entry.path}  [${meta}]` : entry.path);
  }
  return lines.join('\n');
}

function presentCall(args) {
  const query = typeof args?.query === 'string' ? args.query : '';
  const where = typeof args?.path === 'string' && args.path.trim() ? ` in ${args.path.trim()}` : '';
  return { card: 'generic', title: `Everything ${query}${where}`, kind: 'search', rawInput: query };
}

function presentResult(_args, result) {
  if (result.isError) return undefined;
  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined;
  const { shape, paths, truncated, total } = meta;
  if (shape !== 'paths' || !Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return undefined;
  return {
    card: 'search',
    shape: 'paths',
    paths,
    truncated: truncated === true,
    total: typeof total === 'number' ? total : paths.length,
  };
}

/** Parameters JSON Schema, shared by the real tool and the non-Windows stub. */
const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Everything search expression, e.g. "report ext:docx", "*.sln dm:thisweek", "path:\\\\projects\\\\ ext:py". Uses Everything search syntax, not a glob.',
    },
    path: {
      type: 'string',
      description: 'Restrict the search to this directory and everything below it (absolute path).',
    },
    maxResults: {
      type: 'integer',
      description: 'Maximum number of results to return (default from plugin config, ceiling 1000).',
    },
    offset: {
      type: 'integer',
      description: 'Skip this many leading results (pagination). Default 0.',
    },
    sort: {
      type: 'string',
      description:
        'Sort order, e.g. "date-modified-descending", "size-descending", "name-ascending". Names: name, path, size, extension, date-created, date-modified, date-accessed, run-count.',
    },
    regex: { type: 'boolean', description: 'Treat query as a regular expression matched against the full path.' },
    matchCase: { type: 'boolean', description: 'Match case (default: insensitive).' },
    wholeWord: { type: 'boolean', description: 'Match whole words only.' },
    foldersOnly: { type: 'boolean', description: 'Return folders only.' },
    filesOnly: { type: 'boolean', description: 'Return files only.' },
  },
  required: ['query'],
  additionalProperties: false,
};

const TOOL_DESCRIPTION =
  'Locate files and folders across every indexed drive on this machine through the local Everything (voidtools) index — answers in milliseconds, far faster than glob or a recursive directory scan. Use this FIRST whenever you need to find a file or folder by name, extension, or path, especially outside the workspace. The query uses Everything search syntax: plain words match names, `*`/`?` wildcards, `ext:js;ts` filters extensions, `dm:today` / `dm:thisweek` filter date modified, `size:>10mb` filters size, space means AND, `|` means OR, `!` means NOT, double quotes give an exact phrase. Set regex=true for a full regular expression over the whole path. Returns absolute paths with size and date modified. This searches names and paths only, never file contents — use grep for content.';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'total', 'truncated', 'results'],
  properties: {
    query: { type: 'string' },
    total: { type: 'integer' },
    truncated: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          size: { type: 'integer' },
          dateModified: { type: 'string' },
        },
      },
    },
  },
};

export const inject = ['tools'];

export function apply(ctx, config = {}) {
  // Everything is a Windows-only application. On other platforms register a
  // stub that fails loudly and clearly instead of a spawn error deep inside.
  if (process.platform !== 'win32') {
    ctx.tools.register({
      name: 'everything_search',
      description: TOOL_DESCRIPTION,
      parameters: PARAMETERS_SCHEMA,
      isConcurrencySafe: () => true,
      output: { schema: OUTPUT_SCHEMA, render: () => [{ type: 'text', text: 'everything_search is unavailable on this platform.' }] },
      async execute() {
        throw new EverythingError('everything_search: this tool requires Windows (Everything by voidtools is a Windows-only application).', 'ES_UNSUPPORTED_PLATFORM');
      },
      presentCall,
    });
    return;
  }

  const autoStart = config.autoStart !== false;
  const autoInstall = config.autoInstall !== false;
  const maxResults = clampInt(config.maxResults, 1, MAX_RESULTS_CEILING, DEFAULT_MAX_RESULTS);
  const timeoutMs = clampInt(config.timeoutMs, 1000, 60000, DEFAULT_TIMEOUT_MS);

  // Mutable: auto-install may re-resolve both paths after provisioning.
  let esPath = resolveEsPath(config);
  let everythingPath = resolveEverythingPath(config, esPath ?? 'es.exe');

  /**
   * One shared provisioning run. Rejects clear the cache so the next call can
   * retry (e.g. after the user approves a UAC prompt on a second attempt).
   */
  let setupPromise = null;
  function ensureReady() {
    if (!setupPromise) {
      setupPromise = ensureBackend({
        config,
        log: ctx.logger,
        probe: async (es, evPath) => {
          try {
            await runEs(esPath, ['-get-everything-version'], 3000);
          } catch (error) {
            if (error instanceof EverythingError && error.code === 'ES_NOT_RUNNING' && autoStart && existsSync(evPath)) {
              await autoStartEverything(evPath, esPath);
              return;
            }
            throw error;
          }
        },
      })
        .then((result) => {
          esPath = result.esPath;
          everythingPath = result.everythingPath;
          if (result.installed.length > 0) ctx.logger?.info?.(`everything_search: auto-installed ${result.installed.join(', ')} under ${result.installDir}`);
          return result;
        })
        .catch((error) => {
          setupPromise = null;
          throw error;
        });
    }
    return setupPromise;
  }

  // Kick provisioning in the background so the first search usually finds a
  // ready backend; failures are logged, never thrown from here.
  if (autoInstall && (!esPath || !existsSync(everythingPath))) {
    ensureReady().catch((error) => {
      ctx.logger?.warn?.(`everything_search: auto-install failed (${error?.message ?? error}). Install Everything + ES CLI from https://www.voidtools.com/ or set esPath in the plugin config.`);
    });
  }

  async function searchOnce(input, query, limit, offset, signal) {
    const flags = buildSearchFlags(input, query);
    const searchArgv = ['-n', String(offset + limit), '-json', '-size', '-dm', '-date-format', '1'];
    if (offset > 0) searchArgv.push('-viewport-offset', String(offset));
    searchArgv.push(...flags);
    const stdout = await runEs(esPath ?? 'es.exe', searchArgv, timeoutMs, signal);
    return { flags, results: parseResults(stdout) };
  }

  async function execute(args, exec) {
    const input = typeof args === 'object' && args !== null ? args : {};
    const signal = exec?.signal;
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length === 0) throw new EverythingError('everything_search: "query" must be a non-empty Everything search expression.', 'ES_INVALID_ARGS');
    const limit = clampInt(input.maxResults, 1, MAX_RESULTS_CEILING, maxResults);
    const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    let search;
    try {
      search = await searchOnce(input, query, limit, offset, signal);
    } catch (error) {
      if (!(error instanceof EverythingError)) throw error;
      if (autoInstall && (error.code === 'ES_NOT_FOUND' || (error.code === 'ES_NOT_RUNNING' && !existsSync(everythingPath)))) {
        // Backend not installed yet — provision (downloads + one possible UAC
        // prompt), then fall through to the normal start-and-retry path.
        await ensureReady();
      }
      if (!autoStart) throw error;
      if (error.code === 'ES_NOT_FOUND' && !esPath) throw error;
      if (error.code !== 'ES_NOT_RUNNING' && error.code !== 'ES_NOT_FOUND') throw error;
      await autoStartEverything(everythingPath, esPath ?? 'es.exe', signal);
      search = await searchOnce(input, query, limit, offset, signal);
    }
    const { flags, results } = search;

    // The exact total costs a second IPC round-trip; only fetch it when the
    // page is full and truncation is actually possible.
    let total = offset + results.length;
    if (results.length === limit) {
      try {
        const countOut = await runEs(esPath, ['-get-result-count', ...flags], timeoutMs, signal);
        const parsed = Number.parseInt(countOut.trim(), 10);
        if (Number.isFinite(parsed) && parsed >= total) total = parsed;
      } catch {
        /* count is cosmetic; keep the page-based estimate */
      }
    }

    return { query, total, truncated: total > offset + results.length, results };
  }

  ctx.tools.register({
    name: 'everything_search',
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS_SCHEMA,
    timeoutMs: timeoutMs * 2 + AUTOSTART_WAIT_MS + 5000 + (autoInstall ? SETUP_BUDGET_MS : 0),
    isConcurrencySafe: () => true,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResults(value) }],
      presentationMeta: (_args, value) => ({
        shape: 'paths',
        paths: value.results.map((entry) => entry.path),
        truncated: value.truncated,
        total: value.total,
      }),
    },
    execute,
    presentCall,
    presentResult,
  });
}

export {
  buildSearchFlags,
  clampInt,
  formatSize,
  parseResults,
  presentCall,
  presentResult,
  renderResults,
  resolveEsPath,
};
