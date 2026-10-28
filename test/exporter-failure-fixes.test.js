import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyComplexArtifactRetryStrategy,
  buildAssetDownloadCandidateUrls,
  buildExportBrowserLaunchOptions,
  captureRenderedImageFallbackToLocalAsset,
  captureRenderedImageFallbackInEditModeOnPage,
  captureRenderedImageFallbackInVisibleBrowser,
  classifyDocumentEditImageCaptureInspection,
  classifyDocumentEditModeState,
  classifyRenderedImageCaptureInspection,
  disposeDocumentInteractiveRecoverySession,
  emptyArtifacts,
  ensureDocumentInteractiveRecoverySession,
  executeComplexArtifactPlan,
  isRenderedImageBlankCapture,
  pickDocumentEditCaptureTargetCandidate,
  pickDocumentEditImageCandidate,
  pickVisibleDocumentEditEntry,
  recordArtifactExportWarnings,
  planComplexArtifactWork,
  prepareStructuredBoards,
  classifyDocExportRoute,
  isEffectivelyEmptyDocDetail,
  repairMarkdownAssetReferences,
  resolveComplexBlockMode,
  shouldAttemptRenderedImageScreenshotFallback,
  writeDatatableObsidianDatasetFiles,
} from '../src/exporter.js';
import {
  buildWorkbookHtmlDocument,
  buildWorksheetCsv,
  decodeLakesheetWorkbook,
  isSheetDocument,
  normalizeStandaloneSheetDocument,
  parseLakesheetBody,
} from '../src/sheet.js';
import { localizeFailureRecord } from '../src/failure-log.js';
import { getLoginProfileDir } from '../src/login.js';

const CARD_PLACEHOLDER =
  '[\u6b64\u5904\u4e3a\u8bed\u96c0\u5361\u7247\uff0c\u70b9\u51fb\u94fe\u63a5\u67e5\u770b](https://www.yuque.com/docs/262416420#scf1R)';

test('planComplexArtifactWork classifies embedded datatable slots from doc detail before worker capture', () => {
  const markdown = ['# Demo', '', CARD_PLACEHOLDER, '', CARD_PLACEHOLDER].join('\n');
  const plan = planComplexArtifactWork({
    markdown,
    rewrittenMarkdown: markdown,
    complexBlockMode: 'auto',
    preparedBoards: [],
    docDetail: {
      type: 'Doc',
      format: 'lake',
      content: '<card type="block" name="bookmark" value="data:bookmark" /><card type="block" name="database" value="data:database" />',
    },
  });

  assert.equal(plan.baseArtifacts.cardSlots.length, 2);
  assert.equal(plan.baseArtifacts.cardSlots[0].kind, 'unknown');
  assert.equal(plan.baseArtifacts.cardSlots[1].kind, 'datatable');
});

test('planComplexArtifactWork recognizes encrypted-only embedded cards and skips generic capture', () => {
  const markdown = ['# Demo', '', CARD_PLACEHOLDER, '', CARD_PLACEHOLDER].join('\n');
  const plan = planComplexArtifactWork({
    markdown,
    rewrittenMarkdown: markdown,
    complexBlockMode: 'auto',
    preparedBoards: [],
    docDetail: {
      type: 'Doc',
      format: 'lake',
      content: '<card type="block" name="locked-text" /><card type="block" name="locked-text" />',
    },
  });

  assert.equal(plan.needsWorker, true);
  assert.equal(plan.baseArtifacts.cardSlots.length, 2);
  assert.equal(plan.baseArtifacts.cardSlots[0].kind, 'encrypted');
  assert.equal(plan.baseArtifacts.cardSlots[1].kind, 'encrypted');
  assert.deepEqual(plan.requestedTasks, {
    captureGenericArtifacts: false,
    captureDatatables: false,
    captureEncryptedTexts: true,
    captureBoardPngs: false,
    forceFallbackSnapshot: false,
  });
});

test('executeComplexArtifactPlan preserves partial datatable exports after repeated worker crashes', async () => {
  const markdown = ['# Demo', '', CARD_PLACEHOLDER, '', CARD_PLACEHOLDER].join('\n');
  const plan = planComplexArtifactWork({
    markdown,
    rewrittenMarkdown: markdown,
    complexBlockMode: 'auto',
    preparedBoards: [],
    docDetail: {
      type: 'Doc',
      format: 'lake',
      content: '<card type="block" name="bookmark" value="data:bookmark" /><card type="block" name="database" value="data:database" />',
    },
  });

  let attempts = 0;
  const partialDatatable = {
    title: 'Tasks',
    partial: false,
    columns: [{ key: 'col_1', name: 'Name' }],
    rows: [
      {
        cells: [{ columnKey: 'col_1', text: 'Task A' }],
      },
    ],
    files: {
      csvPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.csv'),
      rowsJsonPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.rows.json'),
      schemaJsonPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.schema.json'),
      htmlPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.html'),
      pngPath: path.join('vault', '_assets', 'datatables', 'Demo', 'Tasks', 'table.png'),
    },
  };

  const artifacts = await executeComplexArtifactPlan(plan, {
    runAttempt: async () => {
      attempts += 1;
      const error = new Error('Complex artifact worker crashed with exit code 3221226505 (0xC0000409).');
      error.exitCode = 3221226505;
      error.isWorkerCrash = true;
      if (attempts === 1) {
        error.partialArtifacts = {
          ...emptyArtifacts(),
          datatables: [partialDatatable],
          artifactKinds: ['datatable'],
        };
      }
      throw error;
    },
  });

  assert.equal(attempts, 2);
  assert.equal(artifacts.workerStatus, 'degraded');
  assert.equal(artifacts.datatables.length, 1);
  assert.equal(artifacts.cardSlots.length, 2);
  assert.equal(artifacts.cardSlots[0].kind, 'unknown');
  assert.equal(artifacts.cardSlots[1].kind, 'datatable');
  assert.equal(artifacts.cardSlots[1].resolved, true);
  assert.equal(artifacts.cardSlots[1].datatableIndex, 0);
});
function createMindmapDiagram() {
  return {
    body: [
      {
        id: 'root-1',
        type: 'mindmap',
        html: '根节点',
        children: [
          {
            id: 'child-1',
            html: '子节点 A',
            children: [],
          },
        ],
      },
    ],
  };
}

function createFlowchartDiagram() {
  return {
    body: [
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
        html: '\u5ba1\u6279\u901a\u8fc7',
      },
      {
        id: 'finish',
        type: 'geometry',
        shape: 'rect',
        html: '\u7ed3\u675f',
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
        target: { id: 'finish' },
      },
    ],
  };
}

test('classifyDocExportRoute distinguishes empty docs, board docs, table docs, and normal markdown docs', () => {
  assert.equal(
    classifyDocExportRoute({
      type: 'Doc',
      format: 'lake',
      content: '',
      body: '',
    }),
    'skip-empty',
  );

  assert.equal(
    classifyDocExportRoute({
      type: 'Board',
      format: 'lakeboard',
      content: '',
    }),
    'export-board',
  );

  assert.equal(
    classifyDocExportRoute({
      type: 'Sheet',
      format: 'lakesheet',
      content: '',
    }),
    'export-sheet',
  );

  assert.equal(
    classifyDocExportRoute({
      type: 'Table',
      format: 'laketable',
      content: '',
    }),
    'export-table',
  );

  assert.equal(
    classifyDocExportRoute({
      type: 'Doc',
      format: 'lake',
      content: '<p>hello</p>',
      body: '<p>hello</p>',
    }),
    'export-markdown',
  );
});

test('isEffectivelyEmptyDocDetail treats lake boilerplate with only blank paragraphs as empty', () => {
  assert.equal(
    isEffectivelyEmptyDocDetail({
      type: 'Doc',
      format: 'lake',
      content:
        '<!doctype lake><meta name="doc-version" content="1" /><meta name="viewport" content="fixed" /><p data-lake-id="u1"><br></p>',
      body: '',
    }),
    true,
  );
});

