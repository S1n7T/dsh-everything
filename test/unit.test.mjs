import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  buildSearchFlags,
  clampInt,
  decodeEsStdout,
  EverythingError,
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
  tokenizeQuery,
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

test('buildSearchFlags: multi-word query is split into separate es.exe terms', () => {
  // es.exe takes each argument as ONE search term; a term containing a space
  // is matched literally and never matches. So "*.docx dm:thisweek" MUST be
  // passed as two arguments.
  assert.deepEqual(buildSearchFlags({}, 'report ext:docx'), ['report', 'ext:docx']);
  assert.deepEqual(buildSearchFlags({}, '   *.sln\t dm:thisweek  '), ['*.sln', 'dm:thisweek']);
});

test('buildSearchFlags: query reduced to nothing but quotes is rejected', () => {
  assert.throws(
    () => buildSearchFlags({}, '  "" "" '),
    (e) => e instanceof EverythingError && e.code === 'ES_INVALID_ARGS'
  );
});

test('tokenizeQuery: quoted phrase without spaces keeps its quotes', () => {
  assert.deepEqual(tokenizeQuery('"exact-phrase" ext:md'), { terms: ['"exact-phrase"', 'ext:md'], degraded: [] });
});

test('tokenizeQuery: quoted phrase with spaces degrades to its words and is reported', () => {
  // es.exe cannot express a positional term containing a space.
  assert.deepEqual(tokenizeQuery('"foo bar" *.txt'), { terms: ['foo', 'bar', '*.txt'], degraded: ['foo bar'] });
});

test('tokenizeQuery: unbalanced quotes keep the trailing token', () => {
  assert.deepEqual(tokenizeQuery('foo "bar'), { terms: ['foo', '"bar'], degraded: [] });
});

test('tokenizeQuery: quote-only and whitespace-only tokens are dropped', () => {
  assert.deepEqual(tokenizeQuery('  ""   "" '), { terms: [], degraded: [] });
});

test('prepareQuery: a whole-query quoted phrase with spaces becomes a regex', () => {
  const prep = prepareQuery('"final report"');
  assert.equal(prep.query, 'final\\s+report');
  assert.equal(prep.regex, true);
  assert.match(prep.note, /converted to a regular expression/);
});

test('prepareQuery: plain queries and quote-free phrases pass through', () => {
  assert.deepEqual(prepareQuery('  *.docx dm:thisweek '), { query: '*.docx dm:thisweek', regex: false, note: null });
  assert.deepEqual(prepareQuery('"dsh-everything"'), { query: '"dsh-everything"', regex: false, note: null });
  // A quoted phrase alongside other terms is handled by tokenizeQuery instead.
  assert.deepEqual(prepareQuery('"foo bar" x'), { query: '"foo bar" x', regex: false, note: null });
});

test('phraseToRegex: escapes regex metacharacters word by word', () => {
  assert.equal(phraseToRegex('a.b (c)'), 'a\\.b\\s+\\(c\\)');
  assert.equal(phraseToRegex('  spaced   out  '), 'spaced\\s+out');
});

test('decodeEsStdout: pure ASCII passes through', () => {
  assert.equal(decodeEsStdout(Buffer.from('47\r\n', 'utf8')), '47\r\n');
});

test('decodeEsStdout: valid UTF-8 passes through untouched', () => {
  const text = '[{"filename":"C:\\\\包干区.txt"}]';
  assert.equal(decodeEsStdout(Buffer.from(text, 'utf8')), text);
});

test('decodeEsStdout: GBK bytes are decoded as GBK (console codepage output)', { skip: gbkDecoderUnavailable() }, () => {
  // "包干区" in GBK: B0FC B8C9 C7F8 — invalid as UTF-8, decodable as GBK.
  const gbk = Buffer.from([0xb0, 0xfc, 0xb8, 0xc9, 0xc7, 0xf8]);
  assert.equal(decodeEsStdout(gbk), '包干区');
});

function gbkDecoderUnavailable() {
  try {
    new TextDecoder('gbk');
    return false;
  } catch {
    return true; // small-ICU Node build without legacy decoder support
  }
}

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
  apply(ctx, { esPath: 'D:\\Everything\\es.exe', autoInstall: false, httpPort: 0 });
  assert.equal(registered.name, 'everything_search');
  assert.equal(registered.isConcurrencySafe({}), true);
  assert.deepEqual(registered.parameters.required, ['query']);
  assert.equal(registered.parameters.additionalProperties, false);
});

