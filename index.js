/**
 * dsh-everything: model-facing `everything_search` tool backed by the local
 * Everything (voidtools) index.
 *
 * Two channels, tried in order:
 *   1. Everything's built-in HTTP JSON server (127.0.0.1 only) — no process
 *      spawn per call, native UTF-8, exact totals for free. Auto-enabled from
 *      the plugin when httpAutoEnable is on (one Everything GUI restart).
 *   2. The official ES command line (es.exe) — always available as fallback
 *      (and used for dateCreated, unsupported sort keys, and regex+scope
 *      combos). Results are read from a UTF-8 `-export-json` file, immune to
 *      console codepages.
 * Results project onto the built-in search-paths card. No external npm
 * dependencies. Windows only: Everything itself is a Windows application, so
 * on other platforms a stub tool is registered that fails with a clear
 * platform message instead of a confusing spawn error.
 *
 * Config (set in cordis.patch.yml):
 *   esPath         absolute path to es.exe (default: well-known locations, then auto-install)
 *   everythingPath absolute path to Everything.exe (default: sibling of esPath / standard locations)
 *   autoStart      launch Everything.exe when the index is not running (default: true)
 *   autoInstall    download & install Everything + ES CLI when missing (default: true)
 *   installDir     where the auto-installed ES CLI lives (default: %LOCALAPPDATA%\dsh-everything)
 *   maxResults     default per-call result cap (default: 100, ceiling: 1000)
 *   timeoutMs      per-call timeout in milliseconds (default: 8000)
 *   httpPort       Everything HTTP server port; 0 disables the HTTP channel (default: 5151)
 *   httpAutoEnable flip Everything's own config to start its HTTP server (default: true)
 *   httpUsername   optional Basic-auth user for the Everything HTTP server (default: '')
 *   httpPassword   optional Basic-auth password (default: '')
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath, win32 as win32path } from 'node:path';
import { ensureBackend, ensureHttpServer, probeHttpPort, EverythingError } from './setup.js';

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESULTS_CEILING = 1000;
const MAX_BUFFER = 32 * 1024 * 1024;
const AUTOSTART_WAIT_MS = 15000;
const SETUP_BUDGET_MS = 240000;
const DEFAULT_HTTP_PORT = 5151;
/** After an HTTP failure, stay on the es.exe channel for this long before probing again. */
const HTTP_RETRY_DOWN_MS = 30000;
/** Per-request cap for HTTP calls (hot latency is ~2ms; 5s covers worst cases). */
const HTTP_REQUEST_CAP_MS = 5000;

/** Fallback candidates when the patch config does not pin `esPath`. */
const ES_CANDIDATES = [
  'D:\\Everything\\es.exe',
  'C:\\Program Files\\Everything\\es.exe',
  'C:\\Program Files (x86)\\Everything\\es.exe',
];

const SORT_NAME_RE = /^[a-z][a-z0-9-]*(-(ascending|descending))?$/i;

/** Sort keys the Everything HTTP server understands (es.exe accepts more). */
const HTTP_SORT_KEYS = { name: 'name', path: 'path', size: 'size', 'date-modified': 'date_modified' };

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

