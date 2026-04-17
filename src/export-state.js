import fs from 'fs';
import path from 'path';
import { ensureDir, writeJson } from './utils.js';

const STATE_FILE_NAME = '.yuque-export-state.json';

export class ExportStateStore {
  constructor(outputDir) {
    this.outputDir = ensureDir(outputDir);
    this.filePath = path.join(this.outputDir, STATE_FILE_NAME);
    this.state = loadState(this.filePath);
  }

  getRecord(docUrl) {
    return this.state.documents[docUrl] ?? null;
  }

  shouldSkip(docPlan) {
    const record = this.getRecord(docPlan.absoluteDocUrl);
    const outputPath = record?.outputPath || record?.targetMdPath || docPlan.targetMdPath;
    return record?.status === 'exported' && Boolean(outputPath) && fs.existsSync(outputPath);
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
      error: '',
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
    const previous = this.getRecord(docPlan.absoluteDocUrl) ?? {};
    this.state.documents[docPlan.absoluteDocUrl] = {
      bookId: docPlan.book.id,
      bookName: docPlan.book.name,
      docName: docPlan.node.name,
      targetMdPath: docPlan.targetMdPath,
      yuquePath: docPlan.absoluteDocUrl,
      updatedAt: new Date().toISOString(),
      ...previous,
      ...partial,
    };
    this.flush();
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
    return {
      version: 1,
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      documents: {},
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      meta: parsed.meta ?? {},
      documents: parsed.documents ?? {},
    };
  } catch {
    return {
      version: 1,
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      documents: {},
    };
  }
}
