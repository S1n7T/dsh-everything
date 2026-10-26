import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSetupSilentArgs,
  buildWingetInstallArgs,
  compareVersions,
  parseDownloadsPage,
  parseProxyFromRegOutput,
  resolveInstallDir,
  resolveProxy,
  sha256File,
  PINS,
} from '../setup.js';

describe('resolveInstallDir', () => {
  it('prefers an explicit config.installDir', () => {
    assert.equal(resolveInstallDir({ installDir: 'D:\\custom' }, {}), 'D:\\custom');
  });
  it('uses %LOCALAPPDATA% when present', () => {
    assert.equal(resolveInstallDir({}, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }), 'C:\\Users\\u\\AppData\\Local\\dsh-everything');
  });
  it('falls back to %USERPROFILE%\\AppData\\Local', () => {
    assert.equal(resolveInstallDir({}, { USERPROFILE: 'C:\\Users\\u' }), 'C:\\Users\\u\\AppData\\Local\\dsh-everything');
  });
  it('throws when no base directory can be resolved', () => {
    assert.throws(() => resolveInstallDir({}, {}), /LOCALAPPDATA/);
  });
});

describe('parseProxyFromRegOutput', () => {
  it('returns null when the proxy is disabled', () => {
    const text = '    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n';
    assert.equal(parseProxyFromRegOutput(text), null);
  });
  it('parses a plain host:port proxy', () => {
    const text = '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n';
    assert.equal(parseProxyFromRegOutput(text), 'http://127.0.0.1:7897');
  });
  it('prefers the https= entry of a per-protocol proxy string', () => {
    const text = '    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=10.0.0.1:8080;https=10.0.0.2:8443\r\n';
    assert.equal(parseProxyFromRegOutput(text), 'http://10.0.0.2:8443');
  });
  it('returns null on garbage', () => {
    assert.equal(parseProxyFromRegOutput('not reg output'), null);
    assert.equal(parseProxyFromRegOutput(''), null);
    assert.equal(parseProxyFromRegOutput(null), null);
  });
});

describe('resolveProxy', () => {
  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    assert.equal(resolveProxy({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' }), 'http://a:1');
  });
  it('returns null when nothing is set', () => {
    assert.equal(resolveProxy({}), null);
  });
});

describe('installer argv builders', () => {
  it('winget args pin the package id and accept agreements', () => {
    const argv = buildWingetInstallArgs();
    assert.deepEqual(argv.slice(0, 3), ['install', '--id', 'voidtools.Everything']);
    assert.ok(argv.includes('--silent'));
    assert.ok(argv.includes('--accept-package-agreements'));
    assert.ok(argv.includes('--accept-source-agreements'));
  });
  it('setup args are NSIS silent', () => {
    assert.deepEqual(buildSetupSilentArgs(), ['/S']);
  });
});

describe('sha256File', () => {
  it('hashes a known payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-everything-hash-'));
    const file = join(dir, 'payload.bin');
    writeFileSync(file, 'abc');
    // echo -n "abc" | sha256sum
    assert.equal(await sha256File(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('PINS', () => {
  it('pins both downloads to a sha256 and a voidtools.com URL', () => {
    for (const pin of [PINS.es, PINS.everything]) {
      assert.match(pin.url, /^https:\/\/www\.voidtools\.com\//);
      assert.match(pin.sha256, /^[0-9a-f]{64}$/);
      assert.ok(pin.bytes > 0);
    }
  });
});

describe('compareVersions', () => {
  it('compares dotted versions numerically', () => {
    assert.ok(compareVersions('1.4.1', '1.10.0') < 0);
    assert.ok(compareVersions('1.1.0.38', '1.1.0.37') > 0);
    assert.equal(compareVersions('1.4.1.1032', '1.4.1.1032'), 0);
  });
});

describe('parseDownloadsPage', () => {
  // Mirrors the real voidtools.com/downloads/ link layout (2026-10-26).
  const PAGE = [
    '<a href="/ES-1.1.0.38.x64.zip">x64</a>',
    '<a href="/ES-1.1.0.38.x86.zip">x86</a>',
    '<a href="/ES-1.1.0.38.ARM64.zip">ARM64</a>',
    '<a href="/ES-1.1.0.37.x64.zip">older</a>',
    '<a href="/Everything-1.4.1.1032.x64-Setup.exe">stable</a>',
    '<a href="/Everything-1.4.1.1032.x64.en-US-Setup.exe">en-US</a>',
    '<a href="/Everything-1.4.1.1032.x64.Lite-Setup.exe">lite</a>',
    '<a href="/Everything-1.4.1.1032.x86-Setup.exe">x86</a>',
    '<a href="/Everything-1.5.0.1424b.x64-Setup.exe">beta</a>',
  ].join('\n');

  it('picks the latest stable x64 ES CLI, skipping other arches and older versions', () => {
    assert.deepEqual(parseDownloadsPage(PAGE).es, {
      version: '1.1.0.38',
      url: 'https://www.voidtools.com/ES-1.1.0.38.x64.zip',
    });
  });
  it('picks the latest stable multilingual x64 Everything setup, skipping beta/lite/en-US', () => {
    assert.deepEqual(parseDownloadsPage(PAGE).everything, {
      version: '1.4.1.1032',
      url: 'https://www.voidtools.com/Everything-1.4.1.1032.x64-Setup.exe',
    });
  });
  it('returns nulls on empty or unrecognizable input', () => {
    assert.deepEqual(parseDownloadsPage(''), { es: null, everything: null });
    assert.deepEqual(parseDownloadsPage('<html>nothing here</html>'), { es: null, everything: null });
    assert.deepEqual(parseDownloadsPage(null), { es: null, everything: null });
  });
});
