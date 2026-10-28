import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertReadOnlyCredential, probeNotes, summarizeNote } from '../tools/probe-notes.js';

const note = (id) => ({ id, title: 'PRIVATE_TITLE', created_at: '2026-10-23T00:00:00Z', content: { source: 'PRIVATE_BODY', html: '<p>PRIVATE_BODY</p>', abstract: 'PRIVATE_ABSTRACT', format: 'lake' } });
function clientFor(pages, details = {}) {
  let index = 0;
  return { async getJson(url) {
    if (url.endsWith('/api/mine')) return { data: { id: 'PRIVATE_USER' } };
    if (url.includes('/index?')) return pages[index++];
    return details[new URL(url).searchParams.get('id')];
  } };
}
test('notes probe summarizes fields without printing personal contents', async () => {
  const result = await probeNotes(clientFor([{ notes: [note(1)], pin_notes: [], has_more: false }], { 1: note(1) }));
  assert.equal(result.complete, true);
  assert.equal(result.details[0].sourceLength, 12);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
test('notes probe handles root response and overlapping pinned notes across pages', async () => {
  const result = await probeNotes(clientFor([
    { notes: [note(1)], pin_notes: [note(2)], has_more: true },
    { notes: [note(3)], pin_notes: [note(2)], has_more: false },
  ], { 1: note(1), 2: note(2), 3: note(3) }), { allPages: true });
  assert.equal(result.distinctNotes, 3);
  assert.equal(result.pages.length, 2);
});
test('notes probe refuses unexpected response rather than returning empty success', async () => {
  await assert.rejects(probeNotes(clientFor([{ data: { notes: [] } }])), /契约/);
});
test('notes probe rejects non-progressing pagination', async () => {
  await assert.rejects(probeNotes(clientFor([
    { notes: [note(1)], pin_notes: [], has_more: true },
    { notes: [note(1)], pin_notes: [], has_more: true },
  ]), { allPages: true }), /未前进/);
});
test('notes probe rejects mismatched detail identity', async () => {
  await assert.rejects(probeNotes(clientFor([{ notes: [note(1)], pin_notes: [], has_more: false }], { 1: note(9) })), /身份/);
});
test('notes probe bounds detail sampling and preserves format uncertainty', async () => {
  await assert.rejects(probeNotes({}, { detailLimit: 4 }), /最多/);
  assert.equal(summarizeNote({ content: {} }).format, 'other-or-missing');
});
test('notes probe never migrates legacy credentials on Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-probe-'));
  const file = path.join(dir, 'cookies.json');
  fs.writeFileSync(file, '[]');
  try {
    assert.throws(() => assertReadOnlyCredential(file, 'win32'), /旧凭据/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[]');
    fs.writeFileSync(file, JSON.stringify({ format: 'yuque-exporter-dpapi-v1', protectedData: 'TEST_ONLY' }));
    assert.doesNotThrow(() => assertReadOnlyCredential(file, 'win32'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
