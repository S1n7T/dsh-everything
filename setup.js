/**
 * dsh-everything auto-provisioning: download and install the search backend
 * (Everything 1.4 + the ES command line tool) on first use, so the tool works
 * on a fresh Windows machine without manual setup.
 *
 * Supply-chain posture: both downloads are pinned to an exact upstream version
 * and verified against a SHA256 recorded in this file (captured from the
 * official voidtools.com downloads on 2026-10-26; voidtools does not publish
 * hashes, so the pin is the trust anchor). A mismatch aborts the install.
 *
 * What lands where:
 *   - es.exe is extracted under %LOCALAPPDATA%\dsh-everything\bin (per-user, no admin).
 *   - Everything.exe installs machine-wide via winget when available, else via
 *     the official silent NSIS setup — either path may show one UAC prompt.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { win32 as win32path } from 'node:path';

export class EverythingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EverythingError';
    this.code = code;
  }
}

export const PINS = {
  es: {
    version: '1.1.0.37',
    url: 'https://www.voidtools.com/ES-1.1.0.37.x64.zip',
    sha256: '7a57670d9152068d05876c58858c82fe6d3915a9df2c819f4de8801e2929d3a7',
    bytes: 115002,
  },
  everything: {
    version: '1.4.1.1032',
    url: 'https://www.voidtools.com/Everything-1.4.1.1032.x64-Setup.exe',
    sha256: 'c42efad041d4c0bb4d4ac97ae7cbe89f153ec1fe078772392e749c7f5d5282d3',
    bytes: 1998736,
  },
};

const EVERYTHING_INSTALL_CANDIDATES = [
  'C:\\Program Files\\Everything\\Everything.exe',
  'C:\\Program Files (x86)\\Everything\\Everything.exe',
  'D:\\Everything\\Everything.exe',
];

const DOWNLOAD_TIMEOUT_MS = 120000;
const WINGET_TIMEOUT_MS = 300000;
const SETUP_TIMEOUT_MS = 120000;

export function resolveInstallDir(config, env = process.env) {
  if (config && typeof config.installDir === 'string' && config.installDir.trim().length > 0) {
    return config.installDir.trim();
  }
  const local =
    typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim().length > 0
      ? env.LOCALAPPDATA
      : typeof env.USERPROFILE === 'string' && env.USERPROFILE.length > 0
        ? win32path.join(env.USERPROFILE, 'AppData', 'Local')
        : null;
  if (!local) {
    throw new EverythingError(
      'everything_search setup: could not resolve %LOCALAPPDATA%; set installDir in the plugin config.',
      'ES_SETUP_FAILED'
    );
  }
  return win32path.join(local, 'dsh-everything');
}

/** Parse `reg query ...\Internet Settings` output into a proxy URL, or null. */
export function parseProxyFromRegOutput(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text);
  if (!enabled) return null;
  const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(text);
  if (!match) return null;
  const server = match[1];
  // Forms: "host:port" or per-protocol "http=host:port;https=host:port;..."
  const httpsPart = /(?:^|;)https=([^;]+)/i.exec(server);
  const target = httpsPart ? httpsPart[1] : server.includes('=') ? null : server;
  if (!target) return null;
  return /^[a-z]+:\/\//i.test(target) ? target : `http://${target}`;
}

export function resolveProxy(env = process.env) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Read the Windows system proxy (registry). Returns a proxy URL or null. */
export async function detectSystemProxy() {
  try {
    const out = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], 10000);
    return parseProxyFromRegOutput(out);
  } catch {
    return null;
  }
}

export function buildWingetInstallArgs() {
  return [
    'install',
    '--id',
    'voidtools.Everything',
    '-e',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ];
}

export function buildSetupSilentArgs() {
  return ['/S'];
}