test('sheet helpers decode Yuque lakesheet payloads into workbook sidecars', () => {
  const workbookPayload = [
    {
      name: '统计表',
      rowCount: 5,
      colCount: 4,
      mergeCells: {
        '0:0': { row: 0, col: 0, rowCount: 1, colCount: 2 },
      },
      data: {
        0: {
          0: { v: '项目效率统计表' },
        },
        1: {
          0: { v: '批次' },
          1: { v: '效率' },
        },
        2: {
          0: { v: '第一批' },
          1: { v: { class: 'formula', formula: 'B3/C3', value: 0.25 } },
        },
      },
    },
    {
      name: 'Sheet2',
      rowCount: 3,
      colCount: 2,
      mergeCells: {},
      data: {
        0: {
          0: { v: '说明' },
        },
      },
    },
  ];
  const rawBody = {
    format: 'lakesheet',
    version: '3.5.5',
    sheet: zlib.deflateSync(JSON.stringify(workbookPayload)).toString('latin1'),
  };

  assert.equal(isSheetDocument({ type: 'Sheet', format: 'lakesheet', body: JSON.stringify(rawBody) }), true);
  assert.equal(parseLakesheetBody(JSON.stringify(rawBody)).format, 'lakesheet');
  assert.equal(decodeLakesheetWorkbook(rawBody).length, 2);

  const normalized = normalizeStandaloneSheetDocument({
    id: 1,
    title: '项目效率统计表',
    type: 'Sheet',
    format: 'lakesheet',
    body: JSON.stringify(rawBody),
  });
  const worksheet = normalized.sheets[0];

  assert.equal(normalized.sheetCount, 2);
  assert.equal(worksheet.usedRowCount, 3);
  assert.equal(worksheet.usedColCount, 2);
  assert.equal(worksheet.mergeCellCount, 1);
  assert.match(buildWorksheetCsv(worksheet), /"第一批","0\.25"/);
  assert.match(buildWorkbookHtmlDocument(normalized), /统计表/);
});

test('board sidecar warnings distinguish embedded cards from standalone board docs', () => {
  const embedded = localizeFailureRecord({
    phase: 'capture-artifacts',
    error_type: 'BoardExportSidecarOnly',
    error_message:
      'Detected embedded Yuque board card content inside a regular document. The main markdown/text content was exported normally, and the embedded board content was kept as Yuque JSON/PNG sidecar files instead of a markdown outline. Reasons: no-connectable-nodes.',
  });
  const standalone = localizeFailureRecord({
    phase: 'capture-artifacts',
    error_type: 'BoardExportSidecarOnly',
    error_message:
      'Detected a standalone Yuque board document that could not be linearized into a markdown outline. The export kept Yuque JSON/PNG sidecar files instead. Reasons: invalid-line-endpoints.',
  });

  assert.match(embedded.error_type, /画板内容已导出为附加文件/);
  assert.match(embedded.error_message, /内嵌了语雀画板卡片/);
  assert.match(standalone.error_message, /独立的语雀画板文档/);
});

test('recordArtifactExportWarnings suppresses embedded fallback board sidecar warnings', () => {
  const embeddedWarnings = [];
  recordArtifactExportWarnings(
    {
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
    },
    (issue) => embeddedWarnings.push(issue),
  );

  const standaloneWarnings = [];
  recordArtifactExportWarnings(
    {
      ...emptyArtifacts(),
      artifactKinds: ['board'],
      boards: [
        {
          sourceType: 'board-document',
          title: '画板 1',
          failureReason: 'invalid-line-endpoints',
          structuredExport: false,
          markdown: '',
          mermaid: '',
        },
      ],
    },
    (issue) => standaloneWarnings.push(issue),
  );

  assert.equal(embeddedWarnings.length, 0);
  assert.equal(standaloneWarnings.length, 1);
  assert.equal(standaloneWarnings[0].error_type, 'BoardExportSidecarOnly');
});

test('recordArtifactExportWarnings does not duplicate encrypted password mismatch as fallback degradation', () => {
  const warnings = [];
  recordArtifactExportWarnings(
    {
      ...emptyArtifacts(),
      artifactKinds: ['encrypted'],
      requiresFallback: true,
      fallbackReason: 'encrypted-fallback',
      encryptedState: {
        detectedCount: 1,
        remainingLockedCount: 1,
        attemptedPasswordCount: 3,
      },
    },
    (issue) => warnings.push(issue),
  );

  assert.equal(warnings.length, 0);
});

test('resolveComplexBlockMode keeps auto mode content-aware instead of disabling by document count', () => {
  assert.equal(resolveComplexBlockMode({ complexBlockMode: 'auto' }), 'auto');
  assert.equal(resolveComplexBlockMode({ complexBlockMode: 'snapshot-first' }), 'snapshot-first');
});

test('planComplexArtifactWork skips worker when markdown has no complex placeholders or prepared boards', () => {
  const plan = planComplexArtifactWork({
    markdown: '# Demo\n\nPlain body',
    rewrittenMarkdown: '# Demo\n\nPlain body',
    complexBlockMode: 'auto',
    preparedBoards: [],
  });

  assert.equal(plan.needsWorker, false);
  assert.deepEqual(plan.requestedTasks, {
    captureGenericArtifacts: false,
    captureDatatables: false,
    captureEncryptedTexts: false,
    captureBoardPngs: false,
    forceFallbackSnapshot: false,
  });
});

test('prepareStructuredBoards writes embedded board outlines without requiring the worker path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-boards-'));
  const bookDir = path.join(root, 'Book');
  const docDir = path.join(bookDir, '_assets', 'boards');
  fs.mkdirSync(docDir, { recursive: true });

  const boards = prepareStructuredBoards(
    {
      type: 'Doc',
      format: 'lake',
      content: `<card type="block" name="board" value="data:${encodeURIComponent(
        JSON.stringify({ diagramData: createMindmapDiagram() }),
      )}" />`,
    },
    {
      targetMdPath: path.join(bookDir, 'Demo.md'),
      node: { name: 'Demo' },
    },
    {
      bookDir,
      assets: {
        boards: docDir,
      },
    },
    {
      complexBlockMode: 'structured-first',
    },
  );

  assert.equal(boards.length, 1);
  assert.equal(boards[0].structuredExport, true);
  assert.match(boards[0].markdown, /根节点/);
  assert.equal(fs.existsSync(boards[0].files.jsonPath), true);
  assert.equal(fs.existsSync(boards[0].files.canvasPath), true);
  assert.equal(boards[0].detectedKind, 'mindmap');
  assert.equal(boards[0].structuredFormat, 'mindmap-markdown');
  // 新默认策略为 fallback-only：完整结构化思维导图无需再无条件截图。
  assert.equal(boards[0].pngRequested, false);
});

test('prepareStructuredBoards exports Mermaid flowcharts for standalone board documents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-flowchart-board-'));
  const bookDir = path.join(root, 'Book');
  const boardDir = path.join(bookDir, '_assets', 'boards');
  fs.mkdirSync(boardDir, { recursive: true });

  const boards = prepareStructuredBoards(
    {
      type: 'Board',
      format: 'lakeboard',
      title: '\u5ba1\u6279\u6d41\u7a0b',
      content: JSON.stringify({
        format: 'lakeboard',
        type: 'Board',
        version: '1.0',
        diagramData: createFlowchartDiagram(),
      }),
    },
    {
      targetMdPath: path.join(bookDir, 'Flow.md'),
      node: { name: 'Flow' },
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
  assert.equal(boards[0].title, '\u5ba1\u6279\u6d41\u7a0b');
  assert.equal(boards[0].structuredExport, true);
  assert.equal(boards[0].detectedKind, 'flowchart');
  assert.equal(boards[0].structuredFormat, 'mermaid-flowchart');
  assert.equal(boards[0].partialStructured, false);
  assert.equal(boards[0].ignoredElementCount, 0);
  assert.match(boards[0].mermaid, /^flowchart TD/m);
  assert.equal(fs.existsSync(boards[0].files.jsonPath), true);
  assert.equal(fs.existsSync(boards[0].files.canvasPath), false);
  // 简单 Mermaid 流程图在无降级风险时不再强制生成 PNG。
  assert.equal(boards[0].pngRequested, false);
});

