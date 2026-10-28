import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildDocumentPlan } from '../src/document-plan.js';

const OUTPUT_DIR = path.join('test-output', 'yuque-documents');

function entry(overrides = {}) {
  return {
    itemType: 'document',
    documentKey: 'yuque:book-1:doc-1',
    documentId: 'doc-1',
    bookId: 'book-1',
    owner: 'owner',
    bookName: 'Book',
    title: 'Document',
    canonicalUrl: 'https://www.yuque.com/owner/book/doc-1',
    sourceVersion: '2026-10-01T00:00:00Z',
    sourceType: 'favorite',
    actionOption: 'doc',
    status: 'unverified',
    ...overrides,
  };
}

test('单篇计划只安排明确选择的文档并生成稳定的文档级资源目录', () => {
  const result = buildDocumentPlan([
    entry(),
    entry({
      documentKey: 'yuque:book-1:doc-2',
      documentId: 'doc-2',
      title: 'Another',
      canonicalUrl: 'https://www.yuque.com/owner/book/doc-2',
    }),
    { itemType: 'book-entry', sourceType: 'favorite', status: 'not-expanded' },
  ], {
    outputDir: OUTPUT_DIR,
    selectedDocumentKeys: ['yuque:book-1:doc-2'],
  });

  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].documentId, 'doc-2');
  assert.equal(result.documents[0].absoluteDocUrl, result.documents[0].canonicalUrl);
  assert.equal(
    path.relative(path.resolve(OUTPUT_DIR), result.documents[0].targetMdPath),
    path.join('收藏', 'Another.md'),
  );
  assert.equal(
    path.relative(path.dirname(result.documents[0].targetMdPath), result.documents[0].assetDir),
    path.join('_assets', 'doc-2'),
  );
  assert.equal(result.excluded.length, 1);
});

test('单篇计划使用自定义资源目录名，并将路径分隔符输入回退到默认值', () => {
  const options = {
    outputDir: OUTPUT_DIR,
    selectedDocumentKeys: ['yuque:book-1:doc-1'],
  };
  const custom = buildDocumentPlan([entry()], { ...options, assetDirectoryName: 'media files' });
  assert.equal(
    path.relative(path.dirname(custom.documents[0].targetMdPath), custom.documents[0].assetDir),
    path.join('media files', 'doc-1'),
  );

  const invalid = buildDocumentPlan([entry()], { ...options, assetDirectoryName: '../outside' });
  assert.equal(
    path.relative(path.dirname(invalid.documents[0].targetMdPath), invalid.documents[0].assetDir),
    path.join('_assets', 'doc-1'),
  );
});

test('协作专属文档直接写入协作目录；同时收藏和协作的文档只规划一份收藏正文', () => {
  const collaborationOnly = entry({
    documentKey: 'yuque:book-1:doc-collab',
    documentId: 'doc-collab',
    sourceType: 'collaboration',
    sourceRelations: [{ sourceType: 'collaboration', actionOption: 'collaboration_Doc_doc' }],
  });
  const both = entry({
    documentKey: 'yuque:book-1:doc-both',
    documentId: 'doc-both',
    sourceRelations: [
      { sourceType: 'favorite', actionOption: 'doc' },
      { sourceType: 'collaboration', actionOption: 'collaboration_Doc_doc' },
    ],
  });
  const result = buildDocumentPlan([collaborationOnly, both], {
    outputDir: OUTPUT_DIR,
    selectedDocumentKeys: [collaborationOnly.documentKey, both.documentKey],
  });

  assert.equal(path.basename(path.dirname(result.documents[0].targetMdPath)), '协作');
  assert.equal(path.basename(path.dirname(result.documents[1].targetMdPath)), '收藏');
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents.every((document) => !document.targetMdPath.includes(`${path.sep}文档${path.sep}`)), true);
});

test('空选择、空白选择、缺少输出目录或不存在的选择都明确失败', () => {
  const entries = [entry()];
  assert.throws(
    () => buildDocumentPlan(entries, { outputDir: OUTPUT_DIR, selectedDocumentKeys: [] }),
    /空选择不会导出全部/,
  );
  assert.throws(
    () => buildDocumentPlan(entries, { outputDir: OUTPUT_DIR, selectedDocumentKeys: ['  '] }),
    /空选择不会导出全部/,
  );
  assert.throws(
    () => buildDocumentPlan(entries, { selectedDocumentKeys: ['yuque:book-1:doc-1'] }),
    /必须指定 outputDir/,
  );
  assert.throws(
    () => buildDocumentPlan(entries, { outputDir: OUTPUT_DIR, selectedDocumentKeys: ['yuque:other:doc'] }),
    /不存在的文档标识/,
  );
});

test('单篇计划使用已有文件名清理规则，拒绝路径穿越', () => {
  const result = buildDocumentPlan([
    entry({
      owner: '../owner',
      title: '../private:title.md',
      documentId: 'doc:1',
      documentKey: 'yuque:book-1:doc:1',
    }),
  ], {
    outputDir: OUTPUT_DIR,
    selectedDocumentKeys: ['yuque:book-1:doc:1'],
  });

  const relative = path.relative(path.resolve(OUTPUT_DIR), result.documents[0].targetMdPath);
  assert.equal(relative.startsWith('..'), false);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(path.dirname(result.documents[0].targetMdPath).startsWith('..'), false);
  assert.equal(path.basename(result.documents[0].targetMdPath), '.._private_title.md.md');
});

test('同分类中同名文档仅在发生冲突时追加序号', () => {
  const first = entry({ documentKey: 'yuque:book-1:a', documentId: 'a', title: '相同标题' });
  const second = entry({ documentKey: 'yuque:book-1:b', documentId: 'b', title: '相同标题' });
  const result = buildDocumentPlan([first, second], {
    outputDir: OUTPUT_DIR,
    selectedDocumentKeys: [first.documentKey, second.documentKey],
  });

  assert.deepEqual(
    result.documents.map((document) => path.basename(document.targetMdPath)),
    ['相同标题.md', '相同标题-2.md'],
  );
  const selectedLaterDuplicate = buildDocumentPlan([first, second], {
    outputDir: OUTPUT_DIR,
    selectedDocumentKeys: [second.documentKey],
  });
  assert.equal(path.basename(selectedLaterDuplicate.documents[0].targetMdPath), '相同标题-2.md');
});
