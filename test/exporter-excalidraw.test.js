import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyArtifacts,
  mergeMarkdownWithArtifacts,
  prepareStructuredBoards,
  refreshBoardManifestAfterPngCapture,
} from '../src/exporter.js';
import { readExcalidrawScene, validateExcalidrawScene } from '../src/excalidraw.js';

function createComplexFlowchart(revision = '') {
  const body = [];
  for (let index = 0; index < 21; index += 1) {
    body.push({
      id: `node-${index + 1}`,
      type: 'geometry',
      shape: index === 0 ? 'start-end' : 'process',
      html: `步骤 ${index + 1}${index === 20 ? revision : ''}`,
      x: index * 180,
      y: index % 3 === 0 ? 0 : 120,
      width: 120,
      height: 44,
    });
    if (index > 0) {
      body.push({
        id: `line-${index}`,
        type: 'line',
        shape: 'elbow',
        source: { id: `node-${index}`, connection: 'E' },
        target: { id: `node-${index + 1}`, connection: 'W', marker: 'arrow' },
      });
    }
  }
  return { body };
}

function createContext(root, diagramData, sourceType = 'board-document') {
  const bookDir = path.join(root, 'Book');
  const boardDir = path.join(bookDir, '_assets', 'boards');
  fs.mkdirSync(boardDir, { recursive: true });
  const targetMdPath = path.join(bookDir, '复杂流程图.md');
  const detail = sourceType === 'board-document'
    ? { type: 'Board', title: '复杂流程图', content: JSON.stringify({ diagramData }) }
    : {
        type: 'Doc',
        content: `<card type="block" name="board" value="data:${encodeURIComponent(JSON.stringify({ diagramData }))}" />`,
      };
  return {
    detail,
    docPlan: { targetMdPath, node: { name: '复杂流程图' } },
    bookPlan: { bookDir, assets: { boards: boardDir } },
  };
}

function editableOptions() {
  return {
    diagramExportMode: 'obsidian-editable',
    diagramSnapshotMode: 'fallback-only',
    diagramCapabilities: { excalidraw: true, obsidianCli: false },
  };
}

test('复杂独立画板生成 Excalidraw 主文件，并对同源、更新和人工修改分别处理', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-excalidraw-export-'));
  const initial = createContext(root, createComplexFlowchart());
  const [created] = prepareStructuredBoards(initial.detail, initial.docPlan, initial.bookPlan, editableOptions());

  assert.equal(created.primaryFormat, 'excalidraw');
  assert.equal(created.structuredFormat, 'excalidraw-flowchart');
  assert.equal(created.excalidrawStatus, 'created');
  assert.equal(fs.existsSync(created.excalidrawPath), true);
  assert.equal(created.excalidrawPath, initial.docPlan.targetMdPath.replace(/\.md$/i, '.excalidraw.md'));
  assert.equal(
    validateExcalidrawScene(readExcalidrawScene(created.excalidrawPath, { fromFile: true }), { nodeCount: 21, edgeCount: 20 }).valid,
    true,
  );

  const initialManifest = JSON.parse(fs.readFileSync(created.files.manifestPath, 'utf8'));
  assert.deepEqual(initialManifest.generatedFiles.sort(), [created.files.jsonPath, created.excalidrawPath].sort());

  const [unchanged] = prepareStructuredBoards(initial.detail, initial.docPlan, initial.bookPlan, editableOptions());
  assert.equal(unchanged.excalidrawStatus, 'unchanged');
  assert.equal(fs.existsSync(path.join(created.files.dir, 'history')), false);

  const updated = createContext(root, createComplexFlowchart('（更新）'));
  const [replaced] = prepareStructuredBoards(updated.detail, updated.docPlan, updated.bookPlan, editableOptions());
  assert.equal(replaced.excalidrawStatus, 'updated');
  assert.equal(fs.readdirSync(path.join(replaced.files.dir, 'history')).length, 1);
  assert.match(fs.readFileSync(replaced.excalidrawPath, 'utf8'), /更新/);

  fs.appendFileSync(replaced.excalidrawPath, '\n用户手工注释\n', 'utf8');
  const conflicted = createContext(root, createComplexFlowchart('（再次更新）'));
  const [copy] = prepareStructuredBoards(conflicted.detail, conflicted.docPlan, conflicted.bookPlan, editableOptions());
  assert.equal(copy.excalidrawStatus, 'conflict-copy');
  assert.match(path.basename(copy.excalidrawPath), /\.yuque-update\.excalidraw\.md$/);
  assert.match(fs.readFileSync(replaced.excalidrawPath, 'utf8'), /用户手工注释/);
});

test('嵌入式复杂流程图在正文位置提供 Excalidraw 编辑入口', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-embedded-excalidraw-'));
  const context = createContext(root, createComplexFlowchart(), 'embedded-card');
  const [board] = prepareStructuredBoards(context.detail, context.docPlan, context.bookPlan, editableOptions());
  const output = mergeMarkdownWithArtifacts(
    '# 正文\n\n[此处为语雀卡片，点击链接查看](https://www.yuque.com/docs/123#board)',
    {
      ...emptyArtifacts(),
      artifactKinds: ['board'],
      cardSlots: [{ kind: 'board', url: 'https://www.yuque.com/docs/123#board' }],
      boards: [board],
    },
    context.docPlan.targetMdPath,
  );

  assert.equal(board.sourceType, 'embedded-card');
  assert.match(output, /打开可编辑流程图/);
  assert.match(output, /\.excalidraw\.md/);
});

test('PNG 截图完成后会补充写入既有画板清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-board-manifest-'));
  const context = createContext(root, createComplexFlowchart());
  const [board] = prepareStructuredBoards(context.detail, context.docPlan, context.bookPlan, editableOptions());
  fs.writeFileSync(board.files.pngPath, 'png-fixture');
  board.pngCaptured = true;

  const manifest = refreshBoardManifestAfterPngCapture(board);
  assert.ok(manifest.generatedFiles.includes(board.files.pngPath));
  assert.deepEqual(manifest.png, { requested: true, captured: true, stale: false, error: '' });
});