test('repairMarkdownAssetReferences rewrites broken local image exports to downloaded Yuque-rendered proxies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-repair-local-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(path.join(docDir, '_assets', 'images'), { recursive: true });

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = '# Demo\n\n![missing](_assets/images/missing.png)';
  const recoveredLocalPath = path.join(docDir, '_assets', 'images', 'recovered-from-yuque.png');

  const result = await repairMarkdownAssetReferences(markdown, {
    targetMdPath,
    renderedImages: [
      {
        downloadUrl:
          'https://www.yuque.com/api/filetransfer/images?url=https%3A%2F%2Fimg-blog.csdnimg.cn%2Fmissing.png&sign=abc',
        originalUrl: 'https://img-blog.csdnimg.cn/missing.png',
        basenameCandidates: ['missing.png'],
      },
    ],
    downloadAsset: async (assetUrl, kind, options = {}) => {
      assert.equal(kind, 'image');
      assert.match(assetUrl, /filetransfer\/images/);
      assert.equal(options.fileNameHint, 'missing.png');
      return recoveredLocalPath;
    },
  });

  assert.equal(result.issues.length, 0);
  assert.match(result.markdown, /!\[missing\]\(_assets\/images\/recovered-from-yuque\.png\)/);
  assert.doesNotMatch(result.markdown, /!\[missing\]\(_assets\/images\/missing\.png\)/);
});

test('repairMarkdownAssetReferences keeps a remote URL when broken local exports cannot be rebuilt locally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-repair-remote-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(path.join(docDir, '_assets', 'images'), { recursive: true });

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = '# Demo\n\n![missing](_assets/images/missing.png)';

  const result = await repairMarkdownAssetReferences(markdown, {
    targetMdPath,
    renderedImages: [
      {
        downloadUrl:
          'https://www.yuque.com/api/filetransfer/images?url=https%3A%2F%2Fimg-blog.csdnimg.cn%2Fmissing.png&sign=abc',
        originalUrl: 'https://img-blog.csdnimg.cn/missing.png',
        basenameCandidates: ['missing.png'],
      },
    ],
    downloadAsset: async () => '',
  });

  assert.match(result.markdown, /!\[missing\]\(https:\/\/img-blog\.csdnimg\.cn\/missing\.png\)/);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].error_type, 'AssetRetainedRemote');
  assert.match(result.issues[0].error_message, /broken local export reference _assets\/images\/missing\.png/);
});

test('repairMarkdownAssetReferences does not redownload a rendered fallback when Yuque never decoded the image', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-repair-unloaded-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(path.join(docDir, '_assets', 'images'), { recursive: true });

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = '# Demo\n\n![missing](_assets/images/missing.png)';
  let downloadAttempts = 0;

  const result = await repairMarkdownAssetReferences(markdown, {
    targetMdPath,
    renderedImages: [
      {
        downloadUrl:
          'https://www.yuque.com/api/filetransfer/images?url=https%3A%2F%2Fimg-blog.csdnimg.cn%2Fmissing.png&sign=abc',
        originalUrl: 'https://img-blog.csdnimg.cn/missing.png',
        basenameCandidates: ['missing.png'],
        naturalWidth: 0,
        naturalHeight: 0,
        clientWidth: 659,
        clientHeight: 0,
        complete: true,
        isLoaded: false,
      },
    ],
    downloadAsset: async () => {
      downloadAttempts += 1;
      return '';
    },
  });

  assert.equal(downloadAttempts, 0);
  assert.match(result.markdown, /!\[missing\]\(https:\/\/img-blog\.csdnimg\.cn\/missing\.png\)/);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].error_type, 'AssetRetainedRemote');
});

test('repairMarkdownAssetReferences can recover a broken image through visible-browser fallback when Yuque never decoded it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-repair-visible-fallback-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(path.join(docDir, '_assets', 'images'), { recursive: true });

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = '# Demo\n\n![missing](_assets/images/missing.png)';
  const recoveredLocalPath = path.join(docDir, '_assets', 'images', 'recovered-visible.png');
  const fallbackCalls = [];

  const result = await repairMarkdownAssetReferences(markdown, {
    targetMdPath,
    renderedImages: [
      {
        downloadUrl:
          'https://www.yuque.com/api/filetransfer/images?url=https%3A%2F%2Fimg-blog.csdnimg.cn%2Fmissing.png&sign=abc',
        originalUrl: 'https://img-blog.csdnimg.cn/missing.png',
        basenameCandidates: ['missing.png'],
        renderIndex: 0,
        naturalWidth: 0,
        naturalHeight: 0,
        clientWidth: 659,
        clientHeight: 0,
        complete: true,
        isLoaded: false,
      },
    ],
    downloadAsset: async () => '',
    captureRenderedImageFallback: async (candidate, options = {}) => {
      fallbackCalls.push({ candidate, options });
      return recoveredLocalPath;
    },
  });

  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].candidate.imageOccurrence, 0);
  assert.deepEqual(fallbackCalls[0].candidate.basenameCandidates, ['missing.png']);
  assert.equal(fallbackCalls[0].options.fileNameHint, 'missing.png');
  assert.match(result.markdown, /!\[missing\]\(_assets\/images\/recovered-visible\.png\)/);
  assert.equal(result.issues.length, 0);
});

test('repairMarkdownAssetReferences can recover a broken image by rendered-image occurrence when url matching fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-repair-occurrence-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(path.join(docDir, '_assets', 'images'), { recursive: true });

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = ['# Demo', '', '![first](_assets/images/first-missing.png)', '', '![second](_assets/images/second-missing.png)'].join('\n');
  const recoveredLocalPath = path.join(docDir, '_assets', 'images', 'recovered-second.png');
  const calls = [];

  const result = await repairMarkdownAssetReferences(markdown, {
    targetMdPath,
    renderedImages: [
      {
        downloadUrl: 'https://www.yuque.com/api/filetransfer/images?sign=one',
        originalUrl: 'https://cdn.example.com/unmatched-a.png',
        basenameCandidates: ['unmatched-a.png'],
        renderIndex: 0,
        naturalWidth: 900,
        naturalHeight: 600,
        clientWidth: 680,
        clientHeight: 453,
        complete: true,
        isLoaded: true,
      },
      {
        downloadUrl: 'https://www.yuque.com/api/filetransfer/images?sign=two',
        originalUrl: 'https://cdn.example.com/unmatched-b.png',
        basenameCandidates: ['unmatched-b.png'],
        renderIndex: 1,
        naturalWidth: 900,
        naturalHeight: 600,
        clientWidth: 680,
        clientHeight: 453,
        complete: true,
        isLoaded: true,
      },
    ],
    downloadAsset: async (assetUrl) => {
      calls.push(assetUrl);
      return assetUrl.includes('sign=two') ? recoveredLocalPath : '';
    },
  });

  assert.equal(calls.length, 2);
  assert.match(result.markdown, /!\[second\]\(_assets\/images\/recovered-second\.png\)/);
  assert.match(result.markdown, /!\[first\]\(https:\/\/cdn\.example\.com\/unmatched-a\.png\)/);
});

test('repairMarkdownAssetReferences does not reuse a repaired image across different image occurrences of the same broken local path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-repair-slot-key-'));
  const docDir = path.join(root, 'Book');
  fs.mkdirSync(path.join(docDir, '_assets', 'images'), { recursive: true });

  const targetMdPath = path.join(docDir, 'Demo.md');
  const markdown = ['# Demo', '', '![first](_assets/images/missing.png)', '', '![second](_assets/images/missing.png)'].join('\n');
  const firstRecoveredLocalPath = path.join(docDir, '_assets', 'images', 'recovered-first.png');
  const secondRecoveredLocalPath = path.join(docDir, '_assets', 'images', 'recovered-second.png');
  const calls = [];

  const result = await repairMarkdownAssetReferences(markdown, {
    targetMdPath,
    renderedImages: [
      {
        downloadUrl: 'https://www.yuque.com/api/filetransfer/images?sign=one',
        originalUrl: 'https://cdn.example.com/unmatched-a.png',
        basenameCandidates: ['unmatched-a.png'],
        renderIndex: 0,
        naturalWidth: 900,
        naturalHeight: 600,
        clientWidth: 680,
        clientHeight: 453,
        complete: true,
        isLoaded: true,
      },
      {
        downloadUrl: 'https://www.yuque.com/api/filetransfer/images?sign=two',
        originalUrl: 'https://cdn.example.com/unmatched-b.png',
        basenameCandidates: ['unmatched-b.png'],
        renderIndex: 1,
        naturalWidth: 900,
        naturalHeight: 600,
        clientWidth: 680,
        clientHeight: 453,
        complete: true,
        isLoaded: true,
      },
    ],
    downloadAsset: async (assetUrl, _kind, options = {}) => {
      calls.push({
        assetUrl,
        imageOccurrence: options.imageOccurrence,
        assetAlt: options.assetAlt,
      });
      if (assetUrl.includes('sign=one')) {
        return firstRecoveredLocalPath;
      }
      if (assetUrl.includes('sign=two')) {
        return secondRecoveredLocalPath;
      }
      return '';
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((entry) => [entry.assetUrl.includes('sign=one') ? 'one' : 'two', entry.imageOccurrence, entry.assetAlt]),
    [
      ['one', 0, 'first'],
      ['two', 1, 'second'],
    ],
  );
  assert.match(result.markdown, /!\[first\]\(_assets\/images\/recovered-first\.png\)/);
  assert.match(result.markdown, /!\[second\]\(_assets\/images\/recovered-second\.png\)/);
});

