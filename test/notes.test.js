import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeNote, fetchNoteDetail, fetchAllNotes } from '../src/notes.js';

// 固定合成样本，不读取 Cookie、账号缓存或真实小记。
const detail = JSON.parse(fs.readFileSync(new URL('./fixtures/notes/client/detail.json', import.meta.url), 'utf8'));
const rawNote = (id) => ({ id, user_id: 42, content: { abstract: `摘要${id}` } });
const page = (notes, has_more = false, pin_notes = []) => ({ notes, pin_notes, has_more });
const statusError = (status) => Object.assign(new Error('合成请求错误'), { response: { status } });

function pagedClient(pages) {
  const requests = [];
  return {
    requests,
    async getJson(url) {
      const parsed = new URL(url);
      requests.push(parsed);
      return pages.get(Number(parsed.searchParams.get('offset')));
    },
  };
}

test('列表摘要是 Lake/HTML 源码时提取可读文字，纯图片小记使用兜底名称', () => {
  const html = '<ldoctype lake><meta name="doc-version" content="1"/><p>今天整理了<strong>导出</strong>方案</p>';
  assert.equal(normalizeNote({ id: 1, content: { abstract: html } }, '42').summary, '今天整理了 导出 方案');
  assert.equal(normalizeNote({ id: 1, content: { abstract: '' }, has_image: true }, '42').summary, '图片小记');
  assert.equal(normalizeNote({ id: 1, content: { abstract: '<p></p>' }, has_attachment: true }, '42').summary, '附件小记');
  assert.equal(normalizeNote({ id: 1, content: { abstract: '<p></p>' } }, '42').summary, '未命名小记');
});

test('归一化保留冻结字段，列表即使含全文也只返回摘要', () => {
  const note = normalizeNote(detail, 42);
  assert.deepEqual(note, {
    accountScope: '42', noteId: '501', documentKey: 'yuque-note:42:501',
    createdAt: detail.created_at, updatedAt: detail.content.updated_at, canonicalUrl: '',
    summary: '合成摘要', tags: ['项目', '计划'],
    body: '', bodyFormat: '', html: '', fullContentAvailable: false, rawSource: '',
  });
  assert.equal(JSON.stringify(note).includes('合成完整正文'), false);
  const full = normalizeNote(detail, '42', { detail: true });
  assert.equal(full.body, detail.content.source);
  assert.equal(full.rawSource, detail.content.source);
  assert.equal(full.html, detail.content.html);
  assert.equal(full.bodyFormat, 'lake');
  assert.equal(full.fullContentAvailable, true);
  assert.equal(full.documentKey, note.documentKey);
});

test('缺失正文不会把摘要误当全文；空正文和未知格式显式可辨', () => {
  const missing = normalizeNote(rawNote(1), '42', { detail: true });
  assert.equal(missing.body, '');
  assert.equal(missing.fullContentAvailable, false);
  const empty = normalizeNote({ id: 1, content: { source: '', format: 'markdown' } }, '42', { detail: true });
  assert.equal(empty.fullContentAvailable, true);
  const html = normalizeNote({ id: 1, content: { html: '<p>内容</p>' } }, '42', { detail: true });
  assert.equal(html.html, '<p>内容</p>');
  assert.equal(html.fullContentAvailable, true);
  assert.equal(normalizeNote({ id: 1, content: { source: '原样', format: 'future' } }, '42', { detail: true }).bodyFormat, 'future');
});

test('账号和数字ID强校验，不隐式接受对象、空值或不安全整数', () => {
  for (const bad of [undefined, null, '', ' ', '0', 0, -1, 1.2, {}, [], '42:1', ' 42', '042', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeNote(rawNote(1), bad), /accountScope/);
    assert.throws(() => normalizeNote({ id: bad }, '42'), /noteId/);
  }
  assert.equal(normalizeNote({ id: '9007199254740993' }, '42').noteId, '9007199254740993');
  assert.throws(() => normalizeNote(null, '42'), /小记/);
  assert.throws(() => normalizeNote({ id: 1, user_id: 43 }, '42', { detail: true }), /账号/);
  assert.throws(() => normalizeNote({ id: 1, user_id: {} }, '42', { detail: true }), /user_id/);
});

