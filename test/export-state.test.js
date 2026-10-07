import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportControl, ExportStateStore } from '../src/export-state.js';

test('ExportStateStore skips already exported documents with existing files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-state-'));
  const targetMdPath = path.join(tempDir, 'Book', 'Note.md');
  fs.mkdirSync(path.dirname(targetMdPath), { recursive: true });
  fs.writeFileSync(targetMdPath, '# demo\n', 'utf8');

  const store = new ExportStateStore(tempDir);
  const docPlan = {
    absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
    targetMdPath,
    sourceVersion: 'v1',
    book: { id: 1, name: 'Book' },
    node: { name: 'Note' },
  };

  store.markExported(docPlan);

  const reloaded = new ExportStateStore(tempDir);
  assert.equal(reloaded.shouldSkip(docPlan), true);
});

test('ExportStateStore does not skip when source version or target path changes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-state-version-'));
  const oldPath = path.join(tempDir, 'old.md');
  const newPath = path.join(tempDir, 'new.md');
  fs.writeFileSync(oldPath, '# old\n', 'utf8');
  const store = new ExportStateStore(tempDir);
  const base = {
    absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
    targetMdPath: oldPath,
    sourceVersion: 'v1',
    book: { id: 1, name: 'Book' },
    node: { name: 'Note' },
  };
  store.markExported(base);
  const reloaded = new ExportStateStore(tempDir);
  assert.equal(reloaded.shouldSkip({ ...base, sourceVersion: 'v2' }), false);
  assert.equal(reloaded.shouldSkip({ ...base, targetMdPath: newPath }), false);
});

test('ExportStateStore keys source documents by stable documentKey and keeps source relations', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-state-source-'));
  const targetMdPath = path.join(tempDir, 'Documents', 'doc.md');
  fs.mkdirSync(path.dirname(targetMdPath), { recursive: true });
  fs.writeFileSync(targetMdPath, '# demo\n', 'utf8');

  const store = new ExportStateStore(tempDir);
  const docPlan = {
    documentKey: 'yuque:book-1:doc-1',
    absoluteDocUrl: 'https://www.yuque.com/owner/book/doc-1',
    sourceRelations: [
      { sourceType: 'favorite', actionOption: 'doc' },
      { sourceType: 'collaboration', actionOption: 'collaboration_Doc_doc' },
    ],
    bookId: 'book-1',
    bookName: 'Book',
    title: 'Note',
    targetMdPath,
    sourceVersion: 'v1',
  };

  store.markExported(docPlan);
  const reloaded = new ExportStateStore(tempDir);
  assert.equal(reloaded.shouldSkip(docPlan), true);
  assert.equal(reloaded.getRecord(docPlan.documentKey).yuquePath, docPlan.absoluteDocUrl);
  assert.deepEqual(reloaded.getRecord(docPlan.documentKey).sourceRelations, docPlan.sourceRelations);

  const updatedPlan = {
    ...docPlan,
    sourceRelations: [{ sourceType: 'favorite', actionOption: 'doc' }],
  };
  reloaded.markExported(updatedPlan);
  assert.deepEqual(
    reloaded.getRecord(docPlan.documentKey).sourceRelations,
    updatedPlan.sourceRelations,
  );
});

test('ExportStateStore migrates a legacy URL record on write without deleting the old key', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-state-migrate-'));
  const targetMdPath = path.join(tempDir, 'Documents', 'note.md');
  fs.mkdirSync(path.dirname(targetMdPath), { recursive: true });
  fs.writeFileSync(targetMdPath, '# note\n', 'utf8');
  const absoluteDocUrl = 'https://www.yuque.com/owner/book/doc-a';
  const legacyRecord = {
    status: 'exported',
    sourceVersion: 'legacy-v1',
    targetMdPath,
    outputPath: targetMdPath,
    outputHash: crypto.createHash('sha256').update(fs.readFileSync(targetMdPath)).digest('hex'),
    yuquePath: absoluteDocUrl,
    bookId: 17,
    bookName: 'Book',
    docName: 'Note',
  };
  fs.writeFileSync(path.join(tempDir, '.yuque-export-state.json'), JSON.stringify({
    version: 1,
    meta: { createdAt: '2026-01-01T00:00:00.000Z' },
    documents: { [absoluteDocUrl]: legacyRecord },
  }), 'utf8');

  const plan = {
    documentKey: 'yuque:book-17:doc-a',
    absoluteDocUrl,
    targetMdPath,
    sourceVersion: 'legacy-v1',
    bookId: 17,
    bookName: 'Book',
    title: 'Renamed note',
    sourceRelations: [{ sourceType: 'favorite' }],
  };
  const store = new ExportStateStore(tempDir);

  assert.equal(store.state.version, 2);
  assert.equal(store.shouldSkip(plan), true);
  store.markQueued(plan);

  const persisted = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.documents[absoluteDocUrl], legacyRecord);
  const migratedRecord = persisted.documents[plan.documentKey];
  const { updatedAt, ...migratedFields } = migratedRecord;
  assert.ok(updatedAt);
  assert.deepEqual(migratedFields, {
    ...legacyRecord,
    documentKey: plan.documentKey,
    sourceRelations: plan.sourceRelations,
    status: 'queued',
  });
});

test('ExportStateStore refuses to downgrade a state file from a newer version', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-state-future-'));
  const statePath = path.join(tempDir, '.yuque-export-state.json');
  const futureState = JSON.stringify({
    version: 3,
    meta: {},
    documents: {},
  });
  fs.writeFileSync(statePath, futureState, 'utf8');

  assert.throws(
    () => new ExportStateStore(tempDir),
    /高于当前软件支持的版本/,
  );
  assert.equal(fs.readFileSync(statePath, 'utf8'), futureState);
});

test('ExportStateStore clears source relations only after a complete scan', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-state-relations-'));
  const targetMdPath = path.join(tempDir, 'document.md');
  fs.writeFileSync(targetMdPath, '# demo\n', 'utf8');
  const store = new ExportStateStore(tempDir);
  const docPlan = {
    documentKey: 'yuque:book-1:doc-1',
    absoluteDocUrl: 'https://www.yuque.com/owner/book/doc-1',
    targetMdPath,
    sourceRelations: [{ sourceType: 'favorite', actionOption: 'doc' }],
  };
  store.markExported(docPlan);

  assert.equal(store.syncDocumentSourceRelations([], { complete: false }), false);
  assert.deepEqual(store.getRecord(docPlan.documentKey).sourceRelations, docPlan.sourceRelations);
  assert.equal(store.syncDocumentSourceRelations([], { complete: true }), true);
  assert.deepEqual(store.getRecord(docPlan.documentKey).sourceRelations, []);
});

test('ExportControl reads action from control file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-control-'));
  const controlPath = path.join(tempDir, 'control.json');
  fs.writeFileSync(controlPath, JSON.stringify({ action: 'pause' }), 'utf8');

  const control = new ExportControl(controlPath);
  assert.equal(control.getAction(), 'pause');
});
