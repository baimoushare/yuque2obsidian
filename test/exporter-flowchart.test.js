import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyArtifacts, mergeMarkdownWithArtifacts, prepareStructuredBoards } from '../src/exporter.js';

function createFlowchartDiagram({ partial = false } = {}) {
  const body = [
    {
      id: 'start',
      type: 'geometry',
      shape: 'roundRect',
      html: '\u5f00\u59cb',
    },
    {
      id: 'decision',
      type: 'geometry',
      shape: 'diamond',
      html: '\u662f\u5426\u901a\u8fc7',
    },
    {
      id: 'done',
      type: 'geometry',
      shape: 'rect',
      html: '\u5b8c\u6210',
    },
    {
      id: 'line-1',
      type: 'line',
      source: { id: 'start' },
      target: { id: 'decision' },
    },
    {
      id: 'line-2',
      type: 'line',
      source: { id: 'decision' },
      target: { id: 'done' },
    },
  ];

  if (partial) {
    body.push(
      {
        id: 'text-1',
        type: 'text',
        html: '\u5907\u6ce8',
      },
      {
        id: 'decor-1',
        type: 'geometry',
        shape: 'rect',
        html: '<div>&nbsp;</div>',
      },
    );
  }

  return { body };
}

test('prepareStructuredBoards exports Mermaid flowcharts for embedded board cards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-embedded-flowchart-'));
  const bookDir = path.join(root, 'Book');
  const boardDir = path.join(bookDir, '_assets', 'boards');
  fs.mkdirSync(boardDir, { recursive: true });

  const boards = prepareStructuredBoards(
    {
      type: 'Doc',
      format: 'lake',
      content: `<card type="block" name="board" value="data:${encodeURIComponent(
        JSON.stringify({ diagramData: createFlowchartDiagram({ partial: true }) }),
      )}" />`,
    },
    {
      targetMdPath: path.join(bookDir, 'Embedded.md'),
      node: { name: 'Embedded' },
    },
    {
      bookDir,
      assets: {
        boards: boardDir,
      },
    },
    {
      complexBlockMode: 'structured-first',
    },
  );

  assert.equal(boards.length, 1);
  assert.equal(boards[0].sourceType, 'embedded-card');
  assert.equal(boards[0].detectedKind, 'flowchart');
  assert.equal(boards[0].structuredFormat, 'mermaid-flowchart');
  assert.equal(boards[0].structuredExport, true);
  assert.equal(boards[0].partialStructured, true);
  assert.ok(boards[0].ignoredElementCount >= 2);
  assert.match(boards[0].mermaid, /^flowchart TD/m);
  assert.equal(fs.existsSync(boards[0].files.jsonPath), true);
});

test('mergeMarkdownWithArtifacts renders inline Mermaid flowcharts at the original board slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-flowchart-markdown-'));
  const targetMdPath = path.join(root, 'Demo.md');

  const merged = mergeMarkdownWithArtifacts(
    '# Demo\n\nbefore\n\n[此处为语雀卡片，点击链接查看](https://www.yuque.com/docs/123#board)\n\nafter',
    {
      ...emptyArtifacts(),
      artifactKinds: ['board'],
      cardSlots: [{ kind: 'board', url: 'https://www.yuque.com/docs/123#board' }],
      boards: [
        {
          title: '\u6d41\u7a0b\u56fe 1',
          detectedKind: 'flowchart',
          structuredFormat: 'mermaid-flowchart',
          structuredExport: true,
          markdown: '',
          mermaid: 'flowchart TD\n  n1["开始"]\n  n2{"是否通过"}\n  n1 --> n2',
          partialStructured: true,
          ignoredElementCount: 2,
          files: {
            pngPath: path.join(root, 'board-1.png'),
          },
        },
      ],
    },
    targetMdPath,
    'https://www.yuque.com/demo/book/doc-a',
  );

  assert.doesNotMatch(merged, /## \u8bed\u96c0\u753b\u677f\u7ed3\u6784/);
  assert.match(merged, /```mermaid/);
  assert.match(merged, /flowchart TD/);
  assert.match(merged, /\u8be5\u5904\u539f\u4e3a\u8bed\u96c0\u6d41\u7a0b\u56fe\u5361\u7247/);
  assert.doesNotMatch(merged, /\u539f\u59cb\u8bed\u96c0\u6570\u636e/);
  assert.doesNotMatch(merged, /PNG \u6587\u4ef6/);
});