test('标签仅接受字符串和显式name，不把任意对象串化', () => {
  for (const tags of [null, undefined, {}, '标签', 5]) {
    assert.deepEqual(normalizeNote({ id: 1, tags }, '42').tags, []);
  }
  assert.deepEqual(normalizeNote({ id: 1, tags: [{ name: 'A' }, { name: { nested: true } }, ['B'], false, ' A ', 'B'] }, '42').tags, ['A', 'B']);
});

test('详情只用注入client访问已验证show根对象，并拒绝身份不匹配', async () => {
  const urls = [];
  const result = await fetchNoteDetail({ async getJson(url) { urls.push(url); return detail; } }, '501', '42');
  assert.deepEqual(urls, ['https://www.yuque.com/api/modules/note/notes/NoteController/show?id=501']);
  assert.equal(result.body, detail.content.source);
  for (const payload of [{ ...detail, id: 502 }, { ...detail, user_id: 43 }, { data: detail }]) {
    await assert.rejects(fetchNoteDetail({ async getJson() { return payload; } }, '501', '42'), /身份|账号|noteId/);
  }
  let calls = 0;
  await assert.rejects(fetchNoteDetail({ async getJson() { calls += 1; } }, 'not-number', '42'), /noteId/);
  await assert.rejects(fetchNoteDetail({ async getJson() { calls += 1; } }, '501', ''), /accountScope/);
  assert.equal(calls, 0);
});

