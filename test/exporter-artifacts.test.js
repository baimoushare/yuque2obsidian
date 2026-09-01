import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendExportWarningsSection,
  buildCaptureTargetSelectors,
  buildPlaceholderMarkdown,
  createSelectionMatcher,
  datatableToCsv,
  emptyArtifacts,
  findMissingExportedAssetReferences,
  isEffectivelyEmptyDocDetail,
  mergeMarkdownWithArtifacts,
  resolveArtifactFallback,
  writeDatatableObsidianDatasetFiles,
  writeDatatableSidecarFiles,
} from '../src/exporter.js';

const CARD_PLACEHOLDER =
  '[\u6b64\u5904\u4e3a\u8bed\u96c0\u5361\u7247\uff0c\u70b9\u51fb\u94fe\u63a5\u67e5\u770b](https://www.yuque.com/docs/262416420#scf1R)';

test('resolveArtifactFallback does not require fallback for normal documents', () => {
  const result = resolveArtifactFallback(
    {
      artifactKinds: [],
      encryptedTexts: [],
    },
    {
      detectedCount: 0,
      remainingLockedCount: 0,
    },
  );

  assert.deepEqual(result, {
    artifactKinds: [],
    requiresFallback: false,
    fallbackReason: '',
  });
});

test('isEffectivelyEmptyDocDetail treats empty normal docs as skipped but preserves structured docs', () => {
  assert.equal(
    isEffectivelyEmptyDocDetail({
      type: 'Doc',
      format: 'lake',
      content: '',
    }),
    true,
  );

  assert.equal(
    isEffectivelyEmptyDocDetail({
      type: 'Board',
      format: 'lakeboard',
      content: '',
    }),
    false,
  );

  assert.equal(
    isEffectivelyEmptyDocDetail({
      type: 'Table',
      format: 'laketable',
      content: '',
    }),
    false,
  );
});

