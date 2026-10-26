/**
 * dsh-everything auto-provisioning: download and install the search backend
 * (Everything 1.4 + the ES command line tool) on first use, so the tool works
 * on a fresh Windows machine without manual setup.
 *
 * Supply-chain posture: the latest stable version is resolved from the
 * official voidtools.com downloads page at install time. When it matches the
 * known-good release recorded in PINS, the download is SHA256-verified against
 * the recorded digest; otherwise (a newer upstream release, or the page being
 * unreachable and the pin used as fallback) the voidtools Authenticode
 * signature on the downloaded binary is verified instead. Both checks failing
 * aborts the install.
 *
 * Networking: direct download is always tried first (most users have no
 * proxy); a configured or Windows system proxy is only a fallback, and a stale
 * registry proxy can never break a machine that works direct.
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

/**
 * Known-good releases recorded from the official voidtools.com downloads on
 * 2026-10-26 (voidtools does not publish hashes; these digests were computed
 * from the live downloads). Used as the fallback when the downloads page
 * cannot be reached, and as the SHA256 trust anchor when the resolved latest
 * version matches one of them.
 */
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

const DOWNLOADS_PAGE = 'https://www.voidtools.com/downloads/';
const VOIDTOOLS_ORIGIN = 'https://www.voidtools.com';
const SIGNER_MATCH = /CN=voidtools/i;

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

/** Compare dotted numeric versions: compareVersions('1.4.1', '1.10.0') < 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Parse the voidtools.com downloads page into the latest STABLE x64 artifact
 * for each kind. Beta versions (a letter suffix like 1.5.0.1424b) and
 * non-default flavors (en-US, Lite, x86, ARM) are excluded. Returns
 * { es: {version,url}|null, everything: {version,url}|null }.
 */
export function parseDownloadsPage(html) {
  if (typeof html !== 'string' || html.length === 0) return { es: null, everything: null };
  const pick = (pattern) => {
    let best = null;
    for (const match of html.matchAll(pattern)) {
      const version = match[1];
      if (!best || compareVersions(version, best.version) > 0) {
        best = { version, url: `${VOIDTOOLS_ORIGIN}${match[0].startsWith('/') ? match[0] : `/${match[0]}`}` };
      }
    }
    return best;
  };
  return {
    es: pick(/ES-(\d+(?:\.\d+)+)\.x64\.zip/g),
    everything: pick(/Everything-(\d+(?:\.\d+)+)\.x64-Setup\.exe/g),
  };
}

/**
 * Resolve the download artifact for a kind ('es' | 'everything'): scrape the
 * downloads page for the latest stable release, falling back to the recorded
 * known-good pin when the page is unreachable or unparsable. The returned
 * sha256 is set only when the resolved version matches the known-good pin;
 * callers must then verify the Authenticode signature instead.
 */
export async function resolveArtifact(kind, { proxy, log } = {}) {
  try {
    const html = await fetchText(DOWNLOADS_PAGE, { proxy });
    const parsed = parseDownloadsPage(html);
    const latest = parsed[kind];
    if (latest) {
      const pin = PINS[kind];
      const sha256 = latest.version === pin.version ? pin.sha256 : null;
      if (!sha256) log?.info?.(`everything_search setup: upstream ${kind} is now ${latest.version} (newer than the recorded ${pin.version}); will verify its voidtools signature instead of a hash.`);
      return { ...latest, sha256 };
    }
    log?.warn?.(`everything_search setup: could not find a ${kind} download on the downloads page; using the recorded known-good release ${PINS[kind].version}.`);
  } catch (error) {
    log?.warn?.(`everything_search setup: downloads page unreachable (${error?.message ?? error}); using the recorded known-good release ${PINS[kind].version}.`);
  }
  return { version: PINS[kind].version, url: PINS[kind].url, sha256: PINS[kind].sha256 };
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

async function verifyHash(file, sha256, label) {
  const digest = await sha256File(file);
  if (digest !== sha256) {
    throw new EverythingError(
      `everything_search setup: ${label} download failed integrity check (expected sha256 ${sha256}, got ${digest}); aborting install.`,
      'ES_SETUP_FAILED'
    );
  }
}

/**
 * Verify the Authenticode signature of a downloaded binary: must be Valid and
 * signed by voidtools. Used for upstream releases newer than the recorded
 * known-good pin, where no SHA256 anchor exists.
 */
export async function verifySignature(file, label) {
  // Get-AuthenticodeSignature first; if its module fails to load (polluted
  // PSModulePath can break 5.1 type-data loading), fall back to raw .NET:
  // extract the signing cert and build a chain to a trusted root offline.
  const script = [
    `$f = '${file.replace(/'/g, "''")}'`,
    `$sig = $null`,
    `try { $sig = Get-AuthenticodeSignature -LiteralPath $f -ErrorAction Stop } catch {}`,
    `if ($sig -and $sig.Status -eq 'Valid' -and $sig.SignerCertificate -and $sig.SignerCertificate.Subject -match 'CN=voidtools') { 'OK'; exit 0 }`,
    `try {`,
    `  $raw = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($f)`,
    `  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, $raw)`,
    `  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain`,
    `  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Offline`,
    `  $ok = $chain.Build($cert)`,
    `  "CHAIN=$ok|$($cert.Subject)"`,
    `} catch { "CHAIN=False|$($_.Exception.Message)" }`,
  ].join('; ');
  let out;
  try {
    out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30000);
  } catch (error) {
    throw new EverythingError(
      `everything_search setup: could not verify the signature of ${label}: ${error?.message ?? error}`,
      'ES_SETUP_FAILED'
    );
  }
  const line = out.trim().split(/\r?\n/).pop() ?? '';
  if (line === 'OK') return;
  const m = /^CHAIN=(True|False)\|(.*)$/i.exec(line);
  if (m && m[1].toLowerCase() === 'true' && SIGNER_MATCH.test(m[2])) return;
  throw new EverythingError(
    `everything_search setup: ${label} failed signature verification (${line || 'no output'}; expected a valid voidtools signature); aborting install.`,
    'ES_SETUP_FAILED'
  );
}