/** Run es.exe once and resolve with its raw stdout Buffer. Errors are classified into actionable codes. */
function runEs(esPath, argv, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        esPath,
        argv,
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, signal, encoding: 'buffer' },
        (error, stdout, stderr) => {
          const stderrText = typeof stderr === 'string' ? stderr.trim() : '';
          if (error) {
            const detail = `${stderrText} ${error.message ?? ''}`;
            if (signal?.aborted) {
              reject(new EverythingError('everything_search: the call was aborted (tool timeout or caller cancellation).', 'ES_ABORTED'));
              return;
            }
            if (error.killed || /timed out/i.test(error.message ?? '')) {
              reject(new EverythingError(`everything_search: es.exe timed out after ${timeoutMs}ms; the index may still be building on first run — retry shortly, or narrow the query.`, 'ES_TIMEOUT'));
              return;
            }
            if (error.signal === 'SIGTERM' || /abort/i.test(error.message ?? '')) {
              reject(new EverythingError('everything_search: the call was aborted (tool timeout or caller cancellation).', 'ES_ABORTED'));
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
          resolve(stdout); // Buffer (execFile encoding: 'buffer')
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
 * Split an Everything search expression into es.exe search terms.
 *
 * es.exe takes each command-line argument as ONE search term; an argument
 * that itself contains a space is matched literally and never matches, so
 * `*.docx dm:thisweek` MUST be passed as two arguments. Quoted phrases
 * without spaces keep their quotes (phrase semantics); a quoted phrase that
 * contains a space cannot be expressed positionally, so it degrades to its
 * component words ANDed together (report it so callers can switch to regex).
 *
 * Returns { terms, degraded } — `degraded` lists the quoted phrases that had
 * to be split (only used for the user-facing note).
 */
function tokenizeQuery(query) {
  const terms = [];
  const degraded = [];
  let current = '';
  let inQuotes = false;
  const flush = () => {
    if (current.length === 0) return;
    if (/\s/.test(current)) {
      // Only reachable for a quoted phrase with internal spaces: es.exe cannot
      // take it as one term, so degrade to its component words (quotes stripped).
      const bare = current.replace(/"/g, '').trim();
      if (bare.length > 0) degraded.push(bare);
      for (const word of current.split(/\s+/)) {
        const w = word.replace(/"/g, '');
        if (w.length > 0) terms.push(w);
      }
    } else if (current.replace(/"/g, '').length > 0) {
      terms.push(current);
    }
    current = '';
  };
  for (const ch of query) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && /\s/.test(ch)) {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return { terms, degraded };
}

/**
 * Pre-process a raw query. A quoted phrase WITH spaces that is the whole
 * query (the only exact-phrase intent es.exe cannot express) is converted to
 * an equivalent regex (`word\s+word`), because both channels accept regex.
 */
function prepareQuery(query) {
  const trimmed = query.trim();
  const m = /^"([^"]*\s[^"]*)"$/.exec(trimmed);
  if (m) {
    return {
      query: phraseToRegex(m[1]),
      regex: true,
      note: `exact phrase "${m[1]}" was converted to a regular expression (quoted phrases with spaces are not expressible otherwise)`,
    };
  }
  return { query: trimmed, regex: false, note: null };
}

/** Escape each word and join with `\s+` — a regex equivalent of a phrase. */
function phraseToRegex(phrase) {
  const escapeRe = /[.*+?^${}()|[\]\\]/g;
  return phrase
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(escapeRe, '\\$&'))
    .join('\\s+');
}

/** Decode es.exe stdout: it emits the console/ANSI codepage, not UTF-8. */
function decodeEsStdout(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

let exportFileCounter = 0;

/**
 * Read the UTF-8 file written by `es.exe -export-json <file>`.
 * The file occasionally exists but is still empty right after the process
 * exits (flush race), so an empty read is retried briefly (async, never
 * blocking the event loop).
 * Returns { exists, text } — `exists: false` (or empty text) lets the caller
 * fall back to decoding stdout (e.g. an es.exe build that ignores
 * -export-json).
 */
async function readExportText(filePath) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = readFileSync(filePath, 'utf8');
      if (text.length > 0) return { exists: true, text: text.replace(/^\uFEFF/, '') };
    } catch {
      return { exists: false, text: '' };
    }
    // exists but empty: brief wait for the flush race
    await sleep(100);
  }
  return { exists: true, text: '' };
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
  else {
    const { terms } = tokenizeQuery(query);
    if (terms.length === 0) {
      throw new EverythingError('everything_search: "query" must contain at least one search term (not only quotes or whitespace).', 'ES_INVALID_ARGS');
    }
    argv.push(...terms);
  }
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
    if (typeof item.date_created === 'string') entry.dateCreated = item.date_created;
    results.push(entry);
  }
  return results;
}

// ---------------------------------------------------------------------------
// HTTP channel (Everything's built-in JSON server on 127.0.0.1)
// ---------------------------------------------------------------------------

/** Map our sort names onto HTTP params. null = this sort must use es.exe. */
function httpSortParams(sort) {
  if (typeof sort !== 'string' || sort.trim().length === 0) return {};
  const s = sort.trim();
  const key = s.replace(/-(ascending|descending)$/i, '');
  const httpKey = HTTP_SORT_KEYS[key];
  if (!httpKey) return null;
  return { sort: httpKey, ascending: /-descending$/i.test(s) ? 0 : 1 };
}

/**
 * URL parameters for the Everything HTTP server (pure, exported for tests).
 * Scope (`path:`) and type (`folder:`/`file:`) filters are folded into the
 * search text — the HTTP API has no dedicated parameters for them. NOTE: in
 * regex mode Everything does not interpret those prefixes, so the caller
 * routes regex+scope combos to es.exe instead.
 */
function httpSearchParams(input, query, { limit, offset }) {
  let search = query;
  if (input.foldersOnly === true) search = `folder:${search}`;
  else if (input.filesOnly === true) search = `file:${search}`;
  if (typeof input.path === 'string' && input.path.trim().length > 0) search += ` path:"${input.path.trim()}"`;
  const params = {
    search,
    json: '1',
    count: String(input.countOnly === true ? 1 : limit),
    offset: String(offset),
    // JSON mode defaults count to 4294967295 — always pass it explicitly. The
    // *_column switches make results carry the fields we project.
    path_column: '1',
    size_column: '1',
    date_modified_column: '1',
  };
  if (input.regex === true) params.regex = '1';
  if (input.matchCase === true) params.case = '1';
  if (input.wholeWord === true) params.wholeword = '1';
  const sort = httpSortParams(input.sort);
  if (sort && sort.sort) {
    params.sort = sort.sort;
    params.ascending = String(sort.ascending);
  }
  return params;
}

/**
 * Convert a Windows FILETIME string (> 2^53, needs BigInt) into the same
 * local "YYYY-MM-DDTHH:MM:SS" rendering es.exe -date-format 1 produces.
 * Returns undefined on garbage input.
 */
function fileTimeToLocalIso(fileTime) {
  try {
    const n = typeof fileTime === 'bigint' ? fileTime : BigInt(fileTime);
    const ms = Number((n - 116444736000000000n) / 10000n);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return undefined;
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return undefined;
  }
}

/** fetch with a timeout, honoring the caller's abort signal. */
async function fetchHttp(url, { headers, signal, timeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  let timer = null;
  try {
    if (signal) {
      if (signal.aborted) throw new EverythingError('everything_search: the call was aborted (tool timeout or caller cancellation).', 'ES_ABORTED');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    return await fetch(url, { headers, signal: ctrl.signal });
  } catch (error) {
    if (signal?.aborted) throw new EverythingError('everything_search: the call was aborted (tool timeout or caller cancellation).', 'ES_ABORTED');
    const cause = error?.cause?.code ?? error?.message ?? String(error);
    throw new EverythingError(`everything_search: the Everything HTTP server on 127.0.0.1 is unreachable (${cause}).`, 'ES_HTTP_UNREACHABLE');
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Rendering / presentation
// ---------------------------------------------------------------------------

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderResults(value) {
  const lines = [];
  const { query, total, truncated, results, countOnly, totalExact, notes } = value;
  if (countOnly) {
    lines.push(total === 0 ? `Everything "${query}": no matches.` : `Everything "${query}": ${total} match(es) (count only).`);
    return lines.join('\n');
  }
  if (results.length === 0) {
    lines.push(`Everything "${query}": no matches.`);
    return lines.join('\n');
  }
  const totalText = totalExact === false ? `≥${total}` : String(total);
  lines.push(`Everything "${query}": ${results.length} of ${totalText} result(s)${truncated ? ' (truncated, refine the query, raise maxResults, or page with offset)' : ''}:`);
  for (const note of Array.isArray(notes) ? notes : []) lines.push(`  note: ${note}`);
  for (const entry of results) {
    const meta = [entry.size !== undefined ? formatSize(entry.size) : null, entry.dateModified ?? null, entry.dateCreated ? `created ${entry.dateCreated}` : null]
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
      description: 'Restrict the search to this directory and everything below it (absolute path; must exist).',
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
    dateCreated: {
      type: 'boolean',
      description: 'Also return the creation date of each result (costs a little extra time per result).',
    },
    countOnly: {
      type: 'boolean',
      description: 'Return only the total number of matches, without listing paths (fastest way to check existence or estimate volume).',
    },
    exactTotal: {
      type: 'boolean',
      description:
        'When a full page is returned, fetch the exact total match count (default true). Set false to skip that extra round-trip and get a fast "≥N" total.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const TOOL_DESCRIPTION =
  'Locate files and folders across every indexed drive on this machine through the local Everything (voidtools) index — answers in milliseconds, far faster than glob or a recursive directory scan. Use this FIRST whenever you need to find a file or folder by name, extension, or path, especially outside the workspace. The query uses Everything search syntax, not a glob: plain words match names, `*`/`?` wildcards, `ext:js;ts` filters extensions, `dm:today` / `dm:thisweek` filter date modified, `size:>10mb` filters size, space means AND, `|` means OR, `!` means NOT. Two quoting quirks: do NOT quote a filename-with-extension like "report.docx" — quoted phrases only match the name part, so pass it unquoted; a whole-query quoted phrase with spaces (exact multi-word match) is auto-converted to a regex. Combine sort="date-modified-descending" with dm:thisweek for recently changed files, or sort="size-descending" to find the biggest ones first. Restrict scope with the dedicated path parameter rather than a path: prefix inside query. Set regex=true for a regular expression over the whole path, countOnly=true for a fast match count without paths, dateCreated=true to also return creation dates, exactTotal=false to trade the exact total for speed on full pages. Returns absolute paths with size and date modified; non-ASCII names come back intact. Names and paths only, never file contents — use grep for content. Coverage follows the local Everything index: NTFS/reFS drives and explicitly added folders; FAT/exFAT removable drives and network shares are typically not indexed.';

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'total', 'truncated', 'results'],
  properties: {
    query: { type: 'string' },
    total: { type: 'integer' },
    totalExact: { type: 'boolean', description: 'false means total is a page-based lower bound ("≥N").' },
    truncated: { type: 'boolean' },
    countOnly: { type: 'boolean' },
    channel: { type: 'string', description: 'Which Everything channel served the call: "http" or "es".' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Non-fatal remarks about how the query was interpreted.' },
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
          dateCreated: { type: 'string' },
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
  const httpPort = clampInt(config.httpPort, 0, 65535, DEFAULT_HTTP_PORT);
  const httpAutoEnable = config.httpAutoEnable !== false;
  const httpUsername = typeof config.httpUsername === 'string' ? config.httpUsername.trim() : '';
  const httpPassword = typeof config.httpPassword === 'string' ? config.httpPassword : '';

  // Mutable: auto-install may re-resolve both paths after provisioning.
  let esPath = resolveEsPath(config);
  let everythingPath = resolveEverythingPath(config, esPath ?? 'es.exe');

  // HTTP channel state: cached readiness, a 30s breaker after failures, and
  // a one-shot flag so an auth failure is logged once, not per call.
  const httpState = { ready: false, downUntil: 0, authWarned: false };
  let httpSetupDone = false;

  /**
   * One shared provisioning run. Rejects clear the cache so the next call can
   * retry (e.g. after the user approves a UAC prompt on a second attempt).
   */
  let setupPromise = null;

  // Serializes es.exe spawns with the one-shot HTTP enable. The enable step
  // restarts the Everything GUI; on machines where Everything runs as a lone
  // GUI process (no background service) that kills the IPC endpoint too, so
  // a query racing the restart window would block on dead IPC until its
  // timeout. Queries instead queue behind the restart; the restart also
  // waits for any in-flight query before killing the process.
  let backendGate = Promise.resolve();
  function gateBackend(fn) {
    const run = backendGate.then(fn, fn);
    backendGate = run.then(() => undefined, () => undefined);
    return run;
  }

  function ensureReady() {
    if (!setupPromise) {
      setupPromise = ensureBackend({
        config,
        log: ctx.logger,
        probe: async (es, evPath) => {
          try {
            await runEs(es, ['-get-everything-version'], 3000);
          } catch (error) {
            if (error instanceof EverythingError && error.code === 'ES_NOT_RUNNING' && autoStart && existsSync(evPath)) {
              await autoStartEverything(evPath, es);
              return;
            }
            throw error;
          }
        },
      })
        .then(async (result) => {
          esPath = result.esPath;
          everythingPath = result.everythingPath;
          if (result.installed.length > 0) ctx.logger?.info?.(`everything_search: auto-installed ${result.installed.join(', ')} under ${result.installDir}`);
          // One-time attempt to switch Everything's own config on so its
          // HTTP JSON server starts (the fast channel). Best effort only.
          if (httpPort > 0 && httpAutoEnable && !httpSetupDone) {
            httpSetupDone = true;
            try {
              const r = await gateBackend(() => ensureHttpServer({ port: httpPort, everythingPath, log: ctx.logger, username: httpUsername, password: httpPassword }));
              if (r.enabled || r.alreadyRunning) {
                httpState.ready = true;
                httpState.downUntil = 0; // clear the breaker so the next call uses HTTP
              }
              if (r.enabled) {
                ctx.logger?.info?.(`everything_search: HTTP channel enabled (127.0.0.1:${httpPort}); searches will skip per-call es.exe launches.`);
              }
            } catch (error) {
              ctx.logger?.warn?.(`everything_search: HTTP channel setup failed (${error?.message ?? error}); staying on the es.exe channel.`);
            }
          }
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

  /**
   * Run one es.exe argv with backend recovery: provision the CLI/Everything
   * when missing (autoInstall), start Everything when it is not running
   * (autoStart). Shared by the search path and count-only mode.
   */
  async function runEsWithRetry(argv, signal) {
    const es = () => esPath ?? 'es.exe';
    try {
      return await gateBackend(() => runEs(es(), argv, timeoutMs, signal));
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
      await autoStartEverything(everythingPath, es(), signal);
      return gateBackend(() => runEs(es(), argv, timeoutMs, signal));
    }
  }

  async function searchOnce(input, query, limit, offset, signal) {
    const flags = buildSearchFlags(input, query);
    const searchArgv = ['-n', String(offset + limit), '-json', '-size', '-dm', '-date-format', '1'];
    if (input.dateCreated === true) searchArgv.push('-dc');
    if (offset > 0) searchArgv.push('-viewport-offset', String(offset));
    searchArgv.push(...flags);

    // Primary path: es.exe writes results to a UTF-8 file. Piping stdout
    // instead emits the ANSI codepage and mangles non-ASCII names (GBK on a
    // zh-CN machine, question marks elsewhere).
    const exportPath = joinPath(tmpdir(), `dsh-everything-${process.pid}-${Date.now()}-${++exportFileCounter}.json`);
    try {
      let stdoutBuf;
      try {
        stdoutBuf = await runEsWithRetry([...searchArgv, '-export-json', exportPath], signal);
      } catch (error) {
        // es.exe builds that reject the option: retry once in stdout mode.
        if (!(error instanceof EverythingError) || error.code !== 'ES_FAILED' || !/export|unknown|invalid|option/i.test(error.message ?? '')) throw error;
        stdoutBuf = await runEsWithRetry(searchArgv, signal);
        return { flags, results: parseResults(decodeEsStdout(stdoutBuf)) };
      }
      const exported = await readExportText(exportPath);
      if (!exported.exists || exported.text.length === 0) {
        // No file written (or an es.exe that ignores the option): fall back
        // to decoding stdout instead of reporting a fake empty result.
        return { flags, results: parseResults(decodeEsStdout(stdoutBuf)) };
      }
      return { flags, results: parseResults(exported.text) };
    } finally {
      try {
        await unlink(exportPath);
      } catch {
        /* best effort */
      }
    }
  }

  /** Is the HTTP channel up? Probes lazily; 30s breaker after failures. */
  async function httpChannelReady() {
    if (httpPort <= 0) return false;
    if (httpState.ready) return true;
    if (Date.now() < httpState.downUntil) return false;
    try {
      await probeHttpPort(httpPort, { timeoutMs: 1500, username: httpUsername, password: httpPassword });
      httpState.ready = true;
      return true;
    } catch {
      httpState.downUntil = Date.now() + HTTP_RETRY_DOWN_MS;
      // The server is down: one shot per session at switching Everything's
      // own config on (config patch + GUI restart, never blocks this call).
      if (httpAutoEnable && !httpSetupDone && (esPath || existsSync(everythingPath))) {
        void ensureReady().catch(() => {
          /* logged inside ensureReady */
        });
      }
      return false;
    }
  }

  /** One HTTP search (or count). Throws ES_HTTP_* to let the caller fall back to es.exe. */
  async function httpSearch(input, query, limit, offset, signal) {
    const params = httpSearchParams(input, query, { limit, offset });
    const url = `http://127.0.0.1:${httpPort}/?${new URLSearchParams(params).toString()}`;
    const headers = httpUsername ? { authorization: `Basic ${Buffer.from(`${httpUsername}:${httpPassword}`).toString('base64')}` } : undefined;
    const res = await fetchHttp(url, { headers, signal, timeoutMs: Math.min(timeoutMs, HTTP_REQUEST_CAP_MS) });
    if (res.status === 401 || res.status === 403) {
      throw new EverythingError(`everything_search: the Everything HTTP server rejected the credentials (HTTP ${res.status}); check httpUsername/httpPassword in the plugin config.`, 'ES_HTTP_AUTH');
    }
    if (!res.ok) {
      throw new EverythingError(`everything_search: the Everything HTTP server returned HTTP ${res.status}.`, 'ES_HTTP_UNREACHABLE');
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new EverythingError('everything_search: the Everything HTTP server returned a malformed response.', 'ES_HTTP_UNREACHABLE');
    }
    if (typeof json?.totalResults !== 'number' || !Array.isArray(json.results)) {
      throw new EverythingError('everything_search: unexpected JSON from the Everything HTTP server (is another service on that port?).', 'ES_HTTP_UNREACHABLE');
    }
    const total = json.totalResults;
    if (input.countOnly === true) return { total, results: [], truncated: false, totalExact: true, countOnly: true };
    const results = [];
    for (const item of json.results) {
      if (typeof item !== 'object' || item === null) continue;
      const dir = typeof item.path === 'string' ? item.path : '';
      const name = typeof item.name === 'string' ? item.name : '';
      if (name.length === 0 && dir.length === 0) continue;
      const entry = { path: dir ? (dir.endsWith('\\') ? dir + name : `${dir}\\${name}`) : name };
      if (typeof item.size === 'string' && item.size.length > 0) {
        const n = Number(item.size);
        if (Number.isFinite(n)) entry.size = n;
      }
      if (typeof item.date_modified === 'string' && item.date_modified.length > 0) {
        const iso = fileTimeToLocalIso(item.date_modified);
        if (iso !== undefined) entry.dateModified = iso;
      }
      results.push(entry);
    }
    return { total, results, truncated: total > offset + results.length, totalExact: true };
  }

  /** Reject a local-drive path that does not exist (or is a file) up front. */
  function validatePathExists(pathArg) {
    if (/^[a-z]:[\\/]/i.test(pathArg)) {
      if (!existsSync(pathArg)) {
        throw new EverythingError(`everything_search: path does not exist: ${pathArg}`, 'ES_INVALID_ARGS');
      }
      try {
        if (statSync(pathArg).isFile()) {
          throw new EverythingError(`everything_search: path must be a directory, not a file: ${pathArg} (drop the path parameter, or pass its parent directory).`, 'ES_INVALID_ARGS');
        }
      } catch (error) {
        if (error instanceof EverythingError) throw error;
        /* statSync raced — treat as existing */
      }
    }
  }

  /** UNC paths cannot be stat-checked cheaply up front: check after a miss. */
  function noteUncMissing(pathArg, results) {
    if (results.length === 0 && typeof pathArg === 'string' && pathArg.startsWith('\\\\') && !existsSync(pathArg)) {
      throw new EverythingError(`everything_search: path does not exist: ${pathArg}`, 'ES_INVALID_ARGS');
    }
  }

  async function execute(args, exec) {
    const input = typeof args === 'object' && args !== null ? args : {};
    const signal = exec?.signal;
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length === 0) throw new EverythingError('everything_search: "query" must be a non-empty Everything search expression.', 'ES_INVALID_ARGS');
    const limit = clampInt(input.maxResults, 1, MAX_RESULTS_CEILING, maxResults);
    const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    if (typeof input.sort === 'string' && input.sort.trim().length > 0 && !SORT_NAME_RE.test(input.sort.trim())) {
      throw new EverythingError(`everything_search: invalid sort "${input.sort.trim()}"; use e.g. "date-modified-descending", "size", "name-ascending".`, 'ES_INVALID_ARGS');
    }

    // Exact-phrase upgrade (a whole-query quoted phrase with spaces becomes
    // an equivalent regex — the only way to express it on either channel).
    const prep = prepareQuery(query);
    const effectiveQuery = prep.query;
    const regexMode = input.regex === true || prep.regex;
    const notes = prep.note ? [prep.note] : [];

    const pathArg = typeof input.path === 'string' ? input.path.trim() : '';
    if (pathArg.length > 0) validatePathExists(pathArg);
    const flagsInput = { ...input, regex: regexMode };

    // Channel choice. The HTTP server has no date_created column, supports
    // only a subset of sort keys, and its regex mode does not interpret
    // path:/folder:/file: prefixes — those combinations go to es.exe.
    const httpSortOk = httpSortParams(input.sort) !== null;
    const httpEligible =
      httpSortOk &&
      (input.countOnly === true || input.dateCreated !== true) &&
      !(regexMode && (pathArg.length > 0 || input.foldersOnly === true || input.filesOnly === true));

    if (httpEligible && (await httpChannelReady())) {
      try {
        const res = await httpSearch(flagsInput, effectiveQuery, limit, offset, signal);
        noteUncMissing(pathArg, res.results);
        return { query, ...res, channel: 'http', ...(notes.length > 0 ? { notes } : {}) };
      } catch (error) {
        if (error instanceof EverythingError && error.code === 'ES_ABORTED') throw error;
        if (error instanceof EverythingError && (error.code === 'ES_HTTP_UNREACHABLE' || error.code === 'ES_HTTP_AUTH')) {
          // Circuit-break the HTTP channel for 30s and fall back to es.exe.
          httpState.ready = false;
          httpState.downUntil = Date.now() + HTTP_RETRY_DOWN_MS;
          if (error.code === 'ES_HTTP_AUTH' && !httpState.authWarned) {
            httpState.authWarned = true;
            ctx.logger?.warn?.(error.message);
          }
        } else {
          throw error;
        }
      }
    }

    // es.exe channel. Report phrases that had to be degraded to ANDed words.
    if (!regexMode) {
      const { degraded } = tokenizeQuery(effectiveQuery);
      for (const phrase of degraded) {
        notes.push(`quoted phrase "${phrase}" contains spaces; matched as ANDed words instead (use regex=true, or a whole-query quoted phrase, for exact multi-word matching)`);
      }
    }

    // Count-only mode: one IPC round-trip, no paths listed.
    if (input.countOnly === true) {
      const flags = buildSearchFlags(flagsInput, effectiveQuery);
      const countOut = await runEsWithRetry(['-get-result-count', ...flags], signal);
      const total = Number.parseInt(String(countOut).trim(), 10);
      if (!Number.isFinite(total) || total < 0) {
        throw new EverythingError(`everything_search: could not parse the result count ("${countOut}").`, 'ES_PARSE_FAILED');
      }
      return { query, total, truncated: false, results: [], countOnly: true, totalExact: true, channel: 'es', ...(notes.length > 0 ? { notes } : {}) };
    }

    const { flags, results } = await searchOnce(flagsInput, effectiveQuery, limit, offset, signal);
    noteUncMissing(pathArg, results);

    // The exact total costs a second IPC round-trip; only fetch it when the
    // page is full and the caller has not opted out (exactTotal=false).
    let total = offset + results.length;
    let totalExact = results.length < limit;
    if (results.length === limit && input.exactTotal !== false) {
      try {
        const countOut = await runEs(esPath, ['-get-result-count', ...flags], timeoutMs, signal);
        const parsed = Number.parseInt(String(countOut).trim(), 10);
        if (Number.isFinite(parsed) && parsed >= total) {
          total = parsed;
          totalExact = true;
        }
      } catch {
        /* count is cosmetic; keep the page-based estimate */
      }
    }

    // With an exact total, "truncated" means more results exist past this
    // page; with a page-based estimate (exactTotal=false) a full page always
    // reports as truncated because more results may exist.
    const truncated = totalExact ? total > offset + results.length : results.length === limit;

    return { query, total, truncated, totalExact, results, channel: 'es', ...(notes.length > 0 ? { notes } : {}) };
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
  decodeEsStdout,
  fileTimeToLocalIso,
  formatSize,
  httpSearchParams,
  httpSortParams,
  parseResults,
  phraseToRegex,
  prepareQuery,
  presentCall,
  presentResult,
  renderResults,
  resolveEsPath,
  tokenizeQuery,
};
