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
import { join } from 'node:path';
import { apply } from '../index.js';

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

function loadTool(config = {}) {
  let registered = null;
  apply({ tools: { register(def) { registered = def; return () => {}; } } }, { esPath, autoStart: true, ...config });
  return registered;
}

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
    found = lastValue.results.find((r) => r.path.toLowerCase() === filePath.toLowerCase()) ?? null;
    if (found === null) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(found, `expected ${filePath} in results; last value: ${JSON.stringify(lastValue)}`);
  assert.equal(found.size, 24);
  assert.equal(typeof found.dateModified, 'string');
  assert.equal(lastValue.truncated, false);
});

test('path scoping and maxResults are honored', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: '*', path: 'D:\\Everything', maxResults: 3 });
  assert.ok(value.results.length <= 3);
  assert.ok(value.results.every((r) => r.path.startsWith('D:\\Everything')));
  assert.equal(typeof value.total, 'number');
});

test('regex search matches full paths', { skip, timeout: 60000 }, async () => {
  const tool = loadTool();
  const value = await tool.execute({ query: '^D:\\\\Everything\\\\es\\.exe$', regex: true, matchCase: false });
  assert.ok(value.results.some((r) => r.path === 'D:\\Everything\\es.exe'));
});