test('shouldAttemptRenderedImageScreenshotFallback keeps screenshot fallback enabled when the image slot can be located', () => {
  assert.equal(
    shouldAttemptRenderedImageScreenshotFallback({
      renderIndex: 4,
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 680,
      clientHeight: 0,
      complete: false,
      isLoaded: false,
    }),
    true,
  );

  assert.equal(
    shouldAttemptRenderedImageScreenshotFallback({
      renderIndex: -1,
      naturalWidth: 800,
      naturalHeight: 600,
      isLoaded: true,
    }),
    false,
  );
});

test('classifyRenderedImageCaptureInspection rejects large blank containers without real visual content', () => {
  const inspection = classifyRenderedImageCaptureInspection({
    naturalWidth: 0,
    naturalHeight: 0,
    clientWidth: 905,
    clientHeight: 449,
    complete: true,
    visibleText: '',
    hasLoadedImage: false,
    hasRenderableVisualNode: false,
    hasMeaningfulText: false,
    hasBackgroundImage: false,
  });

  assert.equal(inspection.rejectionCode, 'blank-container');
  assert.equal(inspection.hasRealContent, false);
});

test('classifyRenderedImageCaptureInspection accepts decoded image content', () => {
  const inspection = classifyRenderedImageCaptureInspection({
    naturalWidth: 1280,
    naturalHeight: 720,
    clientWidth: 905,
    clientHeight: 509,
    complete: true,
    hasLoadedImage: true,
  });

  assert.equal(inspection.rejectionCode, '');
  assert.equal(inspection.hasRealContent, true);
});

function createInteractiveRecoveryHarness() {
  const stats = {
    launchCount: 0,
    openCount: 0,
    configureCount: 0,
    resetCount: 0,
    pageCloseCount: 0,
    browserCloseCount: 0,
  };
  const pages = [];
  const browsers = [];

  return {
    stats,
    pages,
    browsers,
    browserSession: {
      async resetBrowser() {
        stats.resetCount += 1;
      },
    },
    launchBrowserFn: async () => {
      stats.launchCount += 1;
      const browser = {
        _connected: true,
        isConnected() {
          return this._connected;
        },
        async close() {
          this._connected = false;
          stats.browserCloseCount += 1;
        },
      };
      browsers.push(browser);
      return browser;
    },
    openAuthenticatedPageFn: async () => {
      stats.openCount += 1;
      const page = {
        _closed: false,
        gotoCalls: [],
        bringToFrontCalls: 0,
        async goto(url) {
          this.gotoCalls.push(url);
        },
        async bringToFront() {
          this.bringToFrontCalls += 1;
        },
        async waitForTimeout() {},
        isClosed() {
          return this._closed;
        },
        async close() {
          this._closed = true;
          stats.pageCloseCount += 1;
        },
      };
      pages.push(page);
      return page;
    },
    configurePageFn: async () => {
      stats.configureCount += 1;
    },
  };
}

test('ensureDocumentInteractiveRecoverySession reuses one page per document until disposed', async () => {
  const harness = createInteractiveRecoveryHarness();
  const docPlan = {
    absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-a',
  };
  const baseOptions = {
    cookiePath: 'D:/tmp/cookies.json',
    browserSession: harness.browserSession,
    launchBrowserFn: harness.launchBrowserFn,
    openAuthenticatedPageFn: harness.openAuthenticatedPageFn,
    configurePageFn: harness.configurePageFn,
  };

  const firstSession = await ensureDocumentInteractiveRecoverySession(docPlan, baseOptions);
  const reusedSession = await ensureDocumentInteractiveRecoverySession(docPlan, baseOptions);

  assert.equal(firstSession, reusedSession);
  assert.equal(harness.stats.launchCount, 1);
  assert.equal(harness.stats.openCount, 1);
  assert.equal(harness.stats.configureCount, 1);
  assert.equal(harness.stats.resetCount, 1);
  assert.equal(harness.pages[0].gotoCalls.length, 1);
  assert.equal(harness.pages[0].gotoCalls[0], docPlan.absoluteDocUrl);

  await disposeDocumentInteractiveRecoverySession(docPlan);

  assert.equal(docPlan.__interactiveRecoverySession, undefined);
  assert.equal(harness.stats.pageCloseCount, 1);
  assert.equal(harness.stats.browserCloseCount, 1);

  const recreatedSession = await ensureDocumentInteractiveRecoverySession(docPlan, baseOptions);

  assert.notEqual(recreatedSession, firstSession);
  assert.equal(harness.stats.launchCount, 2);
  assert.equal(harness.stats.openCount, 2);
  assert.equal(harness.stats.configureCount, 2);
  assert.equal(harness.stats.resetCount, 2);
  assert.equal(harness.pages[1].gotoCalls.length, 1);
  assert.equal(harness.pages[1].gotoCalls[0], docPlan.absoluteDocUrl);

  await disposeDocumentInteractiveRecoverySession(docPlan);
});

test('captureRenderedImageFallbackInVisibleBrowser reuses the document session and stays in edit mode', async () => {
  const harness = createInteractiveRecoveryHarness();
  const docPlan = {
    absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-b',
  };
  const fallback = {
    originalUrl: 'https://cdn.example.com/slide.png',
    renderIndex: 0,
  };
  const readSkipFlags = [];
  const editSkipFlags = [];
  let readCalls = 0;
  let editCalls = 0;

  const baseOptions = {
    cookiePath: 'D:/tmp/cookies.json',
    browserSession: harness.browserSession,
    launchBrowserFn: harness.launchBrowserFn,
    openAuthenticatedPageFn: harness.openAuthenticatedPageFn,
    configurePageFn: harness.configurePageFn,
    captureReadOnPage: async (_page, passedDocPlan, passedFallback, _targetPath, options) => {
      readCalls += 1;
      readSkipFlags.push(options.skipDocumentOpen);
      assert.equal(passedDocPlan, docPlan);
      assert.equal(passedFallback, fallback);
      return {
        recoveryMode: 'visible-browser-read',
        rejectionCode: 'blank-container',
        rejectionReason: 'blank in read mode',
      };
    },
    captureEditOnPage: async (_page, passedDocPlan, passedFallback, targetPath, options) => {
      editCalls += 1;
      editSkipFlags.push(options.skipEnterEditMode);
      assert.equal(passedDocPlan, docPlan);
      assert.equal(passedFallback, fallback);
      return {
        path: targetPath,
        recoveryMode: 'visible-browser-edit',
        rejectionCode: '',
        rejectionReason: '',
      };
    },
  };

  const firstOutcome = await captureRenderedImageFallbackInVisibleBrowser(
    docPlan,
    fallback,
    'D:/tmp/recovered-first.png',
    baseOptions,
  );
  const secondOutcome = await captureRenderedImageFallbackInVisibleBrowser(
    docPlan,
    fallback,
    'D:/tmp/recovered-second.png',
    baseOptions,
  );

  assert.equal(firstOutcome.path, 'D:/tmp/recovered-first.png');
  assert.equal(secondOutcome.path, 'D:/tmp/recovered-second.png');
  assert.deepEqual(readSkipFlags, [true]);
  assert.deepEqual(editSkipFlags, [false, true]);
  assert.equal(readCalls, 1);
  assert.equal(editCalls, 2);
  assert.equal(harness.stats.launchCount, 1);
  assert.equal(harness.stats.openCount, 1);
  assert.equal(harness.pages[0].gotoCalls.length, 1);
  assert.equal(harness.pages[0].gotoCalls[0], docPlan.absoluteDocUrl);

  await disposeDocumentInteractiveRecoverySession(docPlan);
});

