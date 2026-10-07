import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureDir, writeJson } from './utils.js';

const STATE_FILE_NAME = '.yuque-export-state.json';
const STATE_VERSION = 2;

export class ExportStateStore {
  constructor(outputDir) {
    this.outputDir = ensureDir(outputDir);
    this.filePath = path.join(this.outputDir, STATE_FILE_NAME);
    this.state = loadState(this.filePath);
  }

  getRecord(docUrl) {
    return this.state.documents[stateKey(docUrl)] ?? null;
  }

  getRecordForDocument(docPlan = {}) {
    return this.getRecord(docPlan.documentKey) || this.getRecord(docPlan.absoluteDocUrl);
  }

  shouldSkip(docPlan) {
    const record = this.getRecordForDocument(docPlan);
    const outputPath = record?.outputPath || record?.targetMdPath || docPlan.targetMdPath;
    const currentPath = path.resolve(String(docPlan.targetMdPath || ''));
    const savedPath = path.resolve(String(outputPath || ''));
    const sameSource = Boolean(record?.sourceVersion && docPlan?.sourceVersion && record.sourceVersion === docPlan.sourceVersion);
    const outputMatches = !record?.outputHash || hashFile(currentPath) === record.outputHash;
    return record?.status === 'exported'
      && sameSource
      && savedPath === currentPath
      && fs.existsSync(currentPath)
      && outputMatches;
  }

  isLocalOutputModified(docPlan) {
    const record = this.getRecordForDocument(docPlan);
    const outputPath = record?.targetMdPath || record?.outputPath || docPlan.targetMdPath;
    if (!outputPath || !fs.existsSync(outputPath)) return false;
    if (!record?.outputHash) return true;
    return hashFile(outputPath) !== record.outputHash;
  }

  markQueued(docPlan) {
    this._upsert(docPlan, {
      status: 'queued',
    });
  }

  markSkipped(docPlan) {
    this._upsert(docPlan, {
      status: 'exported',
      lastAction: 'skipped',
      skippedAt: new Date().toISOString(),
    });
  }

  markExported(docPlan, options = {}) {
    const outputPath = options.outputPath || docPlan.targetMdPath;
    this._upsert(docPlan, {
      status: 'exported',
      exportedAt: new Date().toISOString(),
      targetMdPath: docPlan.targetMdPath,
      outputPath,
      outputKind: options.outputKind || 'markdown',
      ...(options.outputHash ? { outputHash: options.outputHash } : {}),
      sourceVersion: docPlan.sourceVersion || '',
      error: '',
    });
  }

  markIncomplete(docPlan, errorMessage = '', options = {}) {
    this._upsert(docPlan, {
      status: 'incomplete',
      targetMdPath: docPlan.targetMdPath,
      outputPath: docPlan.targetMdPath,
      ...(options.outputHash ? { outputHash: options.outputHash } : {}),
      sourceVersion: docPlan.sourceVersion || '',
      error: errorMessage,
    });
  }

  markFailed(docPlan, errorMessage) {
    this._upsert(docPlan, {
      status: 'failed',
      failedAt: new Date().toISOString(),
      targetMdPath: docPlan.targetMdPath,
      error: errorMessage,
    });
  }

  markPaused(docPlan) {
    this._upsert(docPlan, {
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });
  }

  syncDocumentSourceRelations(documents, options = {}) {
    if (options.complete !== true || !Array.isArray(documents)) {
      return false;
    }

    const relationsByKey = new Map(
      documents
        .filter((document) => String(document?.documentKey || '').trim())
        .map((document) => [
          String(document.documentKey).trim(),
          Array.isArray(document.sourceRelations) ? document.sourceRelations : [],
        ]),
    );
    let changed = false;
    for (const record of Object.values(this.state.documents)) {
      const documentKey = String(record?.documentKey || '').trim();
      if (!documentKey) continue;
      const nextRelations = relationsByKey.get(documentKey) || [];
      if (JSON.stringify(record.sourceRelations || []) === JSON.stringify(nextRelations)) continue;
      record.sourceRelations = nextRelations.map((relation) => ({ ...relation }));
      record.sourceRelationsUpdatedAt = new Date().toISOString();
      changed = true;
    }

    if (changed) this.flush();
    return changed;
  }

  saveMeta(meta) {
    this.state.meta = {
      ...this.state.meta,
      ...meta,
      updatedAt: new Date().toISOString(),
    };
    this.flush();
  }

  flush() {
    writeJson(this.filePath, this.state);
  }

  _upsert(docPlan, partial) {
    const documentKey = stateKey(docPlan.documentKey);
    const legacyUrlKey = stateKey(docPlan.absoluteDocUrl);
    const key = documentKey || legacyUrlKey;
    // 首次切换到稳定文档身份时沿用旧 URL 记录；旧键保留，避免迁移时丢失回滚依据。
    const previous = this.state.documents[key]
      ?? (documentKey ? this.state.documents[legacyUrlKey] : undefined)
      ?? {};
    this.state.documents[key] = {
      documentKey: docPlan.documentKey || '',
      bookId: docPlan.book?.id ?? docPlan.bookId ?? '',
      bookName: docPlan.book?.name ?? docPlan.bookName ?? '',
      docName: docPlan.node?.name ?? docPlan.title ?? '',
      targetMdPath: docPlan.targetMdPath,
      yuquePath: docPlan.absoluteDocUrl,
      sourceRelations: Array.isArray(docPlan.sourceRelations) ? docPlan.sourceRelations : [],
      updatedAt: new Date().toISOString(),
      ...previous,
      ...(Array.isArray(docPlan.sourceRelations) ? { sourceRelations: docPlan.sourceRelations } : {}),
      ...partial,
    };
    this.flush();
  }
}

function stateKey(value) {
  return String(value ?? '').trim();
}

function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

export class ExportControl {
  constructor(filePath) {
    this.filePath = filePath || '';
  }

  getAction() {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return 'run';
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed.action || 'run';
    } catch {
      return 'run';
    }
  }

  clear() {
    if (this.filePath && fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return createEmptyState();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return createEmptyState();
  }

  if (!parsed || typeof parsed !== 'object') return createEmptyState();
  if (Number.isSafeInteger(parsed.version) && parsed.version > STATE_VERSION) {
    throw new Error(`导出状态文件版本 ${parsed.version} 高于当前软件支持的版本 ${STATE_VERSION}，为避免降级覆盖已停止读取。`);
  }

  return {
    version: STATE_VERSION,
    meta: parsed.meta ?? {},
    documents: parsed.documents ?? {},
  };
}

function createEmptyState() {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    meta: {
      createdAt: now,
      updatedAt: now,
    },
    documents: {},
  };
}