test('mergeMarkdownWithArtifacts does not append trailing encrypted section when all blocks were reinserted', () => {
  const markdown = ['# Demo', '', CARD_PLACEHOLDER, '', 'tail'].join('\n');
  const artifacts = {
    ...emptyArtifacts(),
    encryptedTexts: ['placed text'],
    encryptedState: {
      attempted: true,
      detectedCount: 1,
      unlockedCount: 1,
      remainingLockedCount: 0,
      lockedEncryptedCount: 0,
    },
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.match(merged, /> placed text/);
  assert.doesNotMatch(merged, /## \u52a0\u5bc6\u6587\u672c\u5757\u5bfc\u51fa/);
});

test('resolveArtifactFallback keeps mindmap fallback when no structured board export exists', () => {
  const result = resolveArtifactFallback(
    {
      artifactKinds: ['board', 'mindmap'],
      encryptedTexts: [],
    },
    {
      detectedCount: 0,
      remainingLockedCount: 0,
    },
  );

  assert.equal(result.requiresFallback, true);
  assert.equal(result.fallbackReason, 'mindmap');
  assert.deepEqual(result.artifactKinds, ['board', 'mindmap']);
});

test('resolveArtifactFallback skips mindmap snapshot after structured board export succeeds', () => {
  const result = resolveArtifactFallback(
    {
      artifactKinds: ['board', 'mindmap'],
      encryptedTexts: [],
      boards: [{ structuredExport: true }],
    },
    {
      detectedCount: 0,
      remainingLockedCount: 0,
    },
    {
      structuredBoards: [{ structuredExport: true }],
    },
  );

  assert.deepEqual(result, {
    artifactKinds: ['board', 'mindmap'],
    requiresFallback: false,
    fallbackReason: '',
  });
});

test('resolveArtifactFallback skips generic datatable fallback when structured exports exist', () => {
  const result = resolveArtifactFallback(
    {
      artifactKinds: ['datatable'],
      datatables: [{ title: 'Tasks' }],
      encryptedTexts: [],
    },
    {
      detectedCount: 0,
      remainingLockedCount: 0,
    },
  );

  assert.equal(result.requiresFallback, false);
  assert.equal(result.fallbackReason, '');
  assert.deepEqual(result.artifactKinds, ['datatable']);
});

test('resolveArtifactFallback skips snapshot fallback for board-only documents', () => {
  const result = resolveArtifactFallback(
    {
      artifactKinds: ['board'],
      encryptedTexts: [],
    },
    {
      detectedCount: 0,
      remainingLockedCount: 0,
    },
  );

  assert.deepEqual(result, {
    artifactKinds: ['board'],
    requiresFallback: false,
    fallbackReason: '',
  });
});

test('mergeMarkdownWithArtifacts skips fallback section for non-fallback artifacts', () => {
  const markdown = '# Demo\n\ncontent';
  const artifacts = {
    ...emptyArtifacts(),
    blockImages: [path.join('vault', '_assets', 'blocks', 'demo.png')],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.doesNotMatch(merged, /\u8bed\u96c0\u6269\u5c55\u5185\u5bb9/);
  assert.doesNotMatch(merged, /\u590d\u6742\u5185\u5bb9\u5feb\u7167/);
});

test('mergeMarkdownWithArtifacts keeps fallback section for real complex blocks', () => {
  const markdown = '# Demo\n\ncontent';
  const artifacts = {
    ...emptyArtifacts('mindmap'),
    blockImages: [path.join('vault', '_assets', 'blocks', 'demo.png')],
    artifactKinds: ['mindmap'],
    requiresFallback: true,
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.match(merged, /\u8bed\u96c0\u6269\u5c55\u5185\u5bb9/);
  assert.match(merged, /\u590d\u6742\u5185\u5bb9\u5feb\u7167/);
  assert.match(
    merged,
    /\u5df2\u68c0\u6d4b\u5230\u771f\u5b9e\u601d\u7ef4\u5bfc\u56fe\u5185\u5bb9\uff0c\u5df2\u4fdd\u7559 PNG \u5feb\u7167\u3002/,
  );
});

test('mergeMarkdownWithArtifacts appends source link for board documents without fallback snapshot', () => {
  const markdown = '# Demo\n\n![board](_assets/images/demo-board.png)';
  const artifacts = {
    ...emptyArtifacts(),
    artifactKinds: ['board'],
  };

  const merged = mergeMarkdownWithArtifacts(
    markdown,
    artifacts,
    path.join('vault', 'Demo.md'),
    'https://www.yuque.com/demo/book/doc-a',
  );
  assert.doesNotMatch(merged, /\u8bed\u96c0\u6269\u5c55\u5185\u5bb9/);
  assert.match(merged, /## \u539f\u6587\u94fe\u63a5/);
  assert.match(merged, /\[\u67e5\u770b\u8bed\u96c0\u539f\u6587\]\(https:\/\/www\.yuque\.com\/demo\/book\/doc-a\)/);
});

test('mergeMarkdownWithArtifacts keeps embedded fallback boards inline without extra top or bottom sections', () => {
  const markdown = '# Demo\n\nbefore\n\n![画板](assets/inline-board.png)\n\nafter';
  const artifacts = {
    ...emptyArtifacts(),
    artifactKinds: ['board'],
    boards: [
      {
        sourceType: 'embedded-card',
        title: '画板 1',
        failureReason: 'no-connectable-nodes',
        structuredExport: false,
        markdown: '',
        mermaid: '',
      },
    ],
  };

  const merged = mergeMarkdownWithArtifacts(
    markdown,
    artifacts,
    path.join('vault', 'Demo.md'),
    'https://www.yuque.com/demo/book/doc-a',
  );

  assert.doesNotMatch(merged, /## 语雀画板结构/);
  assert.doesNotMatch(merged, /## 原文链接/);
  assert.match(merged, /!\[[^\]]*\]\(assets\/inline-board\.png\)/);
  assert.match(merged, /https:\/\/www\.yuque\.com\/demo\/book\/doc-a/);
});

test('mergeMarkdownWithArtifacts keeps structured boards concise and appends only the source link section', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-board-'));
  const targetMdPath = path.join(root, 'Demo.md');
  const merged = mergeMarkdownWithArtifacts(
    '# Demo\n\ncontent',
    {
      ...emptyArtifacts(),
      artifactKinds: ['board', 'mindmap'],
      boards: [
        {
          title: '思维导图 1',
          detectedKind: 'mindmap',
          structuredExport: true,
          markdown: '- Root\n  - Child',
          files: {
            pngPath: path.join(root, 'board-1.png'),
          },
        },
      ],
    },
    targetMdPath,
    'https://www.yuque.com/demo/book/doc-a',
  );

  assert.match(merged, /## 思维导图结构/);
  assert.match(merged, /- Root\n  - Child/);
  assert.match(merged, /## 原文链接/);
  assert.doesNotMatch(merged, /原始语雀数据/);
  assert.doesNotMatch(merged, /JSON Canvas/);
});

test('mergeMarkdownWithArtifacts places board outline before body content without sidecar resource lists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-board-order-'));
  const targetMdPath = path.join(root, 'Demo.md');

  const merged = mergeMarkdownWithArtifacts(
    '# Demo\n\n![原图](assets/original-board.png)\n\n正文说明',
    {
      ...emptyArtifacts(),
      artifactKinds: ['board', 'mindmap'],
      boards: [
        {
          title: '思维导图 1',
          detectedKind: 'mindmap',
          structuredExport: true,
          markdown: '- Root\n  - Child',
          files: {
            pngPath: path.join(root, 'board-1.png'),
          },
        },
      ],
    },
    targetMdPath,
    'https://www.yuque.com/demo/book/doc-a',
  );

  const outlineIndex = merged.indexOf('## 思维导图结构');
  const bodyImageIndex = merged.indexOf('![原图](assets/original-board.png)');

  assert.notEqual(outlineIndex, -1);
  assert.notEqual(bodyImageIndex, -1);
  assert.ok(outlineIndex < bodyImageIndex);
  assert.doesNotMatch(merged, /原始语雀数据/);
  assert.doesNotMatch(merged, /JSON Canvas/);
});

test('buildCaptureTargetSelectors prioritizes specific complex blocks before fallback containers', () => {
  const selectors = buildCaptureTargetSelectors({
    artifactKinds: ['board', 'mindmap'],
    fallbackReason: 'board',
  });

  assert.ok(selectors.length > 0);
  assert.equal(selectors[0], '[data-type*="board"]');
  assert.ok(!selectors.includes('article'));
  assert.ok(!selectors.includes('.yuque-doc-content'));
});

test('buildCaptureTargetSelectors adds encrypted selectors for encrypted fallback', () => {
  const selectors = buildCaptureTargetSelectors({
    artifactKinds: [],
    fallbackReason: 'encrypted-fallback',
  });

  assert.ok(selectors.includes('input[data-testid="ne-card-locked-text-unlock-input"]'));
  assert.ok(selectors.includes('div.ne-card-locked-text-read-container[data-testid="ne-card-locked-text-viewer-content"]'));
});

test('createSelectionMatcher supports document-only exports', () => {
  const matcher = createSelectionMatcher({
    selectedBooks: ['1001', '1002'],
    fullySelectedBooks: [],
    selectedDocuments: ['https://www.yuque.com/demo/book/doc-a'],
  });

  assert.equal(matcher.shouldIncludeDocument('1001', 'https://www.yuque.com/demo/book/doc-a'), true);
  assert.equal(matcher.shouldIncludeDocument('1001', 'https://www.yuque.com/demo/book/doc-b'), false);
});

test('createSelectionMatcher keeps whole-book exports when fully selected', () => {
  const matcher = createSelectionMatcher({
    selectedBooks: ['1001'],
    fullySelectedBooks: ['1001'],
    selectedDocuments: ['https://www.yuque.com/demo/book/doc-a'],
  });

  assert.equal(matcher.shouldIncludeDocument('1001', 'https://www.yuque.com/demo/book/doc-a'), true);
  assert.equal(matcher.shouldIncludeDocument('1001', 'https://www.yuque.com/demo/book/doc-b'), true);
});

test('mergeMarkdownWithArtifacts injects encrypted texts back into placeholder positions first', () => {
  const markdown = ['# Demo', '', '\u524d\u6587', '', CARD_PLACEHOLDER, '', '\u540e\u6587'].join('\n');
  const artifacts = {
    ...emptyArtifacts(),
    encryptedTexts: ['\u7b2c\u4e00\u6bb5\u52a0\u5bc6\u5185\u5bb9'],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.match(merged, /> \u7b2c\u4e00\u6bb5\u52a0\u5bc6\u5185\u5bb9/);
  assert.doesNotMatch(merged, /## \u52a0\u5bc6\u6587\u672c\u5757\u5bfc\u51fa/);
  assert.doesNotMatch(merged, /\u6b64\u5904\u4e3a\u8bed\u96c0\u5361\u7247\uff0c\u70b9\u51fb\u94fe\u63a5\u67e5\u770b/);
});

test('mergeMarkdownWithArtifacts replaces only datatable slots and keeps unknown cards in place', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-datatable-slot-'));
  const targetMdPath = path.join(root, 'Demo.md');
  const markdown = ['# Demo', '', 'before', '', CARD_PLACEHOLDER, '', 'middle', '', CARD_PLACEHOLDER, '', 'after'].join('\n');
  const sidecarDir = path.join(root, '_assets', 'datatables', 'Demo', 'Tasks');
  const artifacts = {
    ...emptyArtifacts(),
    cardSlots: [
      { kind: 'unknown', url: 'https://www.yuque.com/docs/262416420#unknown' },
      { kind: 'datatable', url: 'https://www.yuque.com/docs/262416420#datatable' },
    ],
    datatables: [
      {
        title: 'Tasks',
        partial: false,
        columns: [{ key: 'col_1', name: 'Name' }],
        rows: [
          {
            cells: [{ columnKey: 'col_1', text: 'Task A' }],
          },
        ],
        files: {
          csvPath: path.join(sidecarDir, 'table.csv'),
          rowsJsonPath: path.join(sidecarDir, 'table.rows.json'),
          schemaJsonPath: path.join(sidecarDir, 'table.schema.json'),
          htmlPath: path.join(sidecarDir, 'table.html'),
          pngPath: path.join(sidecarDir, 'table.png'),
        },
        obsidian: {
          basePath: path.join(root, '_datasets', 'Demo', 'Tasks.base'),
          viewManifestPath: path.join(root, '_datasets', 'Demo', 'Tasks', 'view-manifest.json'),
        },
      },
    ],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, targetMdPath);

  assert.equal((merged.match(/此处为语雀卡片，点击链接查看/g) || []).length, 1);
  assert.match(merged, /middle[\s\S]*\*\*Tasks\*\*/);
  assert.match(merged, /\| Name \|/);
  assert.match(merged, /\| Task A \|/);
  assert.doesNotMatch(merged, /## 语雀数据表导出/);
});

test('mergeMarkdownWithArtifacts inserts code block titles before matching fenced blocks', () => {
  const markdown = ['# Demo', '', '```js', 'console.log(1);', '```', '', 'tail'].join('\n');
  const artifacts = {
    ...emptyArtifacts(),
    codeBlocks: [
      {
        index: 0,
        title: '示例代码',
        codeText: 'console.log(1);',
      },
    ],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.match(merged, /示例代码\n\n```js\nconsole\.log\(1\);\n```/);
});

test('mergeMarkdownWithArtifacts matches code block titles by code content when counts differ', () => {
  const markdown = ['# Demo', '', '```js', 'alpha()', '```', '', '```ts', 'beta()', '```'].join('\n');
  const artifacts = {
    ...emptyArtifacts(),
    codeBlocks: [
      {
        index: 0,
        title: '',
        codeText: 'alpha()',
      },
      {
        index: 1,
        title: '第二段代码',
        codeText: 'beta()',
      },
      {
        index: 2,
        title: '不会误插入',
        codeText: 'gamma()',
      },
    ],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.doesNotMatch(merged, /不会误插入/);
  assert.match(merged, /```js\nalpha\(\)\n```\n\n第二段代码\n\n```ts\nbeta\(\)\n```/);
});

test('mergeMarkdownWithArtifacts escapes markdown-leading code block titles and avoids duplicate insertion', () => {
  const markdown = ['# Demo', '', '\\# 标题行', '', '```bash', 'echo ok', '```'].join('\n');
  const artifacts = {
    ...emptyArtifacts(),
    codeBlocks: [
      {
        index: 0,
        title: '# 标题行',
        codeText: 'echo ok',
      },
    ],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.equal((merged.match(/\\# 标题行/g) || []).length, 1);
  assert.match(merged, /\\# 标题行\n\n```bash\necho ok\n```/);
});

test('datatableToCsv produces BOM csv for obsidian and spreadsheet import', () => {
  const csv = datatableToCsv({
    title: 'Tasks',
    columns: [
      { key: 'name', name: 'Name' },
      { key: 'tags', name: 'Tags' },
    ],
    rows: [
      {
        cells: [
          { columnKey: 'name', text: 'Task A' },
          { columnKey: 'tags', text: ['core', 'import'] },
        ],
      },
    ],
  });

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /"Name","Tags"/);
  assert.match(csv, /"Task A","core; import"/);
});

test('writeDatatableSidecarFiles creates fixed csv json and html files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-datatable-'));
  const tableDir = path.join(root, 'table-1');

  const files = writeDatatableSidecarFiles(
    {
      title: 'Tasks',
      source: 'html-table',
      partial: false,
      structuredState: { containerAttributes: { 'data-type': 'database' } },
      columns: [{ key: 'name', name: 'Name', type: 'text', options: [] }],
      rows: [{ cells: [{ columnKey: 'name', text: 'Task A', html: 'Task A', kind: 'text', raw: {} }] }],
      html: '<table><tr><th>Name</th></tr><tr><td>Task A</td></tr></table>',
    },
    tableDir,
  );

  assert.equal(fs.existsSync(files.csvPath), true);
  assert.equal(fs.existsSync(files.rowsJsonPath), true);
  assert.equal(fs.existsSync(files.schemaJsonPath), true);
  assert.equal(fs.existsSync(files.htmlPath), true);
  assert.equal(path.basename(files.pngPath), 'table.png');

  const rowsJson = JSON.parse(fs.readFileSync(files.rowsJsonPath, 'utf8'));
  assert.equal(rowsJson.rows[0].values.name, 'Task A');
});

test('mergeMarkdownWithArtifacts appends structured datatable section only when no inline slot exists', () => {
  const markdown = '# Demo\n\ncontent';
  const artifacts = {
    ...emptyArtifacts(),
    datatables: [
      {
        title: 'Tasks',
        partial: false,
        files: {
          dir: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks'),
          csvPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.csv'),
          rowsJsonPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.rows.json'),
          schemaJsonPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.schema.json'),
          htmlPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.html'),
          pngPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.png'),
        },
        obsidian: {
          basePath: path.join('vault', '_datasets', 'Demo', 'Tasks', 'dataset.base'),
          viewManifestPath: path.join('vault', '_datasets', 'Demo', 'Tasks', 'view-manifest.json'),
        },
        columns: [
          { key: 'name', name: 'Name' },
          { key: 'status', name: 'Status' },
        ],
        rows: [
          {
            cells: [
              { columnKey: 'name', text: 'Task A' },
              { columnKey: 'status', text: 'Doing' },
            ],
          },
        ],
      },
    ],
  };

  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'));
  assert.match(merged, /## \u8bed\u96c0\u6570\u636e\u8868\u5bfc\u51fa/);
  assert.match(merged, /\*\*Tasks\*\*/);
  assert.match(merged, /\| Name \| Status \|/);
  assert.match(merged, /\| Name \| Status \|/);
  assert.match(merged, /\| Task A \| Doing \|/);
});

test('writeDatatableObsidianDatasetFiles creates dataset manifests base and record notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-dataset-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(docDir, { recursive: true });
  const targetMdPath = path.join(docDir, 'Demo.md');
  fs.writeFileSync(targetMdPath, '# Demo\n', 'utf8');

  const sidecarDir = path.join(root, '_assets', 'datatables', 'Demo', 'Tasks');
  fs.mkdirSync(sidecarDir, { recursive: true });
  const sidecarFiles = {
    dir: sidecarDir,
    csvPath: path.join(sidecarDir, 'table.csv'),
    rowsJsonPath: path.join(sidecarDir, 'table.rows.json'),
    schemaJsonPath: path.join(sidecarDir, 'table.schema.json'),
    htmlPath: path.join(sidecarDir, 'table.html'),
    pngPath: path.join(sidecarDir, 'table.png'),
  };
  fs.writeFileSync(sidecarFiles.pngPath, '', 'utf8');

  const obsidian = writeDatatableObsidianDatasetFiles(
    {
      title: 'Tasks',
      partial: false,
      columns: [
        { key: 'col_1', name: 'Name' },
        { key: 'col_2', name: '\u72b6\u6001' },
        { key: 'col_3', name: '\u6807\u7b7e' },
      ],
      rows: [
        {
          cells: [
            { columnKey: 'col_1', text: 'Task A' },
            { columnKey: 'col_2', text: 'Doing' },
            { columnKey: 'col_3', text: ['core', 'import'] },
          ],
        },
      ],
    },
    {
      docPlan: {
        targetMdPath,
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
        node: { name: 'Demo' },
      },
      bookPlan: {
        book: { slug: 'book', name: 'Book' },
      },
      outputDir: root,
      datasetDirName: 'Tasks',
      datasetIndex: 0,
      sidecarFiles,
    },
  );

  assert.equal(fs.existsSync(obsidian.schemaPath), true);
  assert.equal(fs.existsSync(obsidian.viewManifestPath), true);
  assert.equal(fs.existsSync(obsidian.basePath), true);
  assert.equal(obsidian.recordCount, 1);

  const baseText = fs.readFileSync(obsidian.basePath, 'utf8');
  assert.match(baseText, /type: table/);
  assert.match(baseText, /type: cards/);
  assert.match(baseText, /type: list/);
  assert.match(baseText, /dataset == "book__demo__tasks"/);
  assert.match(baseText, /image: "cover"/);
  assert.match(baseText, /name: "表格视图"/);
  assert.match(baseText, /name: "卡片视图"/);
  assert.match(baseText, /name: "列表视图"/);
  assert.match(baseText, /displayName: "Name"/);
  assert.match(baseText, /displayName: "状态"/);
  assert.doesNotMatch(baseText, /displayName: "Title"/);

  const record = obsidian.records[0];
  const recordMd = fs.readFileSync(record.mdPath, 'utf8');
  assert.match(recordMd, /"dataset": "book__demo__tasks"/);
  assert.match(recordMd, /"source_system": "yuque"/);
  assert.match(recordMd, /"source_table": "Tasks"/);
  assert.match(recordMd, /"title": "Task A"/);
  assert.match(recordMd, /"status": "Doing"/);
  assert.match(recordMd, /"stage": "Doing"/);
  assert.match(recordMd, /"tags":\n  - "core"\n  - "import"/);

  const dataJson = JSON.parse(fs.readFileSync(record.dataJsonPath, 'utf8'));
  assert.equal(dataJson.record_id, 'book__demo__tasks-r0001');
  assert.equal(dataJson.values['状态'], 'Doing');

  const manifest = JSON.parse(fs.readFileSync(obsidian.viewManifestPath, 'utf8'));
  assert.equal(manifest.coverProperty, 'cover');
  assert.equal(manifest.boardProperty, 'stage');
  assert.deepEqual(manifest.defaultViews, ['表格视图', '卡片视图', '列表视图']);
  assert.deepEqual(manifest.views[0].order, ['Name', '状态', '标签']);
  assert.deepEqual(manifest.views[1].order, ['Name', '状态', '标签']);
});

test('writeDatatableObsidianDatasetFiles uses downloaded table images as local cover links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-dataset-cover-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(docDir, { recursive: true });
  const targetMdPath = path.join(docDir, 'Demo.md');
  fs.writeFileSync(targetMdPath, '# Demo\n', 'utf8');

  const sidecarDir = path.join(root, '_assets', 'datatables', 'Demo', 'Movies');
  const imagesDir = path.join(sidecarDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const coverPath = path.join(imagesDir, 'poster.png');
  fs.writeFileSync(coverPath, 'png', 'utf8');

  const sidecarFiles = {
    dir: sidecarDir,
    csvPath: path.join(sidecarDir, 'table.csv'),
    rowsJsonPath: path.join(sidecarDir, 'table.rows.json'),
    schemaJsonPath: path.join(sidecarDir, 'table.schema.json'),
    htmlPath: path.join(sidecarDir, 'table.html'),
    pngPath: path.join(sidecarDir, 'table.png'),
    imagesDir,
  };
  fs.writeFileSync(sidecarFiles.pngPath, 'png', 'utf8');

  const obsidian = writeDatatableObsidianDatasetFiles(
    {
      title: 'Movies',
      partial: false,
      columns: [
        { key: 'col_1', name: '名称' },
        { key: 'col_2', name: '灏侀潰', type: 'image' },
      ],
      rows: [
        {
          values: {
            col_1: '星际穿越',
            col_2: [
              {
                name: 'poster.png',
                localPath: coverPath,
                localRelativePath: 'images/poster.png',
                sourceUrl: 'https://cdn.example.com/poster.png',
              },
            ],
          },
          cells: [
            { columnKey: 'col_1', value: '星际穿越', text: '星际穿越', html: '星际穿越' },
            {
              columnKey: 'col_2',
              value: [
                {
                  name: 'poster.png',
                  localPath: coverPath,
                  localRelativePath: 'images/poster.png',
                  sourceUrl: 'https://cdn.example.com/poster.png',
                },
              ],
              text: 'images/poster.png',
              html: '<img src="images/poster.png" />',
            },
          ],
        },
      ],
    },
    {
      docPlan: {
        targetMdPath,
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
        node: { name: 'Demo' },
      },
      bookPlan: {
        book: { slug: 'book', name: 'Book' },
      },
      outputDir: root,
      datasetDirName: 'Movies',
      datasetIndex: 0,
      sidecarFiles,
    },
  );

  const record = obsidian.records[0];
  const recordMd = fs.readFileSync(record.mdPath, 'utf8');
  const expectedRelativeCover = path.relative(path.dirname(record.mdPath), coverPath).replace(/\\/g, '/');

  const escapedRelativeCover = expectedRelativeCover.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(recordMd, new RegExp(`"cover": "\\[\\[${escapedRelativeCover}\\]\\]"`));
  assert.match(recordMd, new RegExp(`\\[\\[${escapedRelativeCover}\\]\\]`));
  assert.doesNotMatch(recordMd, /\[object Object\]/);
});

test('writeDatatableObsidianDatasetFiles creates a standalone primary base and keeps card fields aligned with Yuque metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-dataset-primary-base-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(docDir, { recursive: true });
  const targetMdPath = path.join(docDir, 'Demo.md');
  fs.writeFileSync(targetMdPath, '# Demo\n', 'utf8');

  const sidecarDir = path.join(root, '_assets', 'datatables', 'Demo', 'Movies');
  const imagesDir = path.join(sidecarDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const coverPath = path.join(imagesDir, 'poster.png');
  fs.writeFileSync(coverPath, 'png', 'utf8');

  const sidecarFiles = {
    dir: sidecarDir,
    csvPath: path.join(sidecarDir, 'table.csv'),
    rowsJsonPath: path.join(sidecarDir, 'table.rows.json'),
    schemaJsonPath: path.join(sidecarDir, 'table.schema.json'),
    htmlPath: path.join(sidecarDir, 'table.html'),
    pngPath: path.join(sidecarDir, 'table.png'),
    imagesDir,
  };
  fs.writeFileSync(sidecarFiles.pngPath, 'png', 'utf8');

  const obsidian = writeDatatableObsidianDatasetFiles(
    {
      title: 'Movies',
      partial: false,
      columns: [
        { key: 'col_1', id: 'name', name: '名字' },
        { key: 'col_2', id: 'rating', name: '豆瓣评分' },
        { key: 'col_3', id: 'watch', name: '观影时间' },
        { key: 'col_4', id: 'cover', name: '灏侀潰', type: 'image' },
      ],
      defaultViewId: 'card-view',
      activeViewId: 'card-view',
      defaultView: { id: 'card-view', name: '卡片视图', type: 'CARD' },
      activeView: { id: 'card-view', name: '卡片视图', type: 'CARD' },
      tableView: {
        id: 'grid-view',
        name: '表格视图',
        type: 'GRID',
        orderedColumnIds: ['name', 'rating', 'watch', 'cover'],
      },
      cardView: {
        id: 'card-view',
        name: '卡片视图',
        type: 'CARD',
        visibleColumnIds: ['name', 'rating', 'watch'],
        coverColumnId: 'cover',
        coverDisplay: 'fit',
      },
      views: [
        { id: 'grid-view', name: '表格视图', type: 'GRID' },
        { id: 'card-view', name: '卡片视图', type: 'CARD' },
      ],
      rows: [
        {
          values: {
            col_1: '星际穿越',
            col_2: '8.7',
            col_3: '2025-04-05',
            col_4: [
              {
                name: 'poster.png',
                localPath: coverPath,
                localRelativePath: 'images/poster.png',
                sourceUrl: 'https://cdn.example.com/poster.png',
              },
            ],
          },
          cells: [
            { columnKey: 'col_1', value: '星际穿越', text: '星际穿越', html: '星际穿越' },
            { columnKey: 'col_2', value: '8.7', text: '8.7', html: '8.7' },
            { columnKey: 'col_3', value: '2025-04-05', text: '2025-04-05', html: '2025-04-05' },
            {
              columnKey: 'col_4',
              value: [
                {
                  name: 'poster.png',
                  localPath: coverPath,
                  localRelativePath: 'images/poster.png',
                  sourceUrl: 'https://cdn.example.com/poster.png',
                },
              ],
              text: 'images/poster.png',
              html: '<img src="images/poster.png" />',
            },
          ],
        },
      ],
    },
    {
      docPlan: {
        targetMdPath,
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
        node: { name: 'Demo' },
      },
      bookPlan: {
        book: { slug: 'book', name: 'Book' },
      },
      outputDir: root,
      datasetDirName: 'Movies',
      datasetIndex: 0,
      sidecarFiles,
      primaryBasePath: path.join(docDir, 'Demo.base'),
    },
  );

  assert.equal(fs.existsSync(obsidian.primaryBasePath), true);

  const primaryBaseText = fs.readFileSync(obsidian.primaryBasePath, 'utf8');
  assert.match(primaryBaseText, /file\.inFolder\(this\.file\.folder \+ "\/_datasets\/Demo\/Movies\/records"\)/);
  assert.ok(primaryBaseText.indexOf('type: cards') < primaryBaseText.indexOf('type: table'));
  assert.match(primaryBaseText, /image: "[^"]+"/);
  assert.match(primaryBaseText, /imageFit: contain/);
  assert.match(primaryBaseText, /imageAspectRatio: "1\.5"/);
  assert.match(primaryBaseText, /cardSize: 260/);

  const manifest = JSON.parse(fs.readFileSync(obsidian.viewManifestPath, 'utf8'));
  assert.equal(manifest.views[0].type, 'cards');
  assert.equal(manifest.coverProperty, manifest.views[0].image);
  assert.notEqual(manifest.coverProperty, 'cover');
  assert.equal(manifest.defaultViews[0], manifest.views[0].name);
  assert.equal(manifest.views[0].order.length, 3);
  assert.equal(manifest.views[0].imageFit, 'contain');
  assert.equal(manifest.views[0].imageAspectRatio, '1.5');
  assert.equal(manifest.views[0].cardSize, 260);
});

test('writeDatatableObsidianDatasetFiles uses vault-root relative cover links when a vault root is provided', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-dataset-cover-vault-'));
  const vaultRoot = path.join(root, 'Vault');
  const docDir = path.join(vaultRoot, '语雀导出', 'Book');
  fs.mkdirSync(docDir, { recursive: true });
  const targetMdPath = path.join(docDir, 'Demo.md');
  fs.writeFileSync(targetMdPath, '# Demo\n', 'utf8');

  const sidecarDir = path.join(docDir, '_assets', 'datatables', 'Demo', 'Movies');
  const imagesDir = path.join(sidecarDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const coverPath = path.join(imagesDir, 'poster.png');
  fs.writeFileSync(coverPath, 'png', 'utf8');

  const sidecarFiles = {
    dir: sidecarDir,
    csvPath: path.join(sidecarDir, 'table.csv'),
    rowsJsonPath: path.join(sidecarDir, 'table.rows.json'),
    schemaJsonPath: path.join(sidecarDir, 'table.schema.json'),
    htmlPath: path.join(sidecarDir, 'table.html'),
    pngPath: path.join(sidecarDir, 'table.png'),
    imagesDir,
  };
  fs.writeFileSync(sidecarFiles.pngPath, 'png', 'utf8');

  const obsidian = writeDatatableObsidianDatasetFiles(
    {
      title: 'Movies',
      partial: false,
      columns: [
        { key: 'col_1', name: '名称' },
        { key: 'col_2', name: '灏侀潰', type: 'image' },
      ],
      rows: [
        {
          values: {
            col_1: '星际穿越',
            col_2: [
              {
                name: 'poster.png',
                localPath: coverPath,
                localRelativePath: 'images/poster.png',
                sourceUrl: 'https://cdn.example.com/poster.png',
              },
            ],
          },
          cells: [
            { columnKey: 'col_1', value: '星际穿越', text: '星际穿越', html: '星际穿越' },
            {
              columnKey: 'col_2',
              value: [
                {
                  name: 'poster.png',
                  localPath: coverPath,
                  localRelativePath: 'images/poster.png',
                  sourceUrl: 'https://cdn.example.com/poster.png',
                },
              ],
              text: 'images/poster.png',
              html: '<img src="images/poster.png" />',
            },
          ],
        },
      ],
    },
    {
      docPlan: {
        targetMdPath,
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
        node: { name: 'Demo' },
      },
      bookPlan: {
        book: { slug: 'book', name: 'Book' },
      },
      outputDir: path.join(vaultRoot, '语雀导出'),
      datasetDirName: 'Movies',
      datasetIndex: 0,
      sidecarFiles,
      linkRoot: vaultRoot,
    },
  );

  const record = obsidian.records[0];
  const recordMd = fs.readFileSync(record.mdPath, 'utf8');
  const expectedVaultRelativeCover = '语雀导出/Book/_assets/datatables/Demo/Movies/images/poster.png';

  assert.match(recordMd, new RegExp(`"cover": "\\[\\[${expectedVaultRelativeCover.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]"`));
  assert.doesNotMatch(recordMd, /\.\.\//);
});

test('findMissingExportedAssetReferences reports missing local exported asset files only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-missing-assets-'));
  const docDir = path.join(root, 'Book');
  const assetDir = path.join(docDir, '_assets', 'images');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'present.png'), 'ok', 'utf8');

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = [
    '# Demo',
    '',
    '![ok](_assets/images/present.png)',
    '![missing](_assets/images/missing.png)',
    '[external](https://example.com/file.png)',
    '[doc](../Other.md)',
  ].join('\n');

  const findings = findMissingExportedAssetReferences(markdown, targetMdPath);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'image');
  assert.match(findings[0].rawUrl, /_assets\/images\/missing\.png/);
  assert.match(findings[0].resolvedPath, /missing\.png$/);
});

test('appendExportWarningsSection adds a visible warning block for partial export issues', () => {
  const markdown = '# Demo\n\nbody';
  const output = appendExportWarningsSection(markdown, [
    {
      localizedPhase: '改写链接与下载资源',
      localizedErrorMessage: '图片资源下载失败，已保留原始链接。',
    },
  ]);

  assert.match(output, /## 导出警告/);
  assert.match(output, /\[改写链接与下载资源\] 图片资源下载失败，已保留原始链接。/);
});

test('buildPlaceholderMarkdown preserves existing body markdown when artifact capture fails after markdown export', () => {
  const markdown = ['# Demo', '', '开头正文', '', CARD_PLACEHOLDER, '', '结尾正文'].join('\n');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-placeholder-body-'));
  const targetMdPath = path.join(root, 'Demo.md');
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
          label: '此处为语雀卡片，点击链接查看',
          url: 'https://www.yuque.com/docs/262416420#scf1R',
        },
      ],
      boards: [
        {
          sourceType: 'embedded-card',
          detectedKind: 'flowchart',
          structuredExport: true,
          mermaid: 'flowchart TD\n  A["开始"] --> B["结束"]',
          markdown: '',
          title: '流程图 1',
          files: {},
        },
      ],
    },
    {
      baseMarkdown: markdown,
    },
  );

  assert.match(output, /开头正文/);
  assert.match(output, /```mermaid/);
  assert.match(output, /结尾正文/);
  assert.doesNotMatch(output, /此文档未能直接导出为标准 Markdown/);
  assert.doesNotMatch(output, /## 导出警告/);

});

test('buildPlaceholderMarkdown falls back to failure shell when no base markdown is available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-placeholder-shell-'));
  const targetMdPath = path.join(root, 'Demo.md');
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
  );

  assert.match(output, /此文档未能直接导出为标准 Markdown/);
  assert.doesNotMatch(output, /## 导出警告/);
});