test('pickVisibleDocumentEditEntry prefers the visible top document edit button', () => {
  const picked = pickVisibleDocumentEditEntry([
    {
      domIndex: 0,
      text: '编辑',
      className: 'ant-btn ant-btn-primary larkui-tooltip',
      visible: true,
      rect: { x: 24, y: 486, width: 80, height: 32 },
    },
    {
      domIndex: 1,
      text: '编辑',
      className: 'ant-btn ant-btn-primary larkui-tooltip',
      visible: true,
      rect: { x: 1180, y: 72, width: 80, height: 32 },
    },
    {
      domIndex: 2,
      text: '回复',
      className: 'ant-btn ant-btn-primary larkui-tooltip',
      visible: true,
      rect: { x: 1190, y: 96, width: 80, height: 32 },
    },
  ]);

  assert.equal(picked?.domIndex, 1);
});

test('classifyDocumentEditModeState marks document edit mode as ready only for the main editor surface', () => {
  const ready = classifyDocumentEditModeState({
    visibleDocumentEditorCount: 1,
    visibleToolbarCount: 1,
    visibleMinorEditorCount: 0,
    maxDocumentEditorArea: 640000,
  });
  const commentOnly = classifyDocumentEditModeState({
    visibleDocumentEditorCount: 0,
    visibleToolbarCount: 0,
    visibleMinorEditorCount: 1,
    maxDocumentEditorArea: 0,
  });

  assert.equal(ready.ready, true);
  assert.equal(ready.rejectionCode, '');
  assert.equal(commentOnly.ready, false);
  assert.equal(commentOnly.rejectionCode, 'edit-mode-not-entered');
});

test('pickDocumentEditImageCandidate prefers url matches before falling back to occurrence order', () => {
  const picked = pickDocumentEditImageCandidate(
    [
      {
        domIndex: 0,
        currentSrc: 'https://www.yuque.com/api/filetransfer/images?url=https%3A%2F%2Fcdn.example.com%2Fother.png&sign=a',
        src: '',
        dataSrc: '',
        visible: true,
      },
      {
        domIndex: 1,
        currentSrc: 'https://www.yuque.com/api/filetransfer/images?url=https%3A%2F%2Fcdn.example.com%2Ftarget.png&sign=b',
        src: '',
        dataSrc: '',
        visible: true,
      },
    ],
    {
      originalUrl: 'https://cdn.example.com/target.png',
      renderIndex: 0,
    },
  );

  assert.equal(picked?.domIndex, 1);
});

test('pickDocumentEditImageCandidate prefers basename matches before occurrence or render index', () => {
  const picked = pickDocumentEditImageCandidate(
    [
      {
        domIndex: 0,
        currentSrc: 'https://cdn.example.com/first-visible.png',
        src: '',
        dataSrc: '',
        alt: 'first',
        visible: true,
        clientWidth: 640,
        clientHeight: 360,
      },
      {
        domIndex: 1,
        currentSrc: 'blob:https://www.yuque.com/current',
        src: '',
        dataSrc: 'https://assets.example.com/path/to/target-image.png?x=1',
        alt: 'target',
        visible: true,
        clientWidth: 640,
        clientHeight: 360,
      },
    ],
    {
      basenameCandidates: ['target-image.png'],
      imageOccurrence: 0,
      renderIndex: 0,
    },
  );

  assert.equal(picked?.domIndex, 1);
});

test('pickDocumentEditImageCandidate uses renderable occurrence ordering and skips placeholder candidates', () => {
  const picked = pickDocumentEditImageCandidate(
    [
      {
        domIndex: 0,
        currentSrc: 'https://assets.example.com/icon.png',
        src: '',
        dataSrc: '',
        alt: 'icon',
        visible: true,
        clientWidth: 24,
        clientHeight: 24,
      },
      {
        domIndex: 1,
        currentSrc: 'https://assets.example.com/first-body.png',
        src: '',
        dataSrc: '',
        alt: 'first body',
        visible: true,
        clientWidth: 680,
        clientHeight: 420,
      },
      {
        domIndex: 2,
        currentSrc: 'https://assets.example.com/second-body.png',
        src: '',
        dataSrc: '',
        alt: 'second body',
        visible: true,
        clientWidth: 680,
        clientHeight: 420,
      },
    ],
    {
      imageOccurrence: 1,
      renderIndex: 0,
    },
  );

  assert.equal(picked?.domIndex, 2);
});

test('pickDocumentEditImageCandidate falls back to alt matching before render index', () => {
  const picked = pickDocumentEditImageCandidate(
    [
      {
        domIndex: 0,
        currentSrc: 'https://assets.example.com/cover.png',
        src: '',
        dataSrc: '',
        alt: 'cover image',
        visible: true,
        clientWidth: 680,
        clientHeight: 420,
      },
      {
        domIndex: 1,
        currentSrc: 'https://assets.example.com/revenue.png',
        src: '',
        dataSrc: '',
        alt: 'Revenue chart Q4',
        visible: true,
        clientWidth: 680,
        clientHeight: 420,
      },
    ],
    {
      assetAlt: 'Revenue chart',
      renderIndex: 0,
    },
  );

  assert.equal(picked?.domIndex, 1);
});

test('pickDocumentEditImageCandidate keeps render index as the final fallback', () => {
  const picked = pickDocumentEditImageCandidate(
    [
      {
        domIndex: 0,
        currentSrc: '',
        src: '',
        dataSrc: '',
        alt: '',
        visible: true,
        clientWidth: 680,
        clientHeight: 420,
      },
      {
        domIndex: 1,
        currentSrc: '',
        src: '',
        dataSrc: '',
        alt: '',
        visible: true,
        clientWidth: 680,
        clientHeight: 420,
      },
    ],
    {
      renderIndex: 1,
    },
  );

  assert.equal(picked?.domIndex, 1);
});

test('pickDocumentEditCaptureTargetCandidate prefers the smallest single-image container over shared ancestors', () => {
  const picked = pickDocumentEditCaptureTargetCandidate(
    [
      {
        key: 0,
        role: 'img',
        visible: true,
        containsBoundImage: true,
        width: 640,
        height: 360,
        area: 230400,
        areaRatio: 1,
        renderableImageCount: 1,
        totalImageCount: 1,
      },
      {
        key: 1,
        role: 'figure',
        visible: true,
        containsBoundImage: true,
        width: 680,
        height: 420,
        area: 285600,
        areaRatio: 1.24,
        renderableImageCount: 1,
        totalImageCount: 1,
      },
      {
        key: 2,
        role: 'list-item',
        visible: true,
        containsBoundImage: true,
        width: 1600,
        height: 1200,
        area: 1920000,
        areaRatio: 8.33,
        renderableImageCount: 3,
        totalImageCount: 3,
      },
    ],
    {
      boundClientWidth: 640,
      boundClientHeight: 360,
    },
  );

  assert.equal(picked.ambiguous, false);
  assert.equal(picked.candidate?.key, 0);
});

test('pickDocumentEditCaptureTargetCandidate rejects oversized shared containers when no single-image target exists', () => {
  const picked = pickDocumentEditCaptureTargetCandidate(
    [
      {
        key: 0,
        role: 'list-item',
        visible: true,
        containsBoundImage: true,
        width: 1800,
        height: 1200,
        area: 2160000,
        areaRatio: 9.37,
        renderableImageCount: 2,
        totalImageCount: 2,
      },
      {
        key: 1,
        role: 'ancestor',
        visible: true,
        containsBoundImage: true,
        width: 2200,
        height: 1400,
        area: 3080000,
        areaRatio: 13.37,
        renderableImageCount: 2,
        totalImageCount: 2,
      },
    ],
    {
      boundClientWidth: 640,
      boundClientHeight: 360,
    },
  );

  assert.equal(picked.candidate, null);
  assert.equal(picked.ambiguous, true);
});

test('classifyDocumentEditImageCaptureInspection keeps blank edit-mode captures rejected', () => {
  const blankContainer = classifyDocumentEditImageCaptureInspection({
    naturalWidth: 0,
    naturalHeight: 0,
    clientWidth: 905,
    clientHeight: 449,
    complete: true,
    hasLoadedImage: false,
    hasRenderableVisualNode: false,
    hasMeaningfulText: false,
    hasBackgroundImage: false,
  });
  const editBlankCapture = classifyDocumentEditImageCaptureInspection({
    ...blankContainer,
    rejectionCode: 'blank-capture',
  });

  assert.equal(blankContainer.rejectionCode, 'edit-blank-container');
  assert.equal(editBlankCapture.rejectionCode, 'edit-blank-capture');
});