test('全分页严格按普通notes.length前进，合并重复置顶且不输出正文', async () => {
  const client = pagedClient(new Map([
    [0, page([detail, rawNote(2)], true, [rawNote(9), detail])],
    [2, page([rawNote(3)], false, [rawNote(9)])],
  ]));
  const progress = [];
  const result = await fetchAllNotes(client, { accountScope: '42', pageSize: 2, onProgress: (value) => progress.push(value) });
  assert.deepEqual(client.requests.map((url) => [url.pathname, url.search]), [
    ['/api/modules/note/notes/NoteController/index', '?limit=2&offset=0'],
    ['/api/modules/note/notes/NoteController/index', '?limit=2&offset=2'],
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.accountScope, '42');
  assert.equal(result.pageCount, 2);
  assert.equal(result.totalItems, 4);
  assert.deepEqual(result.notes.map((note) => note.noteId), ['9', '501', '2', '3']);
  assert.equal(JSON.stringify(result).includes('合成完整正文'), false);
  assert.deepEqual(progress.map(({ completedItems, totalItems, pageCount }) => ({ completedItems, totalItems, pageCount })), [
    { completedItems: 3, totalItems: null, pageCount: 1 },
    { completedItems: 4, totalItems: 4, pageCount: 2 },
  ]);
  assert.equal(JSON.stringify(progress).includes('摘要'), false);
});

test('173条18页与空账号列表均可完整结束，不臆测服务端total', async () => {
  const pages = new Map();
  for (let offset = 0; offset < 173; offset += 10) {
    pages.set(offset, page(Array.from({ length: Math.min(10, 173 - offset) }, (_, i) => rawNote(offset + i + 1)), offset + 10 < 173));
  }
  const result = await fetchAllNotes(pagedClient(pages), { accountScope: '42', pageSize: 10 });
  assert.equal(result.notes.length, 173);
  assert.equal(result.pageCount, 18);
  const empty = await fetchAllNotes(pagedClient(new Map([[0, page([])]])), { accountScope: '42' });
  assert.equal(empty.complete, true);
  assert.equal(empty.totalItems, 0);
  assert.equal(empty.pageCount, 1);
});

test('拒绝坏契约、重复页及普通分页不前进，不返回伪完整数据', async () => {
  for (const payload of [null, { data: page([]) }, { notes: [], has_more: false }, { notes: [], pin_notes: [], has_more: 'false' }, page([], true, [rawNote(1)])]) {
    await assert.rejects(fetchAllNotes({ async getJson() { return payload; } }, { accountScope: '42' }), /契约|前进/);
  }
  const repeated = pagedClient(new Map([[0, page([rawNote(1)], true)], [1, page([rawNote(1)], true, [rawNote(2)])]]));
  await assert.rejects(fetchAllNotes(repeated, { accountScope: '42' }), /重复|前进/);
  assert.equal(repeated.requests.length, 2);
  const duplicateFinal = pagedClient(new Map([[0, page([rawNote(1)], true)], [1, page([rawNote(1)], false)]]));
  await assert.rejects(fetchAllNotes(duplicateFinal, { accountScope: '42' }), /重复|前进/);
});

test('请求前、请求中和最后一页回调取消都丢弃partial', async () => {
  let stop = true;
  let calls = 0;
  const control = { getAction: () => stop ? 'stop' : 'run' };
  const before = await fetchAllNotes({ async getJson() { calls += 1; } }, { accountScope: '42', control });
  assert.equal(calls, 0);
  assert.deepEqual(before.notes, []);
  assert.equal(before.complete, false);
  assert.equal(before.cancelled, true);
  stop = false;
  const during = await fetchAllNotes({ async getJson() { stop = true; return page([detail]); } }, { accountScope: '42', control });
  assert.deepEqual(during.notes, []);
  assert.equal(during.cancelled, true);
  stop = false;
  const last = await fetchAllNotes(pagedClient(new Map([[0, page([detail])]])), { accountScope: '42', control, onProgress() { stop = true; } });
  assert.deepEqual(last.notes, []);
  assert.equal(last.totalItems, 0);
  assert.equal(last.cancelled, true);
});

test('页间和429等待期间取消均不提交已有页', async () => {
  let stop = false;
  const control = { getAction: () => stop ? 'stop' : 'run' };
  const client = pagedClient(new Map([[0, page([rawNote(1)], true)]]));
  const result = await fetchAllNotes(client, { accountScope: '42', control, onProgress() { stop = true; } });
  assert.deepEqual(result.notes, []);
  assert.equal(result.cancelled, true);
  assert.equal(client.requests.length, 1);
  stop = false;
  let calls = 0;
  const timer = setTimeout(() => { stop = true; }, 20);
  try {
    const limited = await fetchAllNotes({ async getJson() { calls += 1; throw statusError(429); } }, { accountScope: '42', control });
    assert.equal(limited.cancelled, true);
    assert.deepEqual(limited.notes, []);
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test('429有限退避重试，401/403以及网络失败立即停止且不泄露响应', async () => {
  let calls = 0;
  const recovered = await fetchAllNotes({ async getJson() { calls += 1; if (calls < 3) throw statusError(429); return page([]); } }, { accountScope: '42' });
  assert.equal(calls, 3);
  assert.equal(recovered.complete, true);
  calls = 0;
  await assert.rejects(fetchNoteDetail({ async getJson() { calls += 1; throw statusError(429); } }, '501', '42'), (error) => error.status === 429 && !('response' in error));
  assert.equal(calls, 3);
  for (const status of [401, 403, 500, null]) {
    calls = 0;
    await assert.rejects(fetchAllNotes({ async getJson() { calls += 1; const error = statusError(status); error.message = 'Cookie=不应泄露'; throw error; } }, { accountScope: '42' }), (error) => !JSON.stringify(error).includes('不应泄露') && !error.message.includes('Cookie='));
    assert.equal(calls, 1);
  }
});

test('429遵循Retry-After秒数和HTTP日期，超安全等待上限直接停止', async () => {
  let calls = 0;
  const start = Date.now();
  await fetchAllNotes({ async getJson() {
    calls += 1;
    if (calls === 1) {
      const error = statusError(429);
      error.response.headers = { 'retry-after': '1' };
      throw error;
    }
    return page([]);
  } }, { accountScope: '42' });
  assert.equal(calls, 2);
  assert.ok(Date.now() - start >= 950, '不得早于服务端要求的1秒重试');
  calls = 0;
  await fetchNoteDetail({ async getJson() {
    calls += 1;
    if (calls === 1) {
      const error = statusError(429);
      error.response.headers = { 'retry-after': new Date(Date.now() - 1000).toUTCString() };
      throw error;
    }
    return detail;
  } }, '501', '42');
  assert.equal(calls, 2);
  for (const retryAfter of ['60', new Date(Date.now() + 60000).toUTCString()]) {
    calls = 0;
    await assert.rejects(fetchAllNotes({ async getJson() {
      calls += 1;
      const error = statusError(429);
      error.response.headers = { 'retry-after': retryAfter };
      throw error;
    } }, { accountScope: '42' }), (error) => error.code === 'NOTE_RATE_LIMITED' && error.status === 429);
    assert.equal(calls, 1, '过长等待不得截短后提前重试');
  }
});

test('终页只有置顶仍可完整返回，普通页部分重叠只按原始长度偏移', async () => {
  const pinnedOnly = await fetchAllNotes(pagedClient(new Map([[0, page([], false, [rawNote(7), rawNote(7)])]])), { accountScope: '42' });
  assert.equal(pinnedOnly.totalItems, 1);
  assert.equal(pinnedOnly.notes[0].noteId, '7');
  const client = pagedClient(new Map([
    [0, page([rawNote(1), rawNote(2)], true)],
    [2, page([rawNote(2), rawNote(3)], true)],
    [4, page([rawNote(4)])],
  ]));
  const result = await fetchAllNotes(client, { accountScope: '42', pageSize: 2 });
  assert.deepEqual(client.requests.map((url) => url.searchParams.get('offset')), ['0', '2', '4']);
  assert.deepEqual(result.notes.map((note) => note.noteId), ['1', '2', '3', '4']);
});

test('已有成功页之后的鉴权错误仍停止，坏身份不能混入当前账号', async () => {
  let calls = 0;
  await assert.rejects(fetchAllNotes({ async getJson() {
    calls += 1;
    if (calls === 1) return page([rawNote(1)], true);
    throw statusError(401);
  } }, { accountScope: '42' }), (error) => error.code === 'NOTE_AUTH_FAILED' && error.status === 401);
  assert.equal(calls, 2);
  for (const invalid of [{ id: 'bad' }, { id: 1, user_id: 43 }]) {
    await assert.rejects(fetchAllNotes(pagedClient(new Map([[0, page([invalid])]])), { accountScope: '42' }), /noteId|账号/);
  }
});

test('支持现有control包裹AbortSignal，取消不会发起请求', async () => {
  const aborter = new AbortController();
  aborter.abort();
  const result = await fetchAllNotes({ async getJson() { assert.fail('取消后不应请求'); } }, { accountScope: '42', control: { signal: aborter.signal } });
  assert.deepEqual(result.notes, []);
  assert.equal(result.cancelled, true);
});

test('默认只请求实际验证过的limit=10，不把未验证的100当成可用上限', async () => {
  const client = pagedClient(new Map([[0, page([])]]));
  await fetchAllNotes(client, { accountScope: '42' });
  assert.equal(client.requests[0].search, '?limit=10&offset=0');
});

test('非法pageSize和client在请求前失败', async () => {
  for (const pageSize of [0, -1, 11, 100, 101, 1.5, '10', NaN]) {
    await assert.rejects(fetchAllNotes({ async getJson() { assert.fail('不应请求'); } }, { accountScope: '42', pageSize }), /pageSize/);
  }
  await assert.rejects(fetchAllNotes({}, { accountScope: '42' }), /client/);
});
