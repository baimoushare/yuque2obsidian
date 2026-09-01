import fs from 'fs';
import os from 'os';
import path from 'path';
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

test('ExportControl reads action from control file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-control-'));
  const controlPath = path.join(tempDir, 'control.json');
  fs.writeFileSync(controlPath, JSON.stringify({ action: 'pause' }), 'utf8');

  const control = new ExportControl(controlPath);
  assert.equal(control.getAction(), 'pause');
});
