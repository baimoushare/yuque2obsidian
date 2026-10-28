import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { exportDocumentSources, scanDocumentSources } from '../src/exporter.js';

test('来源扫描取消时不把部分条目标准化为可替换的列表', async () => {
  let stopRequested = false;
  const result = await scanDocumentSources({ cookiePath: 'unused' }, {
    pageSize: 1,
    maxItems: 10,
    client: {
      async getJson() {
        return { data: { totalItems: 2, actions: [{ id: 1, target_type: 'Book' }] } };
      },
    },
    shouldStop: () => stopRequested,
    onProgress: () => {
      stopRequested = true;
    },
  });

  assert.deepEqual(result, {
    complete: false,
    cancelled: true,
    totalItems: 2,
    completedItems: 1,
    pageCount: 1,
  });
  assert.equal('documents' in result, false);
  assert.equal('excluded' in result, false);
});

test('来源导出扫描阶段取消时不创建或覆盖导出状态与索引', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-scan-cancel-'));
  try {
    const emitted = [];
    let action = 'run';
    const result = await exportDocumentSources({
      cookiePath: 'unused',
      outputDir: temporaryDir,
      selectedDocumentKeys: [],
      jobControlPath: '',
    }, (event) => emitted.push(event), {
      client: {
        async getJson() {
          action = 'stop';
          return { data: { totalItems: 2, actions: [{ id: 1, target_type: 'Book' }] } };
        },
      },
      control: {
        getAction: () => action,
        clear() {},
      },
      onProgress: () => {
        action = 'stop';
      },
    });

    assert.equal(result.status, 'cancelled');
    assert.equal(result.complete, false);
    assert.equal(fs.readdirSync(temporaryDir).length, 0);
    assert.equal(emitted.at(-1).status, 'cancelled');
    assert.equal(emitted.some((event) => Array.isArray(event.documents)), false);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

function makeClient(detail = {}) {
  const calls = [];
  return {
    calls,
    async getJson(url) {
      calls.push({ kind: 'json', url });
      assert.match(url, /^https:\/\/www\.yuque\.com\/api\/docs\//);
      if (detail.requestError) throw detail.requestError;
      return {
        data: {
          id: url.includes('/doc-2?') ? 124 : 123,
          type: 'Doc',
          content_updated_at: 'version-2',
          content: '<p>demo body</p>',
          ...detail,
        },
      };
    },
    async get(url) {
      calls.push({ kind: 'markdown', url });
      assert.match(url, /^https:\/\/www\.yuque\.com\/owner\/book\/doc-[12]\/markdown\?/);
      return {
        data: [
          '# Demo',
          '',
          '![diagram](https://cdn.nlark.com/yuque/0/2026/png/diagram.png)',
          '',
          '[manual](https://cdn.nlark.com/yuque/attachments/manual.pdf)',
        ].join('\n'),
      };
    },
    async request(options) {
      calls.push({ kind: 'asset', options });
      assert.equal(options.skipAuth, true);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.headers.Cookie, '');
      if (detail.assetError) throw new Error(detail.assetError);
      const isImage = options.url.endsWith('.png');
      return {
        status: 200,
        data: Buffer.from(isImage ? 'png bytes' : 'pdf bytes'),
        headers: { 'content-type': isImage ? 'image/png' : 'application/pdf' },
      };
    },
  };
}

function sourceEntry() {
  return {
    itemType: 'document',
    documentKey: 'yuque:book-1:doc-1',
    documentId: '123',
    documentSlug: 'doc-1',
    documentType: 'Doc',
    bookId: 'book-1',
    bookName: 'Book',
    owner: 'owner',
    title: 'Demo',
    canonicalUrl: 'https://www.yuque.com/owner/book/doc-1',
    sourceVersion: 'version-2',
    sourceType: 'favorite',
    actionOption: 'doc',
    sourceRelations: [
      { sourceType: 'favorite', actionOption: 'doc' },
      { sourceType: 'collaboration', actionOption: 'collaboration_Doc_doc' },
    ],
    status: 'unverified',
  };
}

function secondSourceEntry() {
  return {
    ...sourceEntry(),
    documentKey: 'yuque:book-1:doc-2',
    documentId: '124',
    documentSlug: 'doc-2',
    canonicalUrl: 'https://www.yuque.com/owner/book/doc-2',
    title: 'Demo second',
  };
}

test('显式单篇来源导出复用只读详情/正文链路并本地化无凭据图片与附件', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-export-'));
  const client = makeClient();
  try {
    const report = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: true,
      downloadAttachments: true,
      incrementalExport: true,
    }, () => {}, {
      client,
      sourceResult: {
        complete: true,
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });

    assert.equal(report.status, 'success');
    assert.deepEqual(report.totals, {
      listed: 1,
      planned: 1,
      exported: 1,
      skipped: 0,
      failed: 0,
      authenticationRequired: 0,
      restricted: 0,
      unavailable: 0,
      unsupported: 0,
      incomplete: 0,
      protected: 0,
    });
    assert.equal(report.documents[0].sourceRelations.length, 2);
    assert.equal(Object.hasOwn(report, 'indexes'), false);
    assert.equal(path.basename(path.dirname(report.documents[0].path)), '收藏');
    assert.equal(report.documents[0].path.includes(`${path.sep}文档${path.sep}`), false);
    assert.equal(fs.existsSync(path.join(report.contentOutputDir, '索引')), false);
    assert.equal(client.calls.filter((call) => call.kind === 'asset').length, 2);
    const markdown = fs.readFileSync(report.documents[0].path, 'utf8');
    assert.match(markdown, /!\[diagram\]\(_assets\/123\/images\//);
    assert.match(markdown, /\[manual\]\(_assets\/123\/files\//);
    assert.equal(fs.existsSync(report.reportPath), true);

    const nextClient = makeClient();
    const next = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: true,
      downloadAttachments: true,
      incrementalExport: true,
    }, () => {}, {
      client: nextClient,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });
    assert.equal(next.totals.skipped, 1);
    assert.equal(nextClient.calls.length, 0);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('来源导出遵循 Obsidian 目录设置，切换目录后不复用旧目标路径', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-vault-'));
  const outputDir = path.join(temporaryDir, 'reports');
  const vaultPath = path.join(temporaryDir, 'vault');
  const emitted = [];
  const config = {
    outputDir,
    selectedDocumentKeys: ['yuque:book-1:doc-1'],
    incrementalExport: true,
    downloadImages: true,
    downloadAttachments: true,
  };
  const sourceResult = {
    complete: true,
    totalItems: 1,
    documents: [sourceEntry()],
    excluded: [],
  };
  try {
    // 先模拟旧版本只写输出目录；改成直写仓库后，旧文件必须原样保留。
    const oldReport = await exportDocumentSources(config, () => {}, { client: makeClient(), sourceResult });
    const oldPath = oldReport.documents[0].path;
    const oldContent = fs.readFileSync(oldPath, 'utf8');
    const report = await exportDocumentSources({
      ...config,
      obsidianVaultPath: vaultPath,
      vaultExportLayout: 'direct-to-vault',
      vaultExportSubdir: '语雀导出',
    }, (event) => emitted.push(event), { client: makeClient(), sourceResult });
    const contentRoot = path.join(vaultPath, '语雀导出');
    assert.equal(report.contentOutputDir, contentRoot);
    assert.equal(report.outputDir, outputDir);
    assert.equal(report.totals.exported, 1);
    assert.equal(report.totals.skipped, 0);
    assert.equal(report.documents[0].path.startsWith(contentRoot + path.sep), true);
    assert.equal(fs.readFileSync(oldPath, 'utf8'), oldContent);
    assert.equal(path.basename(path.dirname(report.documents[0].path)), '收藏');
    assert.equal(fs.existsSync(path.join(contentRoot, '索引')), false);
    assert.equal(path.dirname(report.reportPath), outputDir);
    assert.equal(path.dirname(report.statePath), outputDir);
    assert.equal(path.dirname(report.failureCsv), outputDir);
    assert.match(fs.readFileSync(report.documents[0].path, 'utf8'), /_assets\/123\/images\//);
    const result = emitted.findLast((event) => event.type === 'result');
    assert.equal(result.contentOutputDir, contentRoot);
    assert.equal(result.failureRecordCount, 0);
    assert.match(result.message, /成功 1.*失败 0/);
    assert.equal(result.message.includes(contentRoot), true);

    // 同目录再次导出仍须保持增量跳过，不能因新增目录字段重新下载。
    const nextClient = makeClient();
    const nextReport = await exportDocumentSources({
      ...config,
      obsidianVaultPath: vaultPath,
      vaultExportLayout: 'direct-to-vault',
      vaultExportSubdir: '语雀导出',
    }, () => {}, { client: nextClient, sourceResult });
    assert.equal(nextReport.totals.skipped, 1);
    assert.equal(nextClient.calls.length, 0);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test('来源导出切换仓库时保留新位置已有的手写文件，不拿旧位置哈希作为覆盖依据', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-vault-protect-'));
  const outputDir = path.join(temporaryDir, 'reports');
  const vaultPath = path.join(temporaryDir, 'vault');
  const config = { outputDir, selectedDocumentKeys: ['yuque:book-1:doc-1'] };
  const sourceResult = { complete: true, totalItems: 1, documents: [sourceEntry()], excluded: [] };
  try {
    const oldReport = await exportDocumentSources(config, () => {}, { client: makeClient(), sourceResult });
    const newPath = path.join(vaultPath, path.relative(outputDir, oldReport.documents[0].path));
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, '# 我的手写笔记\n', 'utf8');
    const nextClient = makeClient();
    const report = await exportDocumentSources({
      ...config,
      obsidianVaultPath: vaultPath,
      vaultExportLayout: 'direct-to-vault',
    }, () => {}, { client: nextClient, sourceResult });
    assert.equal(report.totals.protected, 1);
    assert.equal(fs.readFileSync(newPath, 'utf8'), '# 我的手写笔记\n');
    assert.equal(nextClient.calls.length, 0);
    assert.equal(Object.hasOwn(report, 'indexes'), false);
    assert.equal(fs.existsSync(path.join(vaultPath, '索引')), false);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test('来源导出只写输出目录模式不写入已填写的仓库目录', async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-output-only-'));
  const outputDir = path.join(temporaryDir, 'reports');
  const vaultPath = path.join(temporaryDir, 'unused-vault');
  try {
    const report = await exportDocumentSources({
      outputDir,
      obsidianVaultPath: vaultPath,
      vaultExportLayout: 'output-only',
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
    }, () => {}, {
      client: makeClient(),
      sourceResult: { complete: true, totalItems: 1, documents: [sourceEntry()], excluded: [] },
    });
    assert.equal(report.contentOutputDir, outputDir);
    assert.equal(report.documents[0].path.startsWith(outputDir + path.sep), true);
    assert.equal(fs.existsSync(vaultPath), false);
    assert.equal(report.failureRecordCount, 0);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
});

test('来源文档导出拒绝空选择且不扫描或请求文档', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-empty-'));
  const client = makeClient();
  try {
    await assert.rejects(
      exportDocumentSources({
        outputDir,
        selectedDocumentKeys: [],
      }, () => {}, {
        client,
        sourceResult: {
          totalItems: 1,
          documents: [sourceEntry()],
          excluded: [],
        },
      }),
      /空选择不会导出全部/,
    );
    assert.equal(client.calls.length, 0);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('详情 ID 与所选文档不一致时不获取或写入正文', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-id-mismatch-'));
  const client = makeClient({ id: 999 });
  try {
    const report = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      incrementalExport: false,
    }, () => {}, {
      client,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });

    assert.equal(report.totals.failed, 1);
    assert.equal(client.calls.filter((call) => call.kind === 'markdown').length, 0);
    assert.equal(fs.existsSync(report.documents[0].path), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('来源导出报告区分受限、不可用与登录状态错误', async () => {
  const cases = [
    { httpStatus: 401, expectedStatus: 'failed', failureKind: 'authentication-required' },
    { httpStatus: 403, expectedStatus: 'restricted', failureKind: 'restricted' },
    { httpStatus: 404, expectedStatus: 'unavailable', failureKind: 'unavailable' },
  ];

  for (const scenario of cases) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-access-'));
    const requestError = new Error(`Request failed with status code ${scenario.httpStatus}`);
    requestError.response = { status: scenario.httpStatus };
    try {
      const report = await exportDocumentSources({
        outputDir,
        selectedDocumentKeys: ['yuque:book-1:doc-1'],
        incrementalExport: false,
      }, () => {}, {
        client: makeClient({ requestError }),
        sourceResult: {
          totalItems: 1,
          documents: [sourceEntry()],
          excluded: [],
        },
      });

      assert.equal(report.totals.failed, 1);
      assert.equal(report.documents[0].status, scenario.expectedStatus);
      assert.equal(report.documents[0].failureKind, scenario.failureKind);
      assert.equal(report.totals.authenticationRequired, scenario.httpStatus === 401 ? 1 : 0);
      assert.equal(report.totals.restricted, scenario.httpStatus === 403 ? 1 : 0);
      assert.equal(report.totals.unavailable, scenario.httpStatus === 404 ? 1 : 0);
      assert.equal(fs.existsSync(report.documents[0].path), false);
      assert.equal(report.failureRecordCount, 1);
      const csv = fs.readFileSync(report.failureCsv, 'utf8');
      assert.match(csv, /Demo/);
      assert.match(csv, /文档导出/);
      assert.match(csv, /401|403|404|访问|登录|权限|不存在/);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});

test('来源导出将复杂卡片交给只读工作线程并保留未解析链接提示', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-worker-'));
  const client = makeClient({
    content: '<p>demo body</p><card type="block" name="unknown" value="data:opaque" />',
  });
  client.get = async (url) => {
    client.calls.push({ kind: 'markdown', url });
    return {
      data: '[此处为语雀卡片，点击链接查看](https://www.yuque.com/docs/123)',
    };
  };
  let workerCall = null;
  try {
    const report = await exportDocumentSources({
      outputDir,
      cookiePath: path.join(outputDir, 'cookies.json'),
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: false,
    }, () => {}, {
      client,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
      async runArtifactWorker(config, task) {
        workerCall = { config, task };
        return {
          tables: [[['字段'], ['已提取内容']]],
        };
      },
    });

    assert.ok(workerCall, JSON.stringify(report.documents));
    assert.equal(workerCall.task.docPlan.absoluteDocUrl, sourceEntry().canonicalUrl);
    assert.equal(workerCall.task.docPlan.docSlug, sourceEntry().documentSlug);
    assert.equal(workerCall.task.bookPlan.book.name, sourceEntry().bookName);
    assert.equal(workerCall.config.cookiePath, path.join(outputDir, 'cookies.json'));
    assert.equal(report.documents[0].status, 'incomplete');
    const markdown = fs.readFileSync(report.documents[0].path, 'utf8');
    assert.match(markdown, /\\| 字段 \\|/);
    assert.match(markdown, /仍有复杂卡片未能替换为可读内容/);
    assert.match(markdown, /https:\/\/www\.yuque\.com\/docs\/123/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('复杂画板未捕获时记录为不完整且增量运行不会误跳过', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-complex-'));
  const boardPayload = encodeURIComponent(JSON.stringify({ diagramData: { children: [] } }));
  const client = makeClient({
    content: `<card type="block" name="board" value="data:${boardPayload}" />`,
  });
  try {
    const report = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: true,
    }, () => {}, {
      client,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });

    assert.equal(report.totals.incomplete, 1);
    assert.match(report.documents[0].limitations.join(' '), /无法稳定结构化/);
    const state = JSON.parse(fs.readFileSync(report.statePath, 'utf8'));
    assert.equal(state.documents['yuque:book-1:doc-1'].status, 'incomplete');

    const nextClient = makeClient({
      content: `<card type="block" name="board" value="data:${boardPayload}" />`,
    });
    const next = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: true,
    }, () => {}, {
      client: nextClient,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });
    assert.equal(next.totals.skipped, 0);
    assert.equal(nextClient.calls.filter((call) => call.kind === 'markdown').length, 1);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('来源文档导出将可结构化的嵌入式思维导图写入正文并保存原始侧车', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-mindmap-'));
  const diagramData = {
    head: { version: '2.0.0' },
    body: [{
      id: 'root',
      type: 'mindmap',
      html: '画风分类',
      children: [{
        id: 'child',
        html: '中国传统',
        children: [],
      }],
    }],
  };
  const payload = encodeURIComponent(JSON.stringify({ diagramData }));
  const client = makeClient({
    content: `<card type="block" name="board" value="data:${payload}" />`,
  });

  try {
    const report = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: false,
    }, () => {}, {
      client,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });

    assert.equal(report.status, 'success');
    assert.equal(report.totals.exported, 1);
    assert.equal(report.totals.incomplete, 0);
    const markdown = fs.readFileSync(report.documents[0].path, 'utf8');
    assert.match(markdown, /画风分类/);
    assert.match(markdown, /中国传统/);
    const boardDir = path.join(path.dirname(report.documents[0].path), '_assets', '123', 'boards');
    const sidecars = fs.readdirSync(boardDir, { recursive: true });
    assert.ok(sidecars.some((entry) => String(entry).endsWith('.yuque.json')));
    assert.ok(sidecars.some((entry) => String(entry).endsWith('.manifest.json')));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('收藏来源里的语雀 Sheet 默认嵌入 Bases 表格并把数据生成为记录', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-sheet-'));
  const workbook = [{
    name: '概览',
    mergeCells: {
      '0:1': { row: 0, col: 1, rowCount: 1, colCount: 3 },
    },
    vStore: {
      style_backColor: ['#FBE4E7'],
      style_color: ['#2F4BDA'],
    },
    data: {
      0: {
        0: { v: '命令', s: 0 },
        1: { v: '快捷键', s: 0 },
        4: { v: '备注', s: 0 },
      },
      1: {
        0: { v: '游标归位' },
        1: { v: 'shift' },
        2: { v: '+' },
        3: { v: 'C' },
        4: { v: '回到原点' },
      },
    },
  }];
  const body = {
    format: 'lakesheet',
    version: '3.5.5',
    sheet: zlib.deflateSync(JSON.stringify(workbook)).toString('latin1'),
  };
  const client = makeClient({
    title: '样本工作簿',
    type: 'Sheet',
    format: 'lakesheet',
    content: JSON.stringify(body),
  });

  try {
    const report = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: false,
    }, () => {}, {
      client,
      sourceResult: {
        totalItems: 1,
        documents: [{ ...sourceEntry(), documentType: 'Sheet' }],
        excluded: [],
      },
    });

    assert.equal(report.status, 'success');
    assert.equal(report.totals.exported, 1);
    assert.equal(report.totals.unsupported, 0);
    assert.equal(path.basename(report.documents[0].path), 'Demo.md');
    const markdown = fs.readFileSync(report.documents[0].path, 'utf8');
    assert.match(markdown, /^# 样本工作簿/m);
    assert.match(markdown, /!?\[\[.*dataset\.base\]\]/);
    assert.doesNotMatch(markdown, /<table class="sheet-table"/);
    assert.doesNotMatch(markdown, /以下为语雀电子表格|有效区域|合并单元格|工作簿版本|源地址/);
    assert.doesNotMatch(markdown, /\[(?:CSV|HTML|JSON|工作簿总览 HTML)\]\(/);
    assert.match(markdown, /样本/);
    assert.doesNotMatch(markdown, /```text/);
    assert.equal(fs.existsSync(report.documents[0].spreadsheet.files.workbookHtmlPath), true);
    assert.equal(fs.existsSync(report.documents[0].spreadsheet.files.sheets[0].csvPath), true);
    const sheetFiles = report.documents[0].spreadsheet.files.sheets[0];
    assert.equal(fs.existsSync(sheetFiles.basePath), true);
    assert.equal(sheetFiles.recordCount, 1);
    const baseText = fs.readFileSync(sheetFiles.basePath, 'utf8');
    assert.match(baseText, /- type: table/);
    assert.match(baseText, /dataset == "yuque-sheet-123-1"/);
    assert.doesNotMatch(baseText, /file\.inFolder\(this\.file\.folder/u);
    assert.match(baseText, /displayName: "命令"/);
    assert.match(baseText, /displayName: "快捷键"/);
    assert.match(baseText, /displayName: "备注"/);
    const rowNote = fs.readFileSync(path.join(sheetFiles.recordsDir, 'row-0001.md'), 'utf8');
    assert.match(rowNote, /"dataset": "yuque-sheet-123-1"/);
    assert.match(rowNote, /"col_01": "游标归位"/);
    assert.match(rowNote, /"col_02": "shift \+ C"/);
    assert.match(rowNote, /"col_03": "回到原点"/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('来源导出沿用稳定标题路径并保护人工修改的本地正文', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-protected-'));
  const firstClient = makeClient();
  const originalEntry = sourceEntry();
  let originalPath = '';
  try {
    const first = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: [originalEntry.documentKey],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: false,
    }, () => {}, {
      client: firstClient,
      sourceResult: {
        complete: true,
        totalItems: 1,
        documents: [originalEntry],
        excluded: [],
      },
    });
    originalPath = first.documents[0].path;
    fs.writeFileSync(originalPath, '# 我的本地修改\n', 'utf8');

    const renamedEntry = { ...originalEntry, title: 'Renamed title' };
    const secondClient = makeClient({ content_updated_at: 'version-3' });
    const second = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: [renamedEntry.documentKey],
      downloadImages: false,
      downloadAttachments: false,
      incrementalExport: false,
    }, () => {}, {
      client: secondClient,
      sourceResult: {
        complete: true,
        totalItems: 1,
        documents: [renamedEntry],
        excluded: [],
      },
    });

    assert.equal(second.status, 'partial');
    assert.equal(second.totals.protected, 1);
    assert.equal(second.documents[0].status, 'protected');
    assert.equal(second.documents[0].path, originalPath);
    assert.equal(fs.readFileSync(originalPath, 'utf8'), '# 我的本地修改\n');
    assert.equal(secondClient.calls.length, 0);
    assert.equal(fs.existsSync(path.join(path.dirname(originalPath), 'Renamed title__123.md')), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('来源导出日志会剔除资源错误中的签名查询参数', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-source-redaction-'));
  const client = makeClient({
    assetError: 'Failed https://cdn.nlark.com/yuque/image.png?X-Amz-Signature=dummy-secret',
  });
  try {
    const report = await exportDocumentSources({
      outputDir,
      selectedDocumentKeys: ['yuque:book-1:doc-1'],
      downloadImages: true,
      downloadAttachments: false,
      incrementalExport: false,
    }, () => {}, {
      client,
      sourceResult: {
        totalItems: 1,
        documents: [sourceEntry()],
        excluded: [],
      },
    });

    const markdown = fs.readFileSync(report.documents[0].path, 'utf8');
    const failureCsv = fs.readFileSync(report.failureCsv, 'utf8');
    assert.equal(report.totals.incomplete, 1);
    assert.match(markdown, /详见失败日志/);
    assert.equal(markdown.includes('dummy-secret'), false);
    assert.equal(failureCsv.includes('dummy-secret'), false);
    assert.match(failureCsv, /cdn\.nlark\.com\/yuque\/image\.png/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('暂停或停止只在当前文档完成后响应，并保存可增量继续的状态', async () => {
  for (const requestedAction of ['pause', 'stop']) {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `yuque-source-${requestedAction}-`));
    const client = makeClient();
    const actions = ['run', requestedAction];
    try {
      const report = await exportDocumentSources({
        outputDir,
        selectedDocumentKeys: ['yuque:book-1:doc-1', 'yuque:book-1:doc-2'],
        downloadImages: false,
        downloadAttachments: false,
        incrementalExport: true,
      }, () => {}, {
        client,
        control: { getAction: () => actions.shift() || 'run' },
        sourceResult: {
          totalItems: 2,
          documents: [sourceEntry(), secondSourceEntry()],
          excluded: [],
        },
      });

      assert.equal(report.status, requestedAction === 'pause' ? 'paused' : 'cancelled');
      assert.equal(report.totals.exported, 1);
      assert.equal(client.calls.filter((call) => call.kind === 'markdown').length, 1);
      const state = JSON.parse(fs.readFileSync(report.statePath, 'utf8'));
      assert.equal(state.meta.status, report.status);
      assert.equal(state.documents['yuque:book-1:doc-1'].status, 'exported');
      assert.equal(state.documents['yuque:book-1:doc-2'], undefined);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }
});