test('apply: empty query is rejected before any spawn', async () => {
  let registered = null;
  apply({ tools: { register(def) { registered = def; return () => {}; } } }, { esPath: 'D:\\Everything\\es.exe', autoInstall: false, httpPort: 0 });
  // On non-Windows the platform stub answers before argument validation runs.
  const expectedCode = process.platform === 'win32' ? 'ES_INVALID_ARGS' : 'ES_UNSUPPORTED_PLATFORM';
  await assert.rejects(() => registered.execute({ query: '   ' }), (e) => e instanceof EverythingError && e.code === expectedCode);
});

test('apply: missing es.exe yields ES_NOT_FOUND', { skip: process.platform !== 'win32' }, async () => {
  let registered = null;
  apply({ tools: { register(def) { registered = def; return () => {}; } } }, { esPath: 'D:\\definitely\\missing\\es.exe', autoStart: false, autoInstall: false, httpPort: 0 });
  await assert.rejects(() => registered.execute({ query: 'x' }), (e) => e instanceof EverythingError && e.code === 'ES_NOT_FOUND');
});

test('httpSortParams: maps supported keys, null for HTTP-unsupported ones', () => {
  assert.deepEqual(httpSortParams(undefined), {});
  assert.deepEqual(httpSortParams('  '), {});
  assert.deepEqual(httpSortParams('name'), { sort: 'name', ascending: 1 });
  assert.deepEqual(httpSortParams('date-modified-descending'), { sort: 'date_modified', ascending: 0 });
  assert.deepEqual(httpSortParams('size-ascending'), { sort: 'size', ascending: 1 });
  // date-created / extension / run-count exist on es.exe but not the HTTP server.
  assert.equal(httpSortParams('date-created-descending'), null);
  assert.equal(httpSortParams('extension'), null);
});

test('httpSearchParams: folds scope and type filters into the search text', () => {
  const params = httpSearchParams({ foldersOnly: true, path: 'D:\\proj ' }, 'tmp', { limit: 25, offset: 50 });
  assert.equal(params.search, 'folder:tmp path:"D:\\proj"');
  assert.equal(params.json, '1');
  assert.equal(params.count, '25');
  assert.equal(params.offset, '50');
  assert.equal(params.path_column, '1');
  assert.equal(params.size_column, '1');
  assert.equal(params.date_modified_column, '1');
  assert.equal(params.regex, undefined);
});

test('httpSearchParams: flags, sort and countOnly', () => {
  const params = httpSearchParams(
    { filesOnly: true, regex: true, matchCase: true, wholeWord: true, sort: 'date-modified-descending', countOnly: true },
    'ab\\.exe',
    { limit: 10, offset: 0 }
  );
  assert.equal(params.search, 'file:ab\\.exe');
  assert.equal(params.regex, '1');
  assert.equal(params.case, '1');
  assert.equal(params.wholeword, '1');
  assert.equal(params.count, '1'); // countOnly: total comes free with a 1-row page
  assert.equal(params.sort, 'date_modified');
  assert.equal(params.ascending, '0');
});

test('fileTimeToLocalIso: epoch FILETIME, garbage and out-of-range values', () => {
  // 116444736000000000 == the Unix epoch; render it the way a local Date does.
  const d = new Date(0);
  const p = (x) => String(x).padStart(2, '0');
  const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  assert.equal(fileTimeToLocalIso('116444736000000000'), expected);
  assert.equal(fileTimeToLocalIso('garbage'), undefined);
  assert.equal(fileTimeToLocalIso(undefined), undefined);
  assert.equal(fileTimeToLocalIso('99999999999999999999'), undefined);
});

test('renderResults: notes are shown and inexact totals render as ≥N', () => {
  const text = renderResults({
    query: 'q',
    total: 100,
    totalExact: false,
    truncated: true,
    results: [{ path: 'D:\\a' }],
    notes: ['phrase degraded'],
  });
  assert.match(text, /≥100/);
  assert.match(text, /note: phrase degraded/);
});

