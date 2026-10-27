/**
 * Integration test against a real, running Everything instance.
 * Skipped unless on Windows with es.exe available (ES_PATH env or the
 * well-known install locations).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply } from '../index.js';
import { compareVersions, getExeFileVersion } from '../setup.js';

const ES_CANDIDATES = [
  process.env.ES_PATH,
  'D:\\Everything\\es.exe',
  'C:\\Program Files\\Everything\\es.exe',
  'C:\\Program Files (x86)\\Everything\\es.exe',
].filter(Boolean);

const esPath = ES_CANDIDATES.find((p) => existsSync(p));
const skip = process.platform !== 'win32' || esPath === undefined
  ? 'requires Windows with es.exe installed (set ES_PATH to override detection)'
  : false;

// First-run index builds can take a while on a cold machine; give spawns room.
function loadTool(config = {}) {
  let registered = null;
  apply({ tools: { register(def) { registered = def; return () => {}; } } }, { esPath, autoStart: true, autoInstall: false, timeoutMs: 30000, ...config });
  return registered;
}

const everythingDir = esPath === undefined ? null : dirname(esPath);

test('finds a uniquely named file through the real index', { skip, timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-everything-'));
  const unique = `dsh-everything-itest-${Date.now()}.log`;
  const filePath = join(dir, unique);
  await writeFile(filePath, 'integration test payload');

  const tool = loadTool();
  let found = null;
  let lastValue;
  for (let i = 0; i < 15 && found === null; i += 1) {
    lastValue = await tool.execute({ query: unique });
    // Everything reports the long form of paths; TMPDIR may be an 8.3 short
    // name (e.g. RUNNER~1 on CI), so match on the unique file name.
    found = lastValue.results.find((r) => r.path.toLowerCase().endsWith(`\\${unique.toLowerCase()}`)) ?? null;
    if (found === null) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(found, `expected ${filePath} in results; last value: ${JSON.stringify(lastValue)}`);
  assert.equal(found.size, 24);
  assert.equal(typeof found.dateModified, 'string');
  assert.equal(lastValue.truncated, false);
});

test('path scoping and maxResults are honored', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: 'es.exe', path: everythingDir, maxResults: 3 });
  assert.ok(value.results.length <= 3);
  assert.ok(value.results.every((r) => r.path.startsWith(everythingDir)));
  assert.ok(value.results.length > 0, `expected es.exe under ${everythingDir}`);
  assert.equal(typeof value.total, 'number');
});

test('regex search matches full paths', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const escaped = esPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = await tool.execute({ query: `^${escaped}$`, regex: true, matchCase: false });
  assert.ok(value.results.some((r) => r.path.toLowerCase() === esPath.toLowerCase()));
});

test('countOnly returns a total without paths', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: 'es.exe', path: everythingDir, countOnly: true });
  assert.equal(value.countOnly, true);
  assert.deepEqual(value.results, []);
  assert.ok(Number.isInteger(value.total) && value.total >= 1, `expected a positive total, got ${value.total}`);
  assert.equal(value.truncated, false);
});

test('dateCreated adds the creation date column', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: 'es.exe', path: everythingDir, maxResults: 5, dateCreated: true });
  assert.ok(value.results.length > 0);
  for (const entry of value.results) {
    assert.equal(typeof entry.dateCreated, 'string', `missing dateCreated on ${entry.path}`);
    assert.match(entry.dateCreated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  }
});

test('getExeFileVersion reads a real FileVersion (self-update prerequisite)', { skip, timeout: 60000 }, async () => {
  const version = await getExeFileVersion(esPath);
  assert.match(version, /^\d+(\.\d+)+$/, `unexpected FileVersion format: "${version}"`);
  assert.equal(typeof compareVersions(version, '1.1.0.37'), 'number');
});

test('sort date-modified-descending orders recency end to end', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: 'es.exe', maxResults: 10, sort: 'date-modified-descending' });
  assert.ok(value.results.length >= 2, 'needs at least two results to check ordering');
  const times = value.results.map((r) => Date.parse(r.dateModified));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i - 1] >= times[i], `expected non-increasing dateModified, got ${value.results.map((r) => r.dateModified).join(' | ')}`);
  }
});

test('multi-word query ANDs its terms (es.exe takes one term per argument)', { skip, timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-everything-'));
  const unique = `dsh-multi-${Date.now()}.log`;
  await writeFile(join(dir, unique), 'multi-term payload');

  const tool = loadTool();
  // Pre-fix this single query string was passed as one es.exe argument,
  // matched literally and returned 0 results.
  let value;
  let found = null;
  for (let i = 0; i < 15 && found === null; i += 1) {
    value = await tool.execute({ query: `${unique} dm:today` });
    found = value.results.find((r) => r.path.toLowerCase().endsWith(`\\${unique.toLowerCase()}`)) ?? null;
    if (found === null) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(found, `expected ${unique} via multi-term query; last value: ${JSON.stringify(value)}`);
});

test('non-ASCII file names survive the round trip (UTF-8 export path)', { skip, timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-everything-'));
  const unique = `中文名-${Date.now()}.txt`;
  await writeFile(join(dir, unique), 'unicode payload');

  const tool = loadTool();
  const asciiPart = unique.slice(unique.indexOf('-') + 1);
  let value;
  let found = null;
  for (let i = 0; i < 15 && found === null; i += 1) {
    value = await tool.execute({ query: asciiPart });
    found = value.results.find((r) => r.path.toLowerCase().endsWith(`\\${unique.toLowerCase()}`)) ?? null;
    if (found === null) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(found, `expected ${unique}; last value: ${JSON.stringify(value)}`);
  assert.ok(!found.path.includes('\uFFFD'), `mojibake in path: ${found.path}`);
  assert.ok(found.path.includes('中文名'), `expected the CJK part intact in ${found.path}`);
});

test('zero-result queries return an empty page, not an error', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: `zzz-no-such-thing-${Date.now()}` });
  assert.deepEqual(value.results, []);
  assert.equal(value.total, 0);
  assert.equal(value.truncated, false);
});