async function fetchTextViaFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a text resource (the downloads page) with the same posture as
 * downloadFile: direct first, proxy only as a fallback.
 */
export async function fetchText(url, { timeoutMs = 60000, proxy } = {}) {
  if (proxy === undefined) proxy = resolveProxy() ?? (await detectSystemProxy());
  const attempts = [
    ['fetch', () => fetchTextViaFetch(url, timeoutMs)],
    ['curl', async () => run('curl.exe', ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), url], timeoutMs + 15000)],
  ];
  if (proxy) {
    attempts.push(['curl-proxy', async () => run('curl.exe', ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--proxy', proxy, url], timeoutMs + 15000)]);
  }
  attempts.push([
    'powershell',
    async () => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -UseBasicParsing -Headers @{ 'User-Agent' = 'Mozilla/5.0' }).Content`], timeoutMs + 15000),
  ]);
  let lastError = null;
  for (const [, fn] of attempts) {
    try {
      const text = await fn();
      if (typeof text === 'string' && text.length > 0) return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw new EverythingError(
    `everything_search setup: could not fetch ${url}: ${lastError?.message ?? lastError}`,
    lastError instanceof EverythingError ? lastError.code : 'ES_SETUP_FAILED'
  );
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
 * Download with layered fallbacks. DIRECT is always tried first (most users
 * have no proxy, and a stale registry proxy must not break them): fetch →
 * curl.exe direct → curl.exe through the detected proxy (only when one is
 * configured) → PowerShell Invoke-WebRequest (honours the system proxy).
 * When sha256 is given the file is hash-verified. When it is null (a newer
 * upstream release) no in-band check is possible here — callers must verify
 * the voidtools Authenticode signature of the resulting binary instead
 * (archives cannot be Authenticode-signed). Returns the strategy that worked.
 */
export async function downloadFile(url, dest, { timeoutMs = DOWNLOAD_TIMEOUT_MS, proxy, sha256 = null, label = 'file' } = {}) {
  if (proxy === undefined) proxy = resolveProxy() ?? (await detectSystemProxy());
  mkdirSync(win32path.dirname(dest), { recursive: true });
  const attempts = [
    ['fetch', () => downloadViaFetch(url, dest, timeoutMs)],
    ['curl', () => downloadViaCurl(url, dest, timeoutMs, null)],
  ];
  if (proxy) attempts.push(['curl-proxy', () => downloadViaCurl(url, dest, timeoutMs, proxy)]);
  attempts.push(['powershell', () => downloadViaPowerShell(url, dest, timeoutMs)]);
  let lastError = null;
  for (const [name, fn] of attempts) {
    try {
      await fn();
      if (sha256) await verifyHash(dest, sha256, label);
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
  // Strategy 2: latest official NSIS setup (resolved from the downloads
  // page), silent. One UAC prompt.
  const artifact = await resolveArtifact('everything', { proxy, log });
  const setupExe = win32path.join(installDir, 'dl', `Everything-${artifact.version}.x64-Setup.exe`);
  log?.info?.(`everything_search: downloading the official Everything ${artifact.version} setup…`);
  await downloadFile(artifact.url, setupExe, { proxy, sha256: artifact.sha256, label: 'Everything setup' });
  if (!artifact.sha256) await verifySignature(setupExe, 'Everything setup');
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
  const artifact = await resolveArtifact('es', { proxy, log });
  const zipPath = win32path.join(installDir, 'dl', 'es.zip');
  log?.info?.(`everything_search: downloading ES CLI ${artifact.version}…`);
  await downloadFile(artifact.url, zipPath, { proxy, sha256: artifact.sha256, label: 'ES CLI' });
  await expandZip(zipPath, binDir);
  const esPath = win32path.join(binDir, 'es.exe');
  if (!artifact.sha256) await verifySignature(esPath, 'ES CLI');
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
