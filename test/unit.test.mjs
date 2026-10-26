import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  buildSearchFlags,
  clampInt,
  EverythingError,
  formatSize,
  parseResults,
  presentCall,
  presentResult,
  renderResults,
} from '../index.js';

test('clampInt: bounds and fallback', () => {
  assert.equal(clampInt(5, 1, 10, 3), 5);
  assert.equal(clampInt(0, 1, 10, 3), 1);
  assert.equal(clampInt(99, 1, 10, 3), 10);
  assert.equal(clampInt('x', 1, 10, 3), 3);
  assert.equal(clampInt(undefined, 1, 10, 3), 3);
  assert.equal(clampInt(7.9, 1, 10, 3), 7);
});

test('formatSize: thresholds', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(3 * 1024 * 1024 * 1024), '3.00 GB');
});

test('buildSearchFlags: plain query is appended last', () => {
  assert.deepEqual(buildSearchFlags({}, 'report ext:docx'), ['report ext:docx']);
});

test('buildSearchFlags: regex consumes the query as its value', () => {
  assert.deepEqual(buildSearchFlags({ regex: true }, '^foo.*\\.js$'), ['-regex', '^foo.*\\.js$']);
});

test('buildSearchFlags: flags combine in stable order', () => {
  const argv = buildSearchFlags(
    { matchCase: true, wholeWord: true, filesOnly: true, path: 'D:\\proj', sort: 'date-modified-descending' },
    'x'
  );
  assert.deepEqual(argv, ['-case', '-whole-words', '/a-d', '-path', 'D:\\proj', '-sort', 'date-modified-descending', 'x']);
});

test('buildSearchFlags: foldersOnly wins over filesOnly', () => {
  assert.ok(buildSearchFlags({ foldersOnly: true, filesOnly: true }, 'x').includes('/ad'));
});

test('buildSearchFlags: invalid sort is rejected', () => {
  assert.throws(() => buildSearchFlags({ sort: 'bad sort!' }, 'x'), (e) => e instanceof EverythingError && e.code === 'ES_INVALID_ARGS');
  assert.throws(() => buildSearchFlags({ sort: '-n' }, 'x'), EverythingError);
});

test('parseResults: maps es -json rows', () => {
  const stdout = '[{"filename":"D:\\\\a\\\\f.txt","size":9216,"date_modified":"2026-05-04T15:09:34"},\n{"filename":"D:\\\\b"}]';
  assert.deepEqual(parseResults(stdout), [
    { path: 'D:\\a\\f.txt', size: 9216, dateModified: '2026-05-04T15:09:34' },
    { path: 'D:\\b' },
  ]);
});

test('parseResults: maps date_created when requested', () => {
  const stdout = '[{"filename":"D:\\\\a\\\\f.txt","date_created":"2026-05-08T17:55:14","date_modified":"2026-05-04T15:09:34"}]';
  assert.deepEqual(parseResults(stdout), [
    { path: 'D:\\a\\f.txt', dateModified: '2026-05-04T15:09:34', dateCreated: '2026-05-08T17:55:14' },
  ]);
});

test('renderResults: count-only form', () => {
  const text = renderResults({ query: 'q', total: 1234, truncated: false, results: [], countOnly: true });
  assert.match(text, /1234 match\(es\) \(count only\)/);
  assert.doesNotMatch(text, /no matches/);
});

test('renderResults: dateCreated appears in the meta line', () => {
  const text = renderResults({
    query: 'q',
    total: 1,
    truncated: false,
    results: [{ path: 'D:\\a', dateCreated: '2026-05-08T17:55:14' }],
  });
  assert.match(text, /created 2026-05-08T17:55:14/);
});

test('parseResults: empty stdout is an empty list', () => {
  assert.deepEqual(parseResults(''), []);
  assert.deepEqual(parseResults('  \n'), []);
});

test('parseResults: malformed JSON throws a coded error', () => {
  assert.throws(() => parseResults('{oops'), (e) => e instanceof EverythingError && e.code === 'ES_PARSE_FAILED');
});

test('parseResults: skips malformed entries defensively', () => {
  assert.deepEqual(parseResults('[{"size":1},{"filename":"D:\\\\ok"},42,null]'), [{ path: 'D:\\ok' }]);
});

test('renderResults: no-match and truncated forms', () => {
  assert.match(renderResults({ query: 'q', total: 0, truncated: false, results: [] }), /no matches/);
  const text = renderResults({ query: 'q', total: 5, truncated: true, results: [{ path: 'D:\\a', size: 1024, dateModified: '2026-01-01' }] });
  assert.match(text, /1 of 5 result\(s\)/);
  assert.match(text, /truncated/);
  assert.match(text, /D:\\a/);
  assert.match(text, /1\.0 KB/);
});

test('presentCall: generic search card titled by query and path', () => {
  assert.deepEqual(presentCall({ query: 'foo', path: 'D:\\x' }), {
    card: 'generic',
    title: 'Everything foo in D:\\x',
    kind: 'search',
    rawInput: 'foo',
  });
});

test('presentResult: narrows meta, falls back on malformed input', () => {
  const meta = { shape: 'paths', paths: ['D:\\a'], truncated: false, total: 1 };
  assert.deepEqual(presentResult({}, { isError: false, meta }), { card: 'search', shape: 'paths', paths: ['D:\\a'], truncated: false, total: 1 });
  assert.equal(presentResult({}, { isError: true, meta }), undefined);
  assert.equal(presentResult({}, { isError: false, meta: null }), undefined);
  assert.equal(presentResult({}, { isError: false, meta: { shape: 'paths', paths: [1] } }), undefined);
  assert.equal(presentResult({}, { isError: false, meta: { shape: 'matches' } }), undefined);
});

test('apply: registers one tool named everything_search', () => {
  let registered = null;
  const ctx = { tools: { register(def) { registered = def; return () => {}; } } };
  apply(ctx, { esPath: 'D:\\Everything\\es.exe', autoInstall: false });
  assert.equal(registered.name, 'everything_search');
  assert.equal(registered.isConcurrencySafe({}), true);
  assert.deepEqual(registered.parameters.required, ['query']);
  assert.equal(registered.parameters.additionalProperties, false);
});

test('apply: empty query is rejected before any spawn', async () => {
  let registered = null;
  apply({ tools: { register(def) { registered = def; return () => {}; } } }, { esPath: 'D:\\Everything\\es.exe', autoInstall: false });
  // On non-Windows the platform stub answers before argument validation runs.
  const expectedCode = process.platform === 'win32' ? 'ES_INVALID_ARGS' : 'ES_UNSUPPORTED_PLATFORM';
  await assert.rejects(() => registered.execute({ query: '   ' }), (e) => e instanceof EverythingError && e.code === expectedCode);
});

test('apply: missing es.exe yields ES_NOT_FOUND', { skip: process.platform !== 'win32' }, async () => {
  let registered = null;
  apply({ tools: { register(def) { registered = def; return () => {}; } } }, { esPath: 'D:\\definitely\\missing\\es.exe', autoStart: false, autoInstall: false });
  await assert.rejects(() => registered.execute({ query: 'x' }), (e) => e instanceof EverythingError && e.code === 'ES_NOT_FOUND');
});

