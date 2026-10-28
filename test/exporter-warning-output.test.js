import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaceholderMarkdown, emptyArtifacts } from '../src/exporter.js';

const CARD_PLACEHOLDER =
  '[\u6b64\u5904\u4e3a\u8bed\u96c0\u5361\u7247\uff0c\u70b9\u51fb\u94fe\u63a5\u67e5\u770b](https://www.yuque.com/docs/262416420#scf1R)';

test('buildPlaceholderMarkdown keeps body content without appending a warning footer', () => {
  const markdown = ['# Demo', '', 'body start', '', CARD_PLACEHOLDER, '', 'body end'].join('\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-warning-body-'));
  const targetMdPath = path.join(root, 'Demo.md');

  try {
    const output = buildPlaceholderMarkdown(
      {
        node: { name: 'Demo' },
        targetMdPath,
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
      },
      {
        phase: 'capture-artifacts',
        error_type: 'Error',
        error_message: 'Timed out while capturing complex blocks for Demo.',
      },
      {
        ...emptyArtifacts(),
        artifactKinds: ['board'],
        cardSlots: [
          {
            index: 0,
            kind: 'board',
            boardIndex: 0,
            resolved: true,
            label: '\u6b64\u5904\u4e3a\u8bed\u96c0\u5361\u7247\uff0c\u70b9\u51fb\u94fe\u63a5\u67e5\u770b',
            url: 'https://www.yuque.com/docs/262416420#scf1R',
          },
        ],
        boards: [
          {
            sourceType: 'embedded-card',
            detectedKind: 'flowchart',
            structuredExport: true,
            mermaid: 'flowchart TD\n  A["Start"] --> B["End"]',
            markdown: '',
            title: 'Board 1',
            files: {},
          },
        ],
      },
      {
        baseMarkdown: markdown,
        warningEntries: [
          {
            localizedPhase: '\u63d0\u53d6\u590d\u6742\u5757',
            localizedErrorMessage: '\u590d\u6742\u5757\u6355\u83b7\u8d85\u65f6',
          },
        ],
      },
    );

    assert.match(output, /body start/);
    assert.match(output, /```mermaid/);
    assert.match(output, /body end/);
    assert.doesNotMatch(output, /## \u5bfc\u51fa\u8b66\u544a/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildPlaceholderMarkdown failure shell does not append a warning footer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-warning-shell-'));
  const targetMdPath = path.join(root, 'Demo.md');

  try {
    const output = buildPlaceholderMarkdown(
      {
        node: { name: 'Demo' },
        targetMdPath,
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
      },
      {
        phase: 'capture-artifacts',
        error_type: 'Error',
        error_message: 'Timed out while capturing complex blocks for Demo.',
      },
      emptyArtifacts(),
      {
        warningEntries: [
          {
            localizedPhase: '\u63d0\u53d6\u590d\u6742\u5757',
            localizedErrorMessage: '\u590d\u6742\u5757\u6355\u83b7\u8d85\u65f6',
          },
        ],
      },
    );

    assert.match(output, /\u6b64\u6587\u6863\u672a\u80fd\u76f4\u63a5\u5bfc\u51fa\u4e3a\u6807\u51c6 Markdown/);
    assert.doesNotMatch(output, /## \u5bfc\u51fa\u8b66\u544a/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