function run(command, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const tail = typeof stderr === 'string' && stderr.trim() ? stderr.trim().slice(-300) : (error.message ?? String(error));
        reject(new EverythingError(`everything_search setup: "${command}" failed: ${tail}`, 'ES_SETUP_FAILED'));
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

export async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function verifyPin(file, pin, label) {
  const digest = await sha256File(file);
  if (digest !== pin.sha256) {
    throw new EverythingError(
      `everything_search setup: ${label} download failed integrity check (expected sha256 ${pin.sha256}, got ${digest}); aborting install. Download ${pin.url} manually and point the plugin at it.`,
      'ES_SETUP_FAILED'
    );
  }
}

async function downloadViaFetch(url, dest, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    await new Promise((resolveWrite, rejectWrite) => {
      const ws = createWriteStream(dest);
      ws.on('error', rejectWrite);
      ws.on('finish', resolveWrite);
      ws.end(buf);
    });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadViaCurl(url, dest, timeoutMs, proxy) {
  const argv = ['-fSL', '--connect-timeout', '30', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', dest];
  if (proxy) argv.push('--proxy', proxy);
  argv.push(url);
  await run('curl.exe', argv, timeoutMs + 15000);
}

async function downloadViaPowerShell(url, dest, timeoutMs) {
  const escapedUrl = url.replace(/'/g, "''");
  const escapedDest = dest.replace(/'/g, "''");
  const script = `Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedDest}' -UseBasicParsing -Headers @{ 'User-Agent' = 'Mozilla/5.0' }`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs + 15000);
}

/**
 * Download with layered fallbacks: direct fetch → curl.exe (honours the
 * HTTPS_PROXY env or the Windows system proxy) → PowerShell Invoke-WebRequest
 * (always honours the system proxy). Returns the strategy that worked.
 */
export async function downloadFile(url, dest, { timeoutMs = DOWNLOAD_TIMEOUT_MS, proxy, pin = null, label = 'file' } = {}) {
  if (proxy === undefined) proxy = resolveProxy() ?? (await detectSystemProxy());
  mkdirSync(win32path.dirname(dest), { recursive: true });
  const attempts = [
    ['fetch', () => downloadViaFetch(url, dest, timeoutMs)],
    ['curl', () => downloadViaCurl(url, dest, timeoutMs, proxy)],
    ['powershell', () => downloadViaPowerShell(url, dest, timeoutMs)],
  ];
  let lastError = null;
  for (const [name, fn] of attempts) {
    try {
      await fn();
      if (pin) await verifyPin(dest, pin, label);
      return name;
    } catch (error) {
      lastError = error;
    }
  }
  throw new EverythingError(
    `everything_search setup: could not download ${label} from ${url}: ${lastError?.message ?? lastError}`,
    lastError instanceof EverythingError ? lastError.code : 'ES_SETUP_FAILED'
  );
}

async function expandZip(zipPath, destDir) {
  const escapedZip = zipPath.replace(/'/g, "''");
  const escapedDir = destDir.replace(/'/g, "''");
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDir}' -Force`],
    60000
  );
}

export function findEverythingInstall() {
  for (const candidate of EVERYTHING_INSTALL_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function installEverything(installDir, log, proxy) {
  // Strategy 1: winget (present on most Windows 10/11 desktops).
  try {
    log?.info?.('everything_search: installing Everything via winget (a UAC prompt may appear)…');
    await run('winget', buildWingetInstallArgs(), WINGET_TIMEOUT_MS);
    const found = findEverythingInstall();
    if (found) return { everythingPath: found, via: 'winget' };
  } catch (error) {
    log?.warn?.(`everything_search: winget install failed (${error?.message ?? error}); falling back to the official setup.`);
  }
  // Strategy 2: pinned official NSIS setup, silent. One UAC prompt.
  const setupExe = win32path.join(installDir, 'dl', 'Everything-Setup.exe');
  await downloadFile(PINS.everything.url, setupExe, { proxy, pin: PINS.everything, label: 'Everything setup' });
  log?.info?.('everything_search: running the official Everything setup silently (a UAC prompt may appear)…');
  await run(setupExe, buildSetupSilentArgs(), SETUP_TIMEOUT_MS);
  const found = findEverythingInstall();
  if (!found) {
    throw new EverythingError(
      'everything_search setup: the Everything installer finished but Everything.exe was not found in the standard locations. Install it manually from https://www.voidtools.com/ and set everythingPath in the plugin config.',
      'ES_SETUP_FAILED'
    );
  }
  return { everythingPath: found, via: 'setup' };
}

async function provisionEs(installDir, log, proxy) {
  const binDir = win32path.join(installDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const zipPath = win32path.join(installDir, 'dl', 'es.zip');
  log?.info?.(`everything_search: downloading ES CLI ${PINS.es.version}…`);
  await downloadFile(PINS.es.url, zipPath, { proxy, pin: PINS.es, label: 'ES CLI' });
  await expandZip(zipPath, binDir);
  const esPath = win32path.join(binDir, 'es.exe');
  if (!existsSync(esPath)) {
    throw new EverythingError('everything_search setup: es.exe missing after extracting the ES archive.', 'ES_SETUP_FAILED');
  }
  return esPath;
}

/**
 * Make sure both halves of the backend exist. Returns the resolved paths and
 * which components were installed this run. The `probe` callback (injected by
 * index.js) runs `es.exe -get-everything-version` to confirm the whole chain.
 */
export async function ensureBackend({ config = {}, log = null, proxy, probe = null } = {}) {
  const installed = [];
  const installDir = resolveInstallDir(config);

  let esPath = typeof config.esPath === 'string' && config.esPath.trim().length > 0 ? config.esPath.trim() : null;
  if (esPath && !existsSync(esPath)) esPath = null;
  if (!esPath) {
    const provisioned = win32path.join(installDir, 'bin', 'es.exe');
    if (existsSync(provisioned)) {
      esPath = provisioned;
    } else {
      esPath = await provisionEs(installDir, log, proxy);
      installed.push('es-cli');
    }
  }

  let everythingPath =
    typeof config.everythingPath === 'string' && config.everythingPath.trim().length > 0 ? config.everythingPath.trim() : null;
  if (everythingPath && !existsSync(everythingPath)) everythingPath = null;
  if (!everythingPath) everythingPath = findEverythingInstall();
  if (!everythingPath) {
    const result = await installEverything(installDir, log, proxy);
    everythingPath = result.everythingPath;
    installed.push(`everything-${result.via}`);
  }

  if (probe) {
    try {
      await probe(esPath, everythingPath);
    } catch (error) {
      if (error instanceof EverythingError && error.code === 'ES_NOT_RUNNING') {
        // Installed but not started yet — index.js autoStart handles this path.
      } else {
        throw error;
      }
    }
  }

  return { esPath, everythingPath, installDir, installed };
}

/** Fire a detached, unref'd process. Used to (re)start Everything.exe. */
export function launchDetached(binaryPath, argv) {
  spawn(binaryPath, argv, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
