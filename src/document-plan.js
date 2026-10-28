import path from 'node:path';
import { deduplicateDocumentEntries } from './document-sources.js';
import { normalizeAssetDirectoryName, sanitizeFileName, uniqueName } from './utils.js';

/**
 * 创建不依赖知识库目录树的单篇文档计划；空选择明确报错，绝不退化成“全部”。
 */
export function buildDocumentPlan(entries, options = {}) {
  const outputDir = path.resolve(String(options.outputDir ?? '').trim());
  if (!String(options.outputDir ?? '').trim()) {
    throw new Error('文档计划必须指定 outputDir。');
  }
  const selectedKeys = Array.isArray(options.selectedDocumentKeys)
    ? new Set(options.selectedDocumentKeys.map((key) => String(key).trim()).filter(Boolean))
    : new Set();
  if (selectedKeys.size === 0) {
    throw new Error('没有选中具体文档；空选择不会导出全部。');
  }

  const { documents, excluded } = deduplicateDocumentEntries(entries);
  const selected = documents.filter((document) => selectedKeys.has(document.documentKey));
  const missingKeys = [...selectedKeys].filter((key) => !documents.some((document) => document.documentKey === key));
  if (missingKeys.length > 0) {
    throw new Error(`选择中包含 ${missingKeys.length} 个当前来源列表不存在的文档标识。`);
  }

  const assetDirectoryName = normalizeAssetDirectoryName(options.assetDirectoryName);
  const usedFileNamesByCategory = new Map();
  const fileNamesByDocumentKey = new Map();
  for (const document of documents) {
    const sourceTypes = new Set(
      (Array.isArray(document.sourceRelations) ? document.sourceRelations : [])
        .map((relation) => relation?.sourceType),
    );
    if (sourceTypes.size === 0 && document.sourceType) sourceTypes.add(document.sourceType);
    const category = sourceTypes.has('favorite') ? '收藏' : '协作';
    if (!usedFileNamesByCategory.has(category)) {
      usedFileNamesByCategory.set(category, new Set());
    }
    const title = sanitizeFileName(document.title || '未命名文档');
    // 基于完整来源列表分配冲突序号，保证只选中同名文档中的后者时路径仍稳定。
    fileNamesByDocumentKey.set(
      document.documentKey,
      uniqueName(`${title}.md`, usedFileNamesByCategory.get(category)),
    );
  }

  const planned = selected.map((document) => {
    const sourceTypes = new Set(
      (Array.isArray(document.sourceRelations) ? document.sourceRelations : [])
        .map((relation) => relation?.sourceType),
    );
    if (sourceTypes.size === 0 && document.sourceType) sourceTypes.add(document.sourceType);
    // 同一文档可能同时被收藏和协作；正文只保留一份，固定归入收藏目录。
    const category = sourceTypes.has('favorite') ? '收藏' : '协作';
    const documentFolder = path.join(outputDir, category);
    const fileName = fileNamesByDocumentKey.get(document.documentKey);
    const targetMdPath = path.join(documentFolder, fileName);
    const assetDir = path.join(documentFolder, assetDirectoryName, document.documentId);
    const relative = path.relative(outputDir, targetMdPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`文档路径超出输出根目录：${document.documentKey}`);
    }

    return {
      ...document,
      absoluteDocUrl: document.canonicalUrl,
      targetMdPath,
      assetDir,
    };
  });

  return {
    outputDir,
    documents: planned,
    excluded,
  };
}