test('captureRenderedImageFallbackInEditModeOnPage scrolls and waits before inspecting the target image', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-edit-order-'));
  const targetPath = path.join(tempRoot, 'capture.png');
  const callOrder = [];
  const imageHandle = { id: 'ordered-image-handle' };
  const captureHandle = {
    id: 'ordered-capture-handle',
    async evaluate() {},
  };
  const page = {
    async waitForTimeout() {},
  };

  try {
    const outcome = await captureRenderedImageFallbackInEditModeOnPage(
      page,
      {
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-c',
      },
      {
        basenameCandidates: ['target-image.png'],
        renderIndex: 0,
      },
      targetPath,
      {
        skipEnterEditMode: true,
        collectDocumentEditImageCandidatesFn: async () => [
          {
            domIndex: 7,
            currentSrc: 'https://assets.example.com/target-image.png',
            src: '',
            dataSrc: '',
            alt: 'target image',
            visible: true,
            clientWidth: 640,
            clientHeight: 360,
          },
        ],
        getDocumentEditImageHandleFn: async () => imageHandle,
        scrollDocumentEditImageHandleIntoViewFn: async () => {
          callOrder.push('scroll');
        },
        waitForDocumentEditImageHandleReadyFn: async () => {
          callOrder.push('wait');
          return true;
        },
        inspectDocumentEditImageHandleFn: async () => ({
          exists: true,
          currentSrc: 'https://assets.example.com/target-image.png',
          src: '',
          dataSrc: '',
          alt: 'target image',
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          visible: true,
        }),
        inspectDocumentEditImageHandleCaptureTargetFn: async () => {
          callOrder.push('inspect');
          return {
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
            hasLoadedImage: true,
            hasRenderableVisualNode: false,
            hasMeaningfulText: false,
            hasBackgroundImage: false,
          };
        },
        getDocumentEditImageHandleCaptureTargetFn: async () => ({
          asElement() {
            return captureHandle;
          },
        }),
        captureElementScreenshotFn: async (_page, _handle, screenshotPath) => {
          callOrder.push('capture');
          fs.writeFileSync(screenshotPath, 'rendered-image', 'utf8');
          return screenshotPath;
        },
      },
    );

    assert.equal(outcome.path, targetPath);
    assert.deepEqual(callOrder.slice(0, 3), ['scroll', 'wait', 'inspect']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('captureRenderedImageFallbackInEditModeOnPage reuses the matched image handle throughout edit-mode capture', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-edit-handle-'));
  const targetPath = path.join(tempRoot, 'capture.png');
  const imageHandle = { id: 'matched-image-handle' };
  const captureHandle = {
    id: 'capture-target-handle',
    async evaluate() {},
  };
  const seen = {
    scroll: [],
    wait: [],
    usable: [],
    inspect: [],
    inspectCapture: [],
    getCapture: [],
    capture: [],
  };
  const page = {
    async waitForTimeout() {},
  };

  try {
    const outcome = await captureRenderedImageFallbackInEditModeOnPage(
      page,
      {
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-d',
      },
      {
        originalUrl: 'https://cdn.example.com/target-image.png',
        basenameCandidates: ['target-image.png'],
        renderIndex: 0,
      },
      targetPath,
      {
        skipEnterEditMode: true,
        collectDocumentEditImageCandidatesFn: async () => [
          {
            domIndex: 4,
            currentSrc: 'https://assets.example.com/target-image.png',
            src: '',
            dataSrc: '',
            alt: 'target image',
            visible: true,
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
          },
        ],
        getDocumentEditImageHandleFn: async () => imageHandle,
        isDocumentEditImageHandleUsableFn: async (handle) => {
          seen.usable.push(handle);
          return true;
        },
        scrollDocumentEditImageHandleIntoViewFn: async (_page, handle) => {
          seen.scroll.push(handle);
        },
        waitForDocumentEditImageHandleReadyFn: async (_page, handle) => {
          seen.wait.push(handle);
          return true;
        },
        inspectDocumentEditImageHandleFn: async (_page, handle) => {
          seen.inspect.push(handle);
          return {
            exists: true,
            currentSrc: 'https://assets.example.com/target-image.png',
            src: '',
            dataSrc: '',
            alt: 'target image',
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
            visible: true,
          };
        },
        inspectDocumentEditImageHandleCaptureTargetFn: async (_page, handle) => {
          seen.inspectCapture.push(handle);
          return {
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
            hasLoadedImage: true,
            hasRenderableVisualNode: false,
            hasMeaningfulText: false,
            hasBackgroundImage: false,
          };
        },
        getDocumentEditImageHandleCaptureTargetFn: async (_page, handle) => {
          seen.getCapture.push(handle);
          return {
            asElement() {
              return captureHandle;
            },
          };
        },
        captureElementScreenshotFn: async (_page, handle, screenshotPath) => {
          seen.capture.push(handle);
          fs.writeFileSync(screenshotPath, 'rendered-image', 'utf8');
          return screenshotPath;
        },
      },
    );

    assert.equal(outcome.path, targetPath);
    assert.deepEqual(seen.scroll, [imageHandle]);
    assert.deepEqual(seen.wait, [imageHandle]);
    assert.deepEqual(seen.usable, [imageHandle]);
    assert.deepEqual(seen.inspect, [imageHandle, imageHandle]);
    assert.deepEqual(seen.inspectCapture, [imageHandle, imageHandle]);
    assert.deepEqual(seen.getCapture, [imageHandle]);
    assert.deepEqual(seen.capture, [captureHandle]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('captureRenderedImageFallbackInEditModeOnPage does not reject a weak live snapshot before the target identity becomes available', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-edit-weak-snapshot-'));
  const targetPath = path.join(tempRoot, 'capture.png');
  const imageHandle = { id: 'weak-snapshot-image-handle' };
  const captureHandle = {
    id: 'weak-snapshot-capture-handle',
    async evaluate() {},
  };
  let inspectCalls = 0;
  const page = {
    async waitForTimeout() {},
  };

  try {
    const outcome = await captureRenderedImageFallbackInEditModeOnPage(
      page,
      {
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-weak',
      },
      {
        originalUrl: 'https://cdn.example.com/target-image.png',
        basenameCandidates: ['target-image.png'],
        assetAlt: 'target image',
        renderIndex: 0,
      },
      targetPath,
      {
        skipEnterEditMode: true,
        collectDocumentEditImageCandidatesFn: async () => [
          {
            domIndex: 3,
            currentSrc: 'https://assets.example.com/target-image.png',
            src: '',
            dataSrc: '',
            alt: 'target image',
            visible: true,
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
          },
        ],
        getDocumentEditImageHandleFn: async () => imageHandle,
        isDocumentEditImageHandleUsableFn: async () => true,
        scrollDocumentEditImageHandleIntoViewFn: async () => {},
        waitForDocumentEditImageHandleReadyFn: async () => true,
        inspectDocumentEditImageHandleFn: async () => {
          inspectCalls += 1;
          if (inspectCalls === 1) {
            return {
              exists: true,
              currentSrc: '',
              src: '',
              dataSrc: '',
              alt: '',
              naturalWidth: 0,
              naturalHeight: 0,
              clientWidth: 0,
              clientHeight: 0,
              complete: false,
              visible: true,
            };
          }
          return {
            exists: true,
            currentSrc: 'https://assets.example.com/target-image.png',
            src: '',
            dataSrc: '',
            alt: 'target image',
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
            visible: true,
          };
        },
        inspectDocumentEditImageHandleCaptureTargetFn: async () => ({
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          hasLoadedImage: true,
          hasRenderableVisualNode: false,
          hasMeaningfulText: false,
          hasBackgroundImage: false,
        }),
        getDocumentEditImageHandleCaptureTargetFn: async () => ({
          asElement() {
            return captureHandle;
          },
        }),
        captureElementScreenshotFn: async (_page, _handle, screenshotPath) => {
          fs.writeFileSync(screenshotPath, 'rendered-image', 'utf8');
          return screenshotPath;
        },
      },
    );

    assert.equal(outcome.path, targetPath);
    assert.equal(outcome.rejectionCode, '');
    assert.equal(inspectCalls, 2);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('captureRenderedImageFallbackInEditModeOnPage rematches once by identity when the first handle becomes unusable', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-edit-rematch-'));
  const targetPath = path.join(tempRoot, 'capture.png');
  const firstHandle = { id: 'target-before-reorder' };
  const secondHandle = { id: 'target-after-reorder' };
  const secondCaptureHandle = {
    id: 'capture-after-reorder',
    async evaluate() {},
  };
  let collectCalls = 0;
  let handleCalls = 0;
  const capturedHandles = [];
  const page = {
    async waitForTimeout() {},
  };

  try {
    const outcome = await captureRenderedImageFallbackInEditModeOnPage(
      page,
      {
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-e',
      },
      {
        basenameCandidates: ['target-image.png'],
        imageOccurrence: 0,
        renderIndex: 2,
      },
      targetPath,
      {
        skipEnterEditMode: true,
        collectDocumentEditImageCandidatesFn: async () => {
          collectCalls += 1;
          if (collectCalls === 1) {
            return [
              {
                domIndex: 0,
                currentSrc: 'https://assets.example.com/cover.png',
                src: '',
                dataSrc: '',
                alt: 'cover',
                visible: true,
                naturalWidth: 1200,
                naturalHeight: 800,
                clientWidth: 600,
                clientHeight: 400,
                complete: true,
              },
              {
                domIndex: 2,
                currentSrc: 'https://assets.example.com/target-image.png',
                src: '',
                dataSrc: '',
                alt: 'target image',
                visible: true,
                naturalWidth: 1280,
                naturalHeight: 720,
                clientWidth: 640,
                clientHeight: 360,
                complete: true,
              },
            ];
          }
          return [
            {
              domIndex: 0,
              currentSrc: 'https://assets.example.com/target-image.png',
              src: '',
              dataSrc: '',
              alt: 'target image',
              visible: true,
              naturalWidth: 1280,
              naturalHeight: 720,
              clientWidth: 640,
              clientHeight: 360,
              complete: true,
            },
            {
              domIndex: 1,
              currentSrc: 'https://assets.example.com/cover.png',
              src: '',
              dataSrc: '',
              alt: 'cover',
              visible: true,
              naturalWidth: 1200,
              naturalHeight: 800,
              clientWidth: 600,
              clientHeight: 400,
              complete: true,
            },
          ];
        },
        getDocumentEditImageHandleFn: async (_page, candidate) => {
          handleCalls += 1;
          return handleCalls === 1 ? firstHandle : secondHandle;
        },
        isDocumentEditImageHandleUsableFn: async (handle) => handle !== firstHandle,
        scrollDocumentEditImageHandleIntoViewFn: async () => {},
        waitForDocumentEditImageHandleReadyFn: async () => true,
        inspectDocumentEditImageHandleFn: async (_page, handle) => ({
          exists: true,
          currentSrc:
            handle === firstHandle
              ? 'https://assets.example.com/target-image.png'
              : 'https://assets.example.com/target-image.png',
          src: '',
          dataSrc: '',
          alt: 'target image',
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          visible: true,
        }),
        inspectDocumentEditImageHandleCaptureTargetFn: async () => ({
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          hasLoadedImage: true,
          hasRenderableVisualNode: false,
          hasMeaningfulText: false,
          hasBackgroundImage: false,
        }),
        getDocumentEditImageHandleCaptureTargetFn: async (_page, handle) => ({
          asElement() {
            return handle === secondHandle
              ? secondCaptureHandle
              : {
                  id: 'unexpected-first-capture',
                  async evaluate() {},
                };
          },
        }),
        captureElementScreenshotFn: async (_page, handle, screenshotPath) => {
          capturedHandles.push(handle);
          fs.writeFileSync(screenshotPath, 'rendered-image', 'utf8');
          return screenshotPath;
        },
      },
    );

    assert.equal(outcome.path, targetPath);
    assert.equal(collectCalls, 2);
    assert.equal(handleCalls, 2);
    assert.deepEqual(capturedHandles, [secondCaptureHandle]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('captureRenderedImageFallbackInEditModeOnPage rejects screenshots when the bound edit image no longer matches the requested identity', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-edit-mismatch-'));
  const targetPath = path.join(tempRoot, 'capture.png');
  const imageHandle = { id: 'mismatched-image' };
  let captureCalls = 0;
  const page = {
    async waitForTimeout() {},
  };

  try {
    const outcome = await captureRenderedImageFallbackInEditModeOnPage(
      page,
      {
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-f',
      },
      {
        originalUrl: 'https://cdn.example.com/target-image.png',
        basenameCandidates: ['target-image.png'],
        assetAlt: 'target image',
        renderIndex: 0,
      },
      targetPath,
      {
        skipEnterEditMode: true,
        collectDocumentEditImageCandidatesFn: async () => [
          {
            domIndex: 0,
            currentSrc: '',
            src: '',
            dataSrc: '',
            alt: '',
            visible: true,
            clientWidth: 640,
            clientHeight: 360,
          },
        ],
        getDocumentEditImageHandleFn: async () => imageHandle,
        isDocumentEditImageHandleUsableFn: async () => true,
        scrollDocumentEditImageHandleIntoViewFn: async () => {},
        waitForDocumentEditImageHandleReadyFn: async () => true,
        inspectDocumentEditImageHandleFn: async () => ({
          exists: true,
          currentSrc: 'https://assets.example.com/first-image.png',
          src: '',
          dataSrc: '',
          alt: 'first image',
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          visible: true,
        }),
        captureElementScreenshotFn: async () => {
          captureCalls += 1;
          return targetPath;
        },
      },
    );

    assert.equal(outcome.path, '');
    assert.equal(outcome.rejectionCode, 'edit-image-identity-mismatch');
    assert.match(outcome.rejectionReason, /actual current src: "https:\/\/assets\.example\.com\/first-image\.png"/);
    assert.match(outcome.rejectionReason, /actual alt: "first image"/);
    assert.equal(captureCalls, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('captureRenderedImageFallbackInEditModeOnPage rejects a duplicate-hash screenshot when a different slot would silently reuse the first image', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-edit-duplicate-hash-'));
  const firstTargetPath = path.join(tempRoot, 'first.png');
  const secondTargetPath = path.join(tempRoot, 'second.png');
  const docPlan = {
    absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-duplicate',
  };
  const page = {
    async waitForTimeout() {},
  };

  const runCapture = async (fallback, targetPath, imageHandle, captureHandle) =>
    await captureRenderedImageFallbackInEditModeOnPage(
      page,
      docPlan,
      fallback,
      targetPath,
      {
        skipEnterEditMode: true,
        collectDocumentEditImageCandidatesFn: async () => [
          {
            domIndex: 0,
            currentSrc: fallback.originalUrl,
            src: '',
            dataSrc: '',
            alt: fallback.assetAlt,
            visible: true,
            naturalWidth: 1280,
            naturalHeight: 720,
            clientWidth: 640,
            clientHeight: 360,
            complete: true,
          },
        ],
        getDocumentEditImageHandleFn: async () => imageHandle,
        isDocumentEditImageHandleUsableFn: async () => true,
        scrollDocumentEditImageHandleIntoViewFn: async () => {},
        waitForDocumentEditImageHandleReadyFn: async () => true,
        inspectDocumentEditImageHandleFn: async () => ({
          exists: true,
          currentSrc: fallback.originalUrl,
          src: '',
          dataSrc: '',
          alt: fallback.assetAlt,
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          visible: true,
        }),
        inspectDocumentEditImageHandleCaptureTargetFn: async () => ({
          naturalWidth: 1280,
          naturalHeight: 720,
          clientWidth: 640,
          clientHeight: 360,
          complete: true,
          hasLoadedImage: true,
          hasRenderableVisualNode: false,
          hasMeaningfulText: false,
          hasBackgroundImage: false,
          selectedCandidateKey: 0,
        }),
        getDocumentEditImageHandleCaptureTargetFn: async () => ({
          asElement() {
            return captureHandle;
          },
        }),
        captureElementScreenshotFn: async (_page, _handle, screenshotPath) => {
          fs.writeFileSync(screenshotPath, 'same-image-binary', 'utf8');
          return screenshotPath;
        },
      },
    );

  try {
    const firstOutcome = await runCapture(
      {
        rawUrl: 'https://cdn.example.com/slot-a-raw.png',
        originalUrl: 'https://cdn.example.com/slot-a.png',
        basenameCandidates: ['slot-a.png'],
        assetAlt: 'slot a',
        imageOccurrence: 0,
        renderIndex: 0,
      },
      firstTargetPath,
      { id: 'first-image-handle' },
      {
        id: 'first-capture-handle',
        async evaluate() {},
      },
    );
    const secondOutcome = await runCapture(
      {
        rawUrl: 'https://cdn.example.com/slot-b-raw.png',
        originalUrl: 'https://cdn.example.com/slot-b.png',
        basenameCandidates: ['slot-b.png'],
        assetAlt: 'slot b',
        imageOccurrence: 1,
        renderIndex: 1,
      },
      secondTargetPath,
      { id: 'second-image-handle' },
      {
        id: 'second-capture-handle',
        async evaluate() {},
      },
    );

    assert.equal(firstOutcome.path, firstTargetPath);
    assert.equal(secondOutcome.path, '');
    assert.equal(secondOutcome.rejectionCode, 'edit-duplicate-image-suspected');
    assert.match(secondOutcome.rejectionReason, /wrong first image/);
    assert.equal(fs.existsSync(firstTargetPath), true);
    assert.equal(fs.existsSync(secondTargetPath), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('localizeFailureRecord translates edit-image-identity-mismatch fallback failures', () => {
  const localized = localizeFailureRecord({
    phase: 'asset-warning',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://cdn.example.com/target-image.png because The original image download failed (403 Forbidden), and the matching Yuque-rendered image fallback was rejected because the edit-mode recovery matched a different image than the requested slot and was rejected to avoid saving the wrong export image (natural size: 1280x720, client size: 640x360, complete: true, actual current src: "https://assets.example.com/first-image.png", actual alt: "first image"). The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /currentSrc=https:\/\/assets\.example\.com\/first-image\.png/);
  assert.match(localized.error_message, /alt=first image/);
});

test('localizeFailureRecord translates edit-duplicate-image-suspected fallback failures', () => {
  const localized = localizeFailureRecord({
    phase: 'asset-warning',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://cdn.example.com/slot-b.png because The original image download failed (403 Forbidden), and the matching Yuque-rendered image fallback was rejected because the edit-mode recovery screenshot matched a previously exported image with different identity and was rejected to avoid silently saving the wrong first image (natural size: 1280x720, client size: 640x360, complete: true, screenshot bytes: 244690, content hash: "abc123", actual current src: "https://cdn.example.com/slot-b.png", actual alt: "slot b", duplicate target path: "D:/tmp/slot-a.png"). The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /内容哈希=abc123/);
  assert.match(localized.error_message, /重复目标=D:\/tmp\/slot-a\.png/);
});

test('captureRenderedImageFallbackToLocalAsset removes a stale same-name image when recovery still fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-stale-image-cleanup-'));
  const assetDir = path.join(root, '_assets', 'images');
  fs.mkdirSync(assetDir, { recursive: true });
  const stalePath = path.join(assetDir, 'target-image.png');
  fs.writeFileSync(stalePath, 'stale-image', 'utf8');

  try {
    const recoveredPath = await captureRenderedImageFallbackToLocalAsset(
      {
        assets: { images: assetDir },
        assetCache: new Map(),
        assetNames: new Map(),
      },
      {
        node: { name: 'Demo' },
        absoluteDocUrl: 'https://www.yuque.com/demo/book/doc-cleanup',
      },
      {
        downloadUrl: 'https://www.yuque.com/go/proxy-image',
        originalUrl: 'https://cdn.example.com/target-image.png',
        renderIndex: 0,
      },
      'target-image.png',
    );

    assert.equal(recoveredPath, '');
    assert.equal(fs.existsSync(stalePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isRenderedImageBlankCapture rejects tiny low-information screenshots when no real content exists', () => {
  assert.equal(
    isRenderedImageBlankCapture(
      {
        naturalWidth: 0,
        naturalHeight: 0,
        clientWidth: 905,
        clientHeight: 449,
        complete: true,
        hasLoadedImage: false,
        hasRenderableVisualNode: false,
        hasMeaningfulText: false,
        hasBackgroundImage: false,
      },
      {
        captureBytes: 2301,
      },
    ),
    true,
  );
});

test('buildExportBrowserLaunchOptions uses the same persistent profile dir as login flow', () => {
  const config = {
    browserPath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cookiePath: 'D:/tmp/yuque/cookies.json',
  };

  const options = buildExportBrowserLaunchOptions(config, {
    headless: true,
  });

  assert.equal(options.browserPath, config.browserPath);
  assert.equal(options.cookiePath, config.cookiePath);
  assert.equal(options.loginProfileDir, getLoginProfileDir(config.cookiePath));
});

test('writeDatatableObsidianDatasetFiles replaces existing records content without relying on rename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-dataset-refresh-'));
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
  fs.writeFileSync(sidecarFiles.pngPath, 'png', 'utf8');

  const buildDatatable = (title) => ({
    title: 'Tasks',
    partial: false,
    columns: [{ key: 'col_1', name: 'Name' }],
    rows: [
      {
        cells: [{ columnKey: 'col_1', text: title }],
      },
    ],
  });

  const baseOptions = {
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
  };

  const first = writeDatatableObsidianDatasetFiles(buildDatatable('Task A'), baseOptions);
  const recordsDir = path.dirname(first.records[0].mdPath);
  const stalePath = path.join(recordsDir, 'stale.tmp');
  fs.writeFileSync(stalePath, 'stale', 'utf8');

  const second = writeDatatableObsidianDatasetFiles(buildDatatable('Task B'), baseOptions);
  const recordMd = fs.readFileSync(second.records[0].mdPath, 'utf8');
  const leftoverTempDirs = fs
    .readdirSync(path.dirname(second.basePath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.records-writing-'));

  assert.equal(fs.existsSync(stalePath), false);
  assert.match(recordMd, /"title": "Task B"/);
  assert.doesNotMatch(recordMd, /"title": "Task A"/);
  assert.equal(leftoverTempDirs.length, 0);
});

test('executeComplexArtifactPlan retries a crashed worker once and then succeeds', async () => {
  const plan = planComplexArtifactWork({
    markdown: '# Demo\n\n[此处为语雀卡片，点击链接查看](https://www.yuque.com/docs/123)',
    complexBlockMode: 'auto',
    preparedBoards: [],
  });

  let attempts = 0;
  const artifacts = await executeComplexArtifactPlan(plan, {
    runAttempt: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('Complex artifact worker crashed with exit code 3221226505 (0xC0000409).');
        error.exitCode = 3221226505;
        error.isWorkerCrash = true;
        throw error;
      }
      return {
        ...plan.baseArtifacts,
        encryptedTexts: ['restored'],
      };
    },
  });

  assert.equal(attempts, 2);
  assert.equal(artifacts.workerStatus, 'retried-success');
  assert.equal(artifacts.retryCount, 1);
  assert.deepEqual(artifacts.encryptedTexts, ['restored']);
});

test('executeComplexArtifactPlan degrades a crashed worker while preserving precomputed board exports', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-board-plan-'));
  const bookDir = path.join(root, 'Book');
  const boards = prepareStructuredBoards(
    {
      type: 'Doc',
      format: 'lake',
      content: `<card type="block" name="board" value="data:${encodeURIComponent(
        JSON.stringify({ diagramData: createMindmapDiagram() }),
      )}" />`,
    },
    {
      targetMdPath: path.join(bookDir, 'Demo.md'),
      node: { name: 'Demo' },
    },
    {
      bookDir,
      assets: {
        boards: path.join(bookDir, '_assets', 'boards'),
      },
    },
    {
      complexBlockMode: 'auto',
      // 本用例专门验证截图工作线程崩溃时仍保留结构化画板，因此显式要求补充快照。
      diagramSnapshotMode: 'supplemental',
    },
  );
  const plan = planComplexArtifactWork({
    markdown: '# Demo\n\ncontent',
    rewrittenMarkdown: '# Demo\n\ncontent',
    complexBlockMode: 'auto',
    preparedBoards: boards,
  });

  const artifacts = await executeComplexArtifactPlan(plan, {
    runAttempt: async () => {
      const error = new Error('Complex artifact worker crashed with exit code 3221226505 (0xC0000409).');
      error.exitCode = 3221226505;
      error.isWorkerCrash = true;
      throw error;
    },
  });

  assert.equal(artifacts.workerStatus, 'degraded');
  assert.equal(artifacts.retryCount, 1);
  assert.match(artifacts.crashExitCode, /0xC0000409/);
  assert.equal(artifacts.boards.length, 1);
  assert.equal(artifacts.boards[0].structuredExport, true);
  assert.match(artifacts.boards[0].markdown, /根节点/);
});
