import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportNotes, scanNotes } from '../src/note-exporter.js';
const note = (id = '3') => ({ accountScope: '1', noteId: id, documentKey: `yuque-note:1:${id}`, summary: '测试', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', bodyFormat: 'markdown', body: '正文', html: '', fullContentAvailable: true, tags: [], canonicalUrl: '', rawSource: '' });
const client = { getJson: async () => ({ data: { id: 1 } }) };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'note-export-'));
const config = (dir) => ({ outputDir: dir, cookiePath: '', selectedNoteKeys: ['yuque-note:1:3'], noteAccountScope: '1', downloadImages: true, downloadAttachments: true });
const opts = (value = note()) => ({ client, fetchNoteDetail: async () => value });
test('multi-tag note keeps one body under first tag and links from other tag folders', async () => {
  const dir = temp();
  const tagged = { ...note(), tags: ['工作', '计划'] };
  try {
    const first = await exportNotes(config(dir), () => {}, opts(tagged));
    assert.equal(first.totals.exported, 1);
    const bodyPath = first.notes[0].path;
    assert.equal(path.relative(dir, bodyPath).split(path.sep)[1], '工作');
    const indexDir = path.join(dir, '小记', '计划', '2026', '10');
    const indexes = fs.readdirSync(indexDir).filter((name) => name.endsWith('__索引.md'));
    assert.equal(indexes.length, 1);
    const indexText = fs.readFileSync(path.join(indexDir, indexes[0]), 'utf8');
    assert.match(indexText, /type: note-index/);
    assert.match(indexText, /打开小记正文/);
    const second = await exportNotes(config(dir), () => {}, opts(tagged));
    assert.equal(second.totals.skipped, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('locally edited generated index is protected and reported incomplete', async () => {
  const dir = temp();
  const tagged = { ...note(), tags: ['工作', '计划'] };
  try {
    await exportNotes(config(dir), () => {}, opts(tagged));
    const indexDir = path.join(dir, '小记', '计划', '2026', '10');
    const indexFile = path.join(indexDir, fs.readdirSync(indexDir).find((name) => name.endsWith('__索引.md')));
    fs.appendFileSync(indexFile, '\n本地索引改动');
    const result = await exportNotes(config(dir), () => {}, opts({ ...tagged, body: '远端更新' }));
    assert.equal(result.status, 'partial');
    assert.equal(result.totals.incomplete, 1);
    assert.match(fs.readFileSync(indexFile, 'utf8'), /本地索引改动/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('notes exports and skips unchanged full output', async () => {
  const dir = temp();
  try {
    const first = await exportNotes(config(dir), () => {}, opts());
    assert.equal(first.totals.exported, 1);
    assert.match(fs.readFileSync(first.notes[0].path, 'utf8'), /正文/);
    const second = await exportNotes(config(dir), () => {}, opts());
    assert.equal(second.totals.skipped, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('notes protects local edits without overwriting', async () => {
  const dir = temp();
  try {
    const first = await exportNotes(config(dir), () => {}, opts());
    fs.appendFileSync(first.notes[0].path, '\n本地编辑');
    const second = await exportNotes(config(dir), () => {}, opts({ ...note(), body: '远端更新' }));
    assert.equal(second.totals.protected, 1);
    assert.match(fs.readFileSync(first.notes[0].path, 'utf8'), /本地编辑/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('notes resource failure is incomplete and explicit retry repairs it', async () => {
  const dir = temp();
  const image = { ...note(), body: '![图片](https://example.com/image.png)' };
  try {
    const first = await exportNotes(config(dir), () => {}, { ...opts(image), downloadBinaryAsset: async () => { throw new Error('secret'); } });
    assert.equal(first.totals.incomplete, 1);
    assert.ok(first.failureCsvPath);
    const second = await exportNotes(config(dir), () => {}, { ...opts(image), downloadBinaryAsset: async () => ({ response: { data: Buffer.from('fake image'), headers: { 'content-type': 'image/png' } } }) });
    assert.equal(second.totals.exported, 1);
    assert.match(fs.readFileSync(second.notes[0].path, 'utf8'), /_assets/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('notes refuses junction output instead of writing outside root', async () => {
  const dir = temp(); const outside = temp();
  try {
    fs.symlinkSync(outside, path.join(dir, '小记'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await exportNotes(config(dir), () => {}, opts());
    assert.equal(result.totals.failed, 1);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('notes rejects empty or cross-account selection', async () => {
  await assert.rejects(exportNotes({ selectedNoteKeys: [] }), /选择/);
  await assert.rejects(exportNotes({ ...config('unused'), noteAccountScope: '2' }, () => {}, opts()), /账号/);
});
test('notes pause happens at item boundary and reports no fake success', async () => {
  const dir = temp();
  try {
    const result = await exportNotes(config(dir), () => {}, { ...opts(), control: { getAction: () => 'pause', clear() {} } });
    assert.equal(result.status, 'paused');
    assert.equal(result.notes.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('notes authentication failure stops remaining selections without leaking requests', async () => {
  const dir = temp(); let calls = 0;
  try {
    const result = await exportNotes({ ...config(dir), selectedNoteKeys: ['yuque-note:1:3', 'yuque-note:1:4'] }, () => {}, { client, fetchNoteDetail: async () => { calls++; throw Object.assign(new Error('PRIVATE_COOKIE'), { status: 401 }); } });
    assert.equal(calls, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.notes.length, 2);
    assert.equal(result.notes[1].category, 'not-attempted');
    assert.match(fs.readFileSync(result.failureCsvPath, 'utf8'), /yuque-note:1:4/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COOKIE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
