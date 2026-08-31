import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { type } from './const.js';
import { ExportControl, ExportStateStore } from './export-state.js';
import { FailureCsvLogger, localizeFailureRecord } from './failure-log.js';
import { isLikelyAttachment, processMarkdown } from './markdown.js';
import {
  buildObsidianConfigSummary,
  detectObsidianDiagramCapabilities,
  executeObsidianSetup,
  resolveContentOutputDir,
  writeObsidianSetupJson,
  writeObsidianSetupNote,
} from './obsidian.js';
import { filterBooks, getAllBooks, serializeBooks } from './toc.js';
import { extractBoardsFromDocDetail, isBoardDocument } from './board.js';
import { createBoardManifest, createBoardRenderPlan, normalizeDiagramExportMode, normalizeDiagramSnapshotMode } from './board-render.js';
import { readExcalidrawScene, validateExcalidrawScene, writeExcalidrawDrawing } from './excalidraw.js';
import {
  createHttpClient,
  fetchAllTableRecords,
  fetchDocDetail,
  fetchMarkdown,
  isTableDocument,
  launchBrowser,
  openAuthenticatedPage,
  parseTableDocumentBody,
} from './yuque.js';
import {
  extractTableImageAssets,
  getPrimaryLaketableSheet,
  getTablePreviewRows,
  normalizeStandaloneTableDocument,
  renderTableScalar,
  sanitizeTableImageFileName,
  summarizeTableColumns,
  toDatatableRecordTitle,
} from './table.js';
import {
  buildWorkbookHtmlDocument,
  buildWorksheetCsv,
  buildWorksheetHtmlDocument,
  isSheetDocument,
  normalizeStandaloneSheetDocument,
} from './sheet.js';
import {
  ensureDir,
  escapeCsv,
  errorToMessage,
  formatTimestamp,
  relativeMarkdownPath,
  sanitizeFileName,
  sleep,
  stripHtml,
  toPosixPath,
  uniqueName,
  writeJson,
} from './utils.js';
import { encryptMeldBlock, normalizeReencryptMode } from './meld-encrypt.js';
import { getLoginProfileDir } from './login.js';

const MARKDOWN_TIMEOUT_MS = 180000;
const ARTIFACT_TIMEOUT_MS = 180000;
const DATATABLE_DOM_ID_ATTR = 'data-codex-datatable-id';
const DATATABLE_PREVIEW_ROWS = 5;
const DATATABLE_DATASET_VERSION = 1;
const GENERIC_CARD_PLACEHOLDER_RE =
  /\[(此处为语雀卡片，点击链接查看)\]\((https?:\/\/(?:www\.)?yuque\.com\/docs\/\d+(?:#[^)]+)?)\)/g;
const EMBEDDED_CARD_TAG_RE = /<card\b([^>]*?)\/?>/gi;
const ENCRYPTED_DOM_SELECTORS = Object.freeze({
  lockedContainer: 'div.ne-card-locked-text-unlock-container[data-testid="ne-card-locked-text-unlock-status"]',
  input: 'input[data-testid="ne-card-locked-text-unlock-input"]',
  submitButton: 'div.ne-card-locked-text-unlock-submit-button[data-testid="ne-card-locked-text-unlock-button"]',
  content: 'div.ne-card-locked-text-read-container[data-testid="ne-card-locked-text-viewer-content"]',
});
const KNOWN_REJECTED_IMAGE_PLACEHOLDER_HASHES = Object.freeze([
  // Yuque / asset proxy placeholder: "该图片可能违规或链接失效"
  '1a3c7bd719e69049802d260fc9aa76189b89623a5c1404e8b80a25965d00b8c1',
]);
const ENCRYPTED_SKIP_ATTR = 'data-codex-encrypted-skip';
const ENCRYPTED_ORDER_ATTR = 'data-codex-encrypted-order';
const ENCRYPTED_PASSWORD_ATTR = 'data-codex-encrypted-password';
const CODE_BLOCK_CONTAINER_SELECTORS = Object.freeze([
  '[data-card-name*="code"]',
  '[data-type*="code"]',
  '[class*="code-block"]',
  '[class*="codeBlock"]',
  '[class*="codeblock"]',
  '[class*="CodeBlock"]',
  '[class*="code-view"]',
  '[class*="codeView"]',
  'figure pre',
  'pre',
]);
const COMPLEX_ARTIFACT_SELECTORS = Object.freeze({
  board: [
    '[data-type*="board"]',
    '[data-card-name*="board"]',
    '[class*="whiteboard"]',
    '[class*="draw-board"]',
    '[class*="canvas-board"]',
    '[class*="board-content"]',
  ],
  mindmap: [
    '[data-type*="mind"]',
    '[data-card-name*="mind"]',
    '[class*="mindmap"]',
    '[class*="mind-map"]',
    '[class*="mind_map"]',
    '[class*="mind-node"]',
  ],
  datatable: [
    '[data-type*="database"]',
    '[data-type*="sheet"]',
    '[data-card-name*="database"]',
    '[class*="data-table"]',
    '[class*="database-view"]',
    '[class*="grid-view"]',
    '[class*="sheet-view"]',
  ],
  encrypted: [
    ENCRYPTED_DOM_SELECTORS.lockedContainer,
    ENCRYPTED_DOM_SELECTORS.input,
    ENCRYPTED_DOM_SELECTORS.submitButton,
    ENCRYPTED_DOM_SELECTORS.content,
  ],
});
const FALLBACK_ARTIFACT_REASONS = new Set(['mindmap', 'encrypted-fallback', 'export-failure']);
const SAFE_SCREENSHOT_MAX_WIDTH = 2200;
const SAFE_SCREENSHOT_MAX_HEIGHT = 12000;
const SAFE_SCREENSHOT_VIEWPORT_WIDTH = 1600;
const SAFE_SCREENSHOT_VIEWPORT_HEIGHT = 1200;
const RENDERED_IMAGE_BLANK_CAPTURE_MIN_WIDTH = 300;
const RENDERED_IMAGE_BLANK_CAPTURE_MIN_HEIGHT = 200;
const RENDERED_IMAGE_BLANK_CAPTURE_MAX_BYTES = 6 * 1024;
const DOCUMENT_EDIT_ENTRY_SELECTOR = 'button.ant-btn.ant-btn-primary.larkui-tooltip';
const DOCUMENT_EDIT_ENTRY_TEXT = '编辑';
const DOCUMENT_EDIT_ENTRY_MAX_TOP = 240;
const DOCUMENT_EDIT_MODE_WAIT_MS = 20000;
const DOCUMENT_EDIT_ROOT_SELECTOR = [
  '.ne-editor',
  '.lake-editor',
  '[class*="DocEditMode"]',
  '[class*="EditorBase-module_editor"]',
  '[class*="editor-wrapper"]',
  '[class*="editor-body"]',
  '[contenteditable="true"]',
].join(', ');
const DOCUMENT_EDIT_EXCLUDED_ROOT_SELECTOR = [
  '#lark-mini-editor',
  '.comments-form-editor',
  '.ne-doc-minor-editor',
  '[class*="comments-form-editor"]',
  '[class*="commentEditor"]',
  '[class*="comment-editor"]',
].join(', ');
const DOCUMENT_EDIT_TOOLBAR_SELECTOR = [
  '.ne-ui-toolbar',
  '.ne-ui-inner-toolbar',
  '.ne-ui-toolbar-content',
  '[class*="toolbar"]',
  '[class*="Toolbar"]',
].join(', ');
const COMPLEX_ARTIFACT_WORKER_COMMAND = 'capture-artifacts-worker';
const COMPLEX_ARTIFACT_MAX_ATTEMPTS = 2;
const ASSET_DOWNLOAD_MAX_ATTEMPTS = 3;
const EMBEDDED_MEDIA_EXTENSIONS = new Set(['mov', 'mp3', 'mp4']);

function buildDocLinkIndex(documents = [], exportRoot = '') {
  const index = {
    exact: new Map(),
    pathname: new Map(),
    bookDoc: new Map(),
    docSlug: new Map(),
    exportRoot: String(exportRoot || '').trim(),
  };

  for (const document of Array.isArray(documents) ? documents : []) {
    const targetMdPath = String(document?.targetMdPath || '').trim();
    const absoluteDocUrl = String(document?.absoluteDocUrl || '').trim();
    const docSlug = String(document?.docSlug || '').trim();
    const bookSlug = String(document?.book?.slug || '').trim();
    if (!targetMdPath || !absoluteDocUrl) {
      continue;
    }

    addDocLinkIndexEntry(index.exact, absoluteDocUrl.replace(/\/$/, ''), targetMdPath);

    try {
      const parsed = new URL(absoluteDocUrl);
      const normalizedPath = `/${String(parsed.pathname || '').replace(/^\/+|\/+$/g, '')}`;
      addDocLinkIndexEntry(index.pathname, normalizedPath, targetMdPath);
    } catch {
      // Ignore malformed urls in the export plan.
    }

    if (bookSlug && docSlug) {
      addDocLinkIndexEntry(index.bookDoc, `${bookSlug}/${docSlug}`, targetMdPath);
    }
    if (docSlug) {
      addDocLinkIndexEntry(index.docSlug, docSlug, targetMdPath);
    }
  }

  return index;
}

function addDocLinkIndexEntry(indexMap, key, targetMdPath) {
  const normalizedKey = String(key || '').trim();
  const normalizedTarget = String(targetMdPath || '').trim();
  if (!normalizedKey || !normalizedTarget) {
    return;
  }

  const existing = indexMap.get(normalizedKey) || [];
  if (!existing.includes(normalizedTarget)) {
    existing.push(normalizedTarget);
  }
  indexMap.set(normalizedKey, existing);
}

export async function scanBooks(config) {
  const client = createHttpClient(config.cookiePath);
  const books = await getAllBooks(client);
  return serializeBooks(books);
}

export function buildExportBrowserLaunchOptions(config = {}, overrides = {}) {
  const cookiePath = String(config.cookiePath || '').trim();
  return {
    browserPath: config.browserPath || '',
    cookiePath,
    loginProfileDir: cookiePath ? getLoginProfileDir(cookiePath) : '',
    ...overrides,
  };
}

export async function exportBooks(config, emit = () => {}) {
  emit({
    type: 'progress',
    phase: 'prepare',
    status: 'running',
    message: 'Loading Yuque book list...',
    percent: 0,
    bookPercent: 0,
  });

  const client = createHttpClient(config.cookiePath);
  const allBooks = await getAllBooks(client);
  const books = filterBooks(allBooks, config.selectedBooks);
  if (books.length === 0) {
    throw new Error('No books selected for export.');
  }

  const outputDir = ensureDir(config.outputDir);
  const contentOutputDir = resolveContentOutputDir(config);
  const failureLogger = new FailureCsvLogger(outputDir);
  const exportState = new ExportStateStore(outputDir);
  const control = new ExportControl(config.jobControlPath);
  control.clear();

  const exportPlan = buildExportPlan(books, contentOutputDir, createSelectionMatcher(config));
  config.complexBlockMode = resolveComplexBlockMode(config);
  config.diagramExportMode = normalizeDiagramExportMode(config.diagramExportMode);
  config.diagramSnapshotMode = normalizeDiagramSnapshotMode(config.diagramSnapshotMode);
  config.diagramCapabilities = detectObsidianDiagramCapabilities({ vaultPath: config.obsidianVaultPath });
  const docLinkMap = buildDocLinkIndex(exportPlan.documents, contentOutputDir);

  exportState.saveMeta({
    status: 'running',
    outputDir,
    selectedBooks: books.map((book) => ({ id: book.id, name: book.name })),
    incrementalExport: config.incrementalExport !== false,
    lastRunStartedAt: new Date().toISOString(),
  });

  const report = {
    startedAt: new Date().toISOString(),
    outputDir,
    contentOutputDir,
    statePath: exportState.filePath,
    failureCsv: failureLogger.filePath,
    obsidian: buildObsidianConfigSummary(config, contentOutputDir),
    encryptedBlockReencryption: {
      mode: normalizeReencryptMode(config.reencryptEncryptedBlocksMode),
      globalPasswordConfigured: Boolean(String(config.reencryptGlobalPassword || '').trim()),
    },
    totals: {
      books: books.length,
      documents: exportPlan.documents.length,
      datatables: 0,
      exported: 0,
      failed: 0,
      skipped: 0,
    },
    books: [],
    datatables: [],
  };

  emit({
    type: 'progress',
    phase: 'prepare',
    status: 'running',
    message: `Loaded ${books.length} books and ${exportPlan.documents.length} documents.`,
    percent: 0,
    bookPercent: 0,
  });

  let browser = null;
  const browserLaunchOptions = buildExportBrowserLaunchOptions(config, {
    headless: true,
  });
  const interactiveRecoveryLaunchOptions = buildExportBrowserLaunchOptions(config, {
    headless: false,
  });
  const browserSession = createBrowserSessionManager({
    getBrowser: () => browser,
    setBrowser: (nextBrowser) => {
      browser = nextBrowser;
    },
    launchOptions: browserLaunchOptions,
  });

  let activeDocPlan = null;
  let lastBookContext = null;

  try {
    let completed = 0;

    for (const [bookIndex, bookPlan] of exportPlan.books.entries()) {
      bookPlan.exportIndex = bookIndex + 1;
      bookPlan.exportCount = exportPlan.books.length;
      const bookContext = {
        bookPlan,
        total: bookPlan.documents.length,
        completed: 0,
        index: bookIndex + 1,
        bookCount: exportPlan.books.length,
      };
      lastBookContext = bookContext;

      const bookReport = {
        id: bookPlan.book.id,
        name: bookPlan.book.name,
        outputDir: bookPlan.bookDir,
        assetsDir: bookPlan.assets.root,
        summary: {
          documents: bookPlan.documents.length,
          exported: 0,
          failed: 0,
          skipped: 0,
        },
        documents: [],
      };
      report.books.push(bookReport);

      emit(buildBookEvent(bookContext, completed, exportPlan.documents.length, `Exporting ${bookPlan.book.name}`));

      for (const docPlan of bookPlan.documents) {
        const action = control.getAction();
        if (action === 'pause' || action === 'stop') {
          return finalizeInterruptedExport({
            action,
            report,
            exportState,
            failureLogger,
            emit,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookContext,
          });
        }

        activeDocPlan = docPlan;
        try {
        const existingExportRecord = exportState.getRecord(docPlan.absoluteDocUrl);
        if (config.incrementalExport !== false && exportState.shouldSkip(docPlan)) {
          const existingOutputPath =
            existingExportRecord?.outputPath ||
            existingExportRecord?.targetMdPath ||
            docPlan.targetMdPath;
          completed += 1;
          bookContext.completed += 1;
          report.totals.skipped += 1;
          bookReport.summary.skipped += 1;
          exportState.markSkipped(docPlan);
          bookReport.documents.push({
            name: docPlan.node.name,
            path: existingOutputPath,
            yuquePath: docPlan.absoluteDocUrl,
            status: 'skipped',
          });
          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message: `Skipped ${docPlan.node.name} because it was already exported.`,
            status: 'success',
          }));
          activeDocPlan = null;
          continue;
        }

        exportState.markQueued(docPlan);
        const docIssueTracker = createDocumentIssueTracker(failureLogger, bookPlan, docPlan);
        const recordDocIssue = (issue) => docIssueTracker.record(issue);

        let currentPhase = 'fetch-markdown';
        let docDetail = null;
        try {
          let markdown = '';
          let rewrittenMarkdown = '';
          let artifacts = emptyArtifacts();
          let preparedBoards = [];
          let complexArtifactPlan = null;
          let skipGenericArtifactCapture = false;
          let primaryOutputPath = docPlan.targetMdPath;
          let primaryOutputKind = 'markdown';
          let encryptedBlockReencryptionSummary = null;

          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message: 'Loading document detail...',
          }));
          try {
            docDetail = await withTimeout(
              fetchDocDetail(client, docPlan.docSlug, bookPlan.book.id),
              MARKDOWN_TIMEOUT_MS,
              `Timed out while fetching document detail for ${docPlan.node.name}.`,
            );
          } catch (docDetailError) {
            recordDocIssue({
              phase: 'fetch-markdown',
              error_type: 'DocumentDetailSkipped',
              error_message: `Document detail fetch skipped: ${errorToMessage(docDetailError)}`,
            });
            emit({
              type: 'progress',
              phase: 'doc-detail-warning',
              status: 'warning',
              book: bookPlan.book.name,
              doc: docPlan.node.name,
              targetMdPath: docPlan.targetMdPath,
              message: `${bookPlan.book.name} / ${docPlan.node.name}: Document detail fetch skipped: ${errorToMessage(docDetailError)}`,
              error: errorToMessage(docDetailError),
              percent: percent(completed, exportPlan.documents.length),
              bookPercent: percent(bookContext.completed, bookContext.total),
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
            });
          }

          const docExportRoute = classifyDocExportRoute(docDetail);

          if (docExportRoute === 'export-board') {
            currentPhase = 'rewrite-markdown';
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: 'Preparing board export...',
            }));
            rewrittenMarkdown = buildBoardDocumentMarkdown(docPlan, docDetail);
          } else if (docExportRoute === 'export-sheet') {
            currentPhase = 'rewrite-markdown';
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: 'Exporting spreadsheet workbook...',
            }));

            const standaloneSpreadsheet = exportStandaloneSpreadsheetDocument(docDetail, docPlan, bookPlan);
            primaryOutputPath = docPlan.targetMdPath;
            primaryOutputKind = 'markdown';
            rewrittenMarkdown = buildStandaloneSpreadsheetMarkdown(docPlan, standaloneSpreadsheet);
            skipGenericArtifactCapture = true;
          } else if (docExportRoute === 'export-table') {
            currentPhase = 'fetch-table-records';
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: 'Exporting structured Yuque table...',
            }));

            const standaloneTable = await withTimeout(
              withAuthenticatedExportPage(browserSession, config.cookiePath, (page) =>
                exportStandaloneTableDocument(
                  client,
                  page,
                  docDetail,
                  docPlan,
                  bookPlan,
                  {
                    ...config,
                    contentOutputDir,
                  },
                  recordDocIssue,
                ),
              ),
              MARKDOWN_TIMEOUT_MS,
              `Timed out while exporting the structured Yuque table for ${docPlan.node.name}.`,
            );

            primaryOutputPath =
              standaloneTable.primaryOutputPath ||
              standaloneTable.obsidian?.primaryBasePath ||
              standaloneTable.obsidian?.basePath ||
              docPlan.targetMdPath;
            primaryOutputKind = 'base';
            artifacts = {
              ...emptyArtifacts(),
              datatables: [standaloneTable.datatable],
              artifactKinds: ['datatable'],
              standaloneTables: [standaloneTable],
              requiresFallback: false,
              fallbackReason: '',
            };
            skipGenericArtifactCapture = true;
          } else if (docExportRoute === 'skip-empty') {
            completed += 1;
            bookContext.completed += 1;
            report.totals.skipped += 1;
            bookReport.summary.skipped += 1;

            exportState.markSkipped(docPlan);
            removeIfExists(docPlan.targetMdPath);
            bookReport.documents.push({
              name: docPlan.node.name,
              path: docPlan.targetMdPath,
              yuquePath: docPlan.absoluteDocUrl,
              status: 'skipped',
              reason: 'empty-document',
            });
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: `Skipped ${docPlan.node.name} because Yuque returned an empty document body.`,
              status: 'warning',
            }));
            activeDocPlan = null;
            continue;
          } else {
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: 'Fetching markdown...',
            }));
            markdown = await withTimeout(
              fetchMarkdown(client, docPlan.docUrl),
              MARKDOWN_TIMEOUT_MS,
              `Timed out while fetching markdown for ${docPlan.node.name}.`,
            );

            if (isTitleOnlyMarkdown(markdown, docPlan.node.name)) {
              completed += 1;
              bookContext.completed += 1;
              report.totals.skipped += 1;
              bookReport.summary.skipped += 1;

              exportState.markSkipped(docPlan);
              removeIfExists(docPlan.targetMdPath);
              bookReport.documents.push({
                name: docPlan.node.name,
                path: docPlan.targetMdPath,
                yuquePath: docPlan.absoluteDocUrl,
                status: 'skipped',
                reason: 'empty-document',
              });
              emit(buildDocEvent({
                bookPlan,
                docPlan,
                completed,
                totalDocuments: exportPlan.documents.length,
                bookCompleted: bookContext.completed,
                bookTotal: bookContext.total,
                message: `Skipped ${docPlan.node.name} because it only contains a title and no body content.`,
                status: 'warning',
              }));
              activeDocPlan = null;
              continue;
            }

            currentPhase = 'rewrite-markdown';
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: 'Rewriting links and downloading assets...',
            }));
            rewrittenMarkdown = await processMarkdown(markdown, {
              docName: docPlan.node.name,
              targetMdPath: docPlan.targetMdPath,
              docLinkMap,
              exportRoot: contentOutputDir,
              options: config,
              downloadAsset: (url, kind, downloadOptions = {}) =>
                downloadAsset(
                  client,
                  bookPlan,
                  docPlan,
                  url,
                  kind,
                emit,
                completed,
                  exportPlan.documents.length,
                  bookContext,
                  recordDocIssue,
                  {
                    browserSession,
                    cookiePath: config.cookiePath,
                    interactiveRecoveryLaunchOptions,
                    ...downloadOptions,
                  },
                ),
          });
            rewrittenMarkdown = await rewriteEmbeddedAssetCardPlaceholders(rewrittenMarkdown, docDetail, {
              targetMdPath: docPlan.targetMdPath,
              downloadAsset: (url, kind, downloadOptions = {}) =>
                downloadAsset(
                  client,
                  bookPlan,
                  docPlan,
                  url,
                  kind,
                  emit,
                  completed,
                  exportPlan.documents.length,
                  bookContext,
                  recordDocIssue,
                  {
                    browserSession,
                    cookiePath: config.cookiePath,
                    interactiveRecoveryLaunchOptions,
                    ...downloadOptions,
                  },
                ),
            });
          }

          if (!skipGenericArtifactCapture && primaryOutputKind !== 'base') {
            preparedBoards = prepareStructuredBoards(docDetail, docPlan, bookPlan, config);
            const standaloneExcalidraw = resolveStandaloneExcalidrawPrimary(docExportRoute, preparedBoards);
            if (standaloneExcalidraw) {
              primaryOutputPath = standaloneExcalidraw.excalidrawPath;
              primaryOutputKind = 'excalidraw';
            }
            complexArtifactPlan = planComplexArtifactWork({
              markdown,
              rewrittenMarkdown,
              complexBlockMode: config.complexBlockMode,
              preparedBoards,
              docDetail,
            });
            artifacts = complexArtifactPlan.baseArtifacts;
          }

          if (!skipGenericArtifactCapture && complexArtifactPlan?.needsWorker) {
            currentPhase = 'capture-artifacts';
            emit(buildDocEvent({
              bookPlan,
              docPlan,
              completed,
              totalDocuments: exportPlan.documents.length,
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
              message: 'Capturing tables and complex blocks...',
            }));
            artifacts = await withTimeout(
              executeComplexArtifactPlan(complexArtifactPlan, {
                runAttempt: async ({ attempt }) =>
                  await executeComplexArtifactWorkerProcess(
                    {
                      ...config,
                      contentOutputDir,
                    },
                    applyComplexArtifactRetryStrategy(
                      buildComplexArtifactWorkerTask({
                        bookPlan,
                        docPlan,
                        requestedTasks: complexArtifactPlan.requestedTasks,
                        preparedBoards,
                        contentOutputDir,
                      }),
                      attempt,
                    ),
                  ),
                onRetry: ({ attempt, nextAttempt, message }) => {
                  emit({
                    type: 'progress',
                    phase: 'artifact-warning',
                    status: 'warning',
                    book: bookPlan.book.name,
                    doc: docPlan.node.name,
                    targetMdPath: docPlan.targetMdPath,
                    message: `${bookPlan.book.name} / ${docPlan.node.name}: Complex block worker attempt ${attempt} failed, retrying once in safe mode...`,
                    error: message,
                    percent: percent(completed, exportPlan.documents.length),
                    bookPercent: percent(bookContext.completed, bookContext.total),
                    bookCompleted: bookContext.completed,
                    bookTotal: bookContext.total,
                  });
                },
              }),
              ARTIFACT_TIMEOUT_MS,
              `Timed out while capturing complex blocks for ${docPlan.node.name}.`,
            );

            if (artifacts.workerStatus === 'degraded') {
              emit({
                type: 'progress',
                phase: 'artifact-warning',
                status: 'warning',
                book: bookPlan.book.name,
                doc: docPlan.node.name,
                targetMdPath: docPlan.targetMdPath,
                message: `${bookPlan.book.name} / ${docPlan.node.name}: Complex block capture degraded and was skipped for this document.`,
                error: artifacts.degradedReason,
                percent: percent(completed, exportPlan.documents.length),
                bookPercent: percent(bookContext.completed, bookContext.total),
                bookCompleted: bookContext.completed,
                bookTotal: bookContext.total,
              });
            }

            if (artifacts.encryptedState.detectedCount > 0 && artifacts.encryptedState.remainingLockedCount > 0) {
              recordDocIssue({
                phase: 'encrypted-block-password-mismatch',
                error_type: 'EncryptedBlockLocked',
                error_message: buildEncryptedLockMessage(artifacts.encryptedState),
              });
            }
          }

          currentPhase =
            primaryOutputKind === 'base'
              ? 'write-base'
              : primaryOutputKind === 'excalidraw'
                ? 'write-excalidraw'
                : 'write-markdown';
          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message:
              primaryOutputKind === 'base'
                ? 'Writing Obsidian Base file...'
                : primaryOutputKind === 'excalidraw'
                  ? 'Writing Excalidraw drawing...'
                  : 'Writing markdown file...',
          }));
          recordArtifactExportWarnings(artifacts, recordDocIssue);
          recordDatatableExportWarnings(artifacts.datatables, recordDocIssue);

          if (primaryOutputKind === 'base') {
            if (!fs.existsSync(primaryOutputPath)) {
              throw new Error(`The standalone table base file was not written: ${primaryOutputPath}`);
            }
            if (primaryOutputPath !== docPlan.targetMdPath) {
              removeIfExists(docPlan.targetMdPath);
            }
          } else if (primaryOutputKind === 'excalidraw') {
            if (!fs.existsSync(primaryOutputPath)) {
              throw new Error(`The standalone Excalidraw drawing was not written: ${primaryOutputPath}`);
            }
          } else {
            const encryptedBlockRenderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
              reencryptEncryptedBlocksMode: config.reencryptEncryptedBlocksMode,
              reencryptGlobalPassword: config.reencryptGlobalPassword,
            });
            encryptedBlockReencryptionSummary = encryptedBlockRenderPlan.summary;
            recordEncryptedBlockRenderWarnings(encryptedBlockRenderPlan, recordDocIssue);
            let finalMarkdown = mergeMarkdownWithArtifacts(
              rewrittenMarkdown,
              artifacts,
              docPlan.targetMdPath,
              docPlan.absoluteDocUrl,
              {
                encryptedBlockRenderPlan,
              },
            );
            const repairedAssets = await repairMarkdownAssetReferences(finalMarkdown, {
              targetMdPath: docPlan.targetMdPath,
              renderedImages: artifacts.renderedImages,
              getRenderedImages: () =>
                getRenderedImageCatalog(docPlan, {
                  browserSession,
                  cookiePath: config.cookiePath,
                }),
              downloadAsset: (assetUrl, kind, repairOptions = {}) =>
                downloadAsset(
                  client,
                  bookPlan,
                  docPlan,
                  assetUrl,
                  kind,
                  emit,
                  completed,
                  exportPlan.documents.length,
                  bookContext,
                  recordDocIssue,
                  {
                    browserSession,
                    cookiePath: config.cookiePath,
                    interactiveRecoveryLaunchOptions,
                    suppressFailureIssue: true,
                    ...repairOptions,
                  },
                ),
              captureRenderedImageFallback: (candidate, repairOptions = {}) =>
                captureRenderedImageFallbackToLocalAsset(
                  bookPlan,
                  docPlan,
                  candidate,
                  repairOptions.fileNameHint || inferAssetFileName(candidate?.originalUrl || candidate?.downloadUrl, 'image'),
                  {
                    browserSession,
                    cookiePath: config.cookiePath,
                    interactiveRecoveryLaunchOptions,
                    cacheAliases: [candidate?.originalUrl, candidate?.downloadUrl].filter(Boolean),
                  },
                ),
            });
            finalMarkdown = repairedAssets.markdown;
            for (const issue of repairedAssets.issues) {
              recordDocIssue(issue);
            }
            recordMissingExportedAssetWarnings(finalMarkdown, docPlan.targetMdPath, recordDocIssue);
            fs.writeFileSync(docPlan.targetMdPath, finalMarkdown, 'utf8');
          }

          const datatableSummaries = summarizeDatatablesForReport(artifacts.datatables, docPlan, bookPlan);
          report.totals.datatables += datatableSummaries.length;
          report.datatables.push(...datatableSummaries);

          completed += 1;
          bookContext.completed += 1;
          report.totals.exported += 1;
          bookReport.summary.exported += 1;
          exportState.markExported(docPlan, {
            outputPath: primaryOutputPath,
            outputKind: primaryOutputKind,
          });
          bookReport.documents.push({
            name: docPlan.node.name,
            path: primaryOutputPath,
            yuquePath: docPlan.absoluteDocUrl,
            status: 'exported',
            datatables: datatableSummaries,
            warnings: docIssueTracker.warnings,
            encryptedBlockReencryption: encryptedBlockReencryptionSummary,
          });
          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message:
              docIssueTracker.warnings.length > 0
                ? `Exported ${docPlan.node.name} with ${docIssueTracker.warnings.length} warning(s)`
                : `Exported ${docPlan.node.name}`,
            status: docIssueTracker.warnings.length > 0 ? 'warning' : 'success',
          }));
        } catch (error) {
          completed += 1;
          bookContext.completed += 1;
          report.totals.failed += 1;
          bookReport.summary.failed += 1;

          const failure = {
            timestamp: new Date().toISOString(),
            book_name: bookPlan.book.name,
            doc_name: docPlan.node.name,
            yuque_path: docPlan.absoluteDocUrl,
            target_md_path: docPlan.targetMdPath,
            phase: currentPhase,
            error_type: error?.name ?? 'Error',
            error_message: errorToMessage(error),
            retry_count: 0,
          };

          failureLogger.append(failure);
          exportState.markFailed(docPlan, failure.error_message);

          try {
            const fallbackPreparedBoards = prepareStructuredBoards(docDetail, docPlan, bookPlan, config);
            const fallbackCardSlots =
              complexArtifactPlan?.baseArtifacts?.cardSlots?.length > 0 ? complexArtifactPlan.baseArtifacts.cardSlots : [];
            const fallbackPlan = {
              needsWorker: config.complexBlockMode !== 'skip',
              requestedTasks: {
                captureGenericArtifacts: true,
                captureDatatables: true,
                captureEncryptedTexts: true,
                captureBoardPngs: fallbackPreparedBoards.some((board) => board?.pngRequested),
                forceFallbackSnapshot: true,
              },
              baseArtifacts: createInitialComplexArtifacts(fallbackPreparedBoards, {
                needsWorker: config.complexBlockMode !== 'skip',
                requestedTasks: {
                  captureGenericArtifacts: true,
                  captureDatatables: true,
                  captureEncryptedTexts: true,
                  captureBoardPngs: fallbackPreparedBoards.some((board) => board?.pngRequested),
                  forceFallbackSnapshot: true,
                },
                cardSlots: fallbackCardSlots,
              }),
            };
            const artifacts = await executeComplexArtifactPlan(fallbackPlan, {
              runAttempt: async () =>
                await executeComplexArtifactWorkerProcess(
                  {
                    ...config,
                    contentOutputDir,
                  },
                  buildComplexArtifactWorkerTask({
                    bookPlan,
                    docPlan,
                    requestedTasks: fallbackPlan.requestedTasks,
                    preparedBoards: fallbackPreparedBoards,
                    contentOutputDir,
                    fallbackReason: 'export-failure',
                  }),
                ),
            });
            const encryptedBlockRenderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
              reencryptEncryptedBlocksMode: config.reencryptEncryptedBlocksMode,
              reencryptGlobalPassword: config.reencryptGlobalPassword,
            });
            recordEncryptedBlockRenderWarnings(encryptedBlockRenderPlan, (issue) => failureLogger.append({
              timestamp: new Date().toISOString(),
              book_name: bookPlan.book.name,
              doc_name: docPlan.node.name,
              yuque_path: docPlan.absoluteDocUrl,
              target_md_path: docPlan.targetMdPath,
              phase: issue.phase || 'write-markdown',
              error_type: issue.error_type || 'EncryptedBlockReencryptionSkipped',
              error_message: issue.error_message || 'Encrypted block re-encryption encountered a warning.',
              retry_count: 0,
            }));
            fs.writeFileSync(
              docPlan.targetMdPath,
              buildPlaceholderMarkdown(docPlan, failure, artifacts, {
                baseMarkdown: rewrittenMarkdown || markdown || '',
                warningEntries: docIssueTracker.warnings,
                encryptedBlockRenderPlan,
              }),
              'utf8',
            );
            const datatableSummaries = summarizeDatatablesForReport(artifacts.datatables, docPlan, bookPlan);
            report.totals.datatables += datatableSummaries.length;
            report.datatables.push(...datatableSummaries);
            failure.datatables = datatableSummaries;
            if (artifacts.workerStatus === 'degraded') {
              emit({
                type: 'progress',
                phase: 'artifact-warning',
                status: 'warning',
                book: bookPlan.book.name,
                doc: docPlan.node.name,
                targetMdPath: docPlan.targetMdPath,
                message: `${bookPlan.book.name} / ${docPlan.node.name}: Placeholder snapshot capture degraded and only failure notes were kept.`,
                error: artifacts.degradedReason,
                percent: percent(completed, exportPlan.documents.length),
                bookPercent: percent(bookContext.completed, bookContext.total),
                bookCompleted: bookContext.completed,
                bookTotal: bookContext.total,
              });
            }
          } catch (placeholderError) {
            emit({
              type: 'progress',
              phase: 'placeholder-warning',
              status: 'warning',
              book: bookPlan.book.name,
              doc: docPlan.node.name,
              targetMdPath: docPlan.targetMdPath,
              message: `${bookPlan.book.name} / ${docPlan.node.name}: Failed to write placeholder markdown: ${errorToMessage(placeholderError)}`,
              error: errorToMessage(placeholderError),
              percent: percent(completed, exportPlan.documents.length),
              bookPercent: percent(bookContext.completed, bookContext.total),
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
            });
          }

          bookReport.documents.push({
            name: docPlan.node.name,
            path: docPlan.targetMdPath,
            yuquePath: docPlan.absoluteDocUrl,
            status: 'failed',
            error: failure.error_message,
            datatables: failure.datatables || [],
          });
          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message: `Failed to export ${docPlan.node.name}`,
            status: 'error',
            error: failure.error_message,
          }));
        }

        } finally {
          await disposeDocumentInteractiveRecoverySession(docPlan);
          activeDocPlan = null;
        }
      }
    }

    report.finishedAt = new Date().toISOString();
    report.status = 'success';
    exportState.saveMeta({
      status: 'success',
      lastRunFinishedAt: report.finishedAt,
    });
    report.obsidian = finalizeObsidianSetup(config, report, emit);
    return finalizeExport(report, failureLogger, emit);
  } catch (error) {
      failureLogger.append({
        timestamp: new Date().toISOString(),
        book_name: activeDocPlan?.book?.name ?? lastBookContext?.bookPlan?.book?.name ?? '',
      doc_name: activeDocPlan?.node?.name ?? '',
      yuque_path: activeDocPlan?.absoluteDocUrl ?? '',
      target_md_path: activeDocPlan?.targetMdPath ?? '',
      phase: 'job-aborted',
      error_type: error?.name ?? 'Error',
      error_message: errorToMessage(error),
      retry_count: 0,
    });
    exportState.saveMeta({
      status: 'error',
      lastRunFinishedAt: new Date().toISOString(),
      lastError: errorToMessage(error),
    });
    emit({
      type: 'progress',
      phase: 'fatal',
      status: 'error',
      message: errorToMessage(error),
      error: errorToMessage(error),
      percent: 100,
      bookPercent: 100,
      });
      throw error;
  } finally {
      control.clear();
      await disposeDocumentInteractiveRecoverySession(activeDocPlan);
      activeDocPlan = null;
      await browserSession.dispose();
  }
}

export async function exportMarkDownFiles() {
  const config = {
    browserPath: process.env.BROWSER_PATH || '',
    cookiePath: process.env.COOKIE_PATH || path.join(process.cwd(), 'cookies.json'),
    outputDir: process.env.EXPORT_PATH || path.join(process.cwd(), 'output'),
    obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH || '',
    obsidianSetupMode: process.env.OBSIDIAN_SETUP_MODE || 'none',
    vaultExportLayout: process.env.VAULT_EXPORT_LAYOUT || 'output-only',
    vaultExportSubdir: process.env.VAULT_EXPORT_SUBDIR ?? '',
    selectedBooks: [],
    downloadImages: process.env.DOWNLOAD_IMAGES !== 'false',
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS !== 'false',
    incrementalExport: process.env.INCREMENTAL_EXPORT !== 'false',
    encryptedBlockPasswords: parseEnvPasswordList(process.env.ENCRYPTED_BLOCK_PASSWORDS, process.env.ENCRYPTED_BLOCK_PASSWORD),
    encryptedBlockPassword: process.env.ENCRYPTED_BLOCK_PASSWORD || '',
    reencryptEncryptedBlocksMode: normalizeReencryptMode(process.env.REENCRYPT_ENCRYPTED_BLOCKS_MODE || 'off'),
    reencryptGlobalPassword: process.env.REENCRYPT_GLOBAL_PASSWORD || '',
    datatableExportMode: 'structured-first',
    complexBlockMode: 'auto',
    diagramExportMode: process.env.DIAGRAM_EXPORT_MODE || 'auto',
    diagramSnapshotMode: process.env.DIAGRAM_SNAPSHOT_MODE || 'fallback-only',
    assetLayout: 'book_assets',
    jobControlPath: '',
  };
  return await exportBooks(config, (event) => {
    if (event.message) {
      console.log(event.message);
    }
  });
}

export function resolveComplexBlockMode(config) {
  return normalizeComplexBlockModeValue(config?.complexBlockMode || 'auto');
}

function resolveBoardSnapshotMode(options = {}) {
  if (normalizeComplexBlockModeValue(options?.complexBlockMode) === 'skip') {
    return 'disabled';
  }
  const configured = String(options?.diagramSnapshotMode || '').trim().toLowerCase();
  return ['disabled', 'fallback-only', 'supplemental'].includes(configured) ? configured : 'fallback-only';
}

function normalizeComplexBlockModeValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['snapshot-first', 'structured-first', 'skip', 'auto'].includes(normalized) ? normalized : 'auto';
}

function countGenericCardPlaceholders(markdown) {
  if (!markdown) {
    return 0;
  }
  return [...String(markdown).matchAll(GENERIC_CARD_PLACEHOLDER_RE)].length;
}

function extractGenericCardPlaceholders(markdown) {
  return [...String(markdown || '').matchAll(GENERIC_CARD_PLACEHOLDER_RE)].map((match, index) => ({
    index,
    label: String(match[1] || '').trim(),
    url: String(match[2] || '').trim(),
  }));
}

function parseCardTagAttributes(source) {
  const attributes = {};
  const attributeRe = /([a-zA-Z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attributeRe.exec(String(source || '')))) {
    attributes[String(match[1] || '').trim().toLowerCase()] = match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function classifyEmbeddedCardKind(cardName, cardType = '') {
  const normalizedName = `${String(cardName || '').trim().toLowerCase()} ${String(cardType || '').trim().toLowerCase()}`.trim();
  if (!normalizedName) {
    return 'unknown';
  }
  if (
    /(?:^|[-_:])(locked|encrypt(?:ed)?|secret|password)(?:$|[-_:])/.test(normalizedName) ||
    /(locked-text|lockedtext|encrypt(?:ed)?|secret|password)/.test(normalizedName)
  ) {
    return 'encrypted';
  }
  if (/(?:^|[-_:])(database|table|sheet)(?:$|[-_:])/.test(normalizedName) || /(database|table|sheet|laketable)/.test(normalizedName)) {
    return 'datatable';
  }
  if (/(?:^|[-_:])(board|lakeboard)(?:$|[-_:])/.test(normalizedName) || /(board|lakeboard)/.test(normalizedName)) {
    return 'board';
  }
  if (/(attachment|audio|video|media|file|upload|docx?|pdf|pptx?|xlsx?|mp[34]|mov)/.test(normalizedName)) {
    return 'attachment';
  }
  return 'unknown';
}

function extractEmbeddedCardsFromDocDetail(docDetail) {
  const sources = [
    typeof docDetail?.content === 'string' ? docDetail.content : '',
    typeof docDetail?.body === 'string' ? docDetail.body : '',
  ];
  const source = sources.sort((left, right) => right.length - left.length)[0] || '';
  if (!source) {
    return [];
  }

  const cards = [];
  EMBEDDED_CARD_TAG_RE.lastIndex = 0;
  let match;
  while ((match = EMBEDDED_CARD_TAG_RE.exec(source))) {
    const attributes = parseCardTagAttributes(match[1] || '');
    const asset = extractEmbeddedCardAssetInfo(attributes);
    cards.push({
      index: cards.length,
      cardName: String(attributes.name || '').trim(),
      cardType: String(attributes.type || '').trim(),
      kind: classifyEmbeddedCardKind(attributes.name, attributes.type),
      assetUrl: asset.url,
      assetLabel: asset.label,
      assetFileNameHint: asset.fileNameHint,
      rawTag: match[0],
    });
  }
  return cards;
}

function buildEmbeddedCardSlots(markdown, docDetail) {
  const placeholders = extractGenericCardPlaceholders(markdown);
  if (placeholders.length === 0) {
    return [];
  }

  const slots = placeholders.map((placeholder) => ({
    index: placeholder.index,
    url: placeholder.url,
      label: placeholder.label,
      kind: 'unknown',
      cardName: '',
      cardType: '',
      assetUrl: '',
      assetLabel: '',
      assetFileNameHint: '',
      datatableIndex: -1,
      boardIndex: -1,
      resolved: false,
    }));

  const embeddedCards = extractEmbeddedCardsFromDocDetail(docDetail);
  if (embeddedCards.length !== placeholders.length) {
    return slots;
  }

  return slots.map((slot, index) => ({
    ...slot,
    kind: embeddedCards[index]?.kind || 'unknown',
    cardName: embeddedCards[index]?.cardName || '',
    cardType: embeddedCards[index]?.cardType || '',
    assetUrl: embeddedCards[index]?.assetUrl || '',
    assetLabel: embeddedCards[index]?.assetLabel || '',
    assetFileNameHint: embeddedCards[index]?.assetFileNameHint || '',
  }));
}

function normalizeCardSlots(cardSlots = []) {
  return Array.isArray(cardSlots)
    ? cardSlots.map((slot, index) => ({
        index,
        url: String(slot?.url || '').trim(),
        label: String(slot?.label || '').trim() || '此处为语雀卡片，点击链接查看',
        kind:
          slot?.kind === 'encrypted'
            ? 'encrypted'
            : slot?.kind === 'datatable'
              ? 'datatable'
              : slot?.kind === 'board'
                ? 'board'
                : slot?.kind === 'attachment'
                  ? 'attachment'
                  : 'unknown',
        cardName: String(slot?.cardName || '').trim(),
        cardType: String(slot?.cardType || '').trim(),
        assetUrl: String(slot?.assetUrl || '').trim(),
        assetLabel: String(slot?.assetLabel || '').trim(),
        assetFileNameHint: String(slot?.assetFileNameHint || '').trim(),
        datatableIndex: Number.isInteger(slot?.datatableIndex) ? slot.datatableIndex : -1,
        boardIndex: Number.isInteger(slot?.boardIndex) ? slot.boardIndex : -1,
        resolved: slot?.resolved === true,
      }))
    : [];
}

function assignDatatableSlots(cardSlots = [], datatables = []) {
  const normalizedSlots = normalizeCardSlots(cardSlots);
  const normalizedDatatables = Array.isArray(datatables)
    ? datatables.map((datatable) => ({
        ...datatable,
      }))
    : [];

  if (normalizedSlots.length === 0 || normalizedDatatables.length === 0) {
    return {
      cardSlots: normalizedSlots,
      datatables: normalizedDatatables,
    };
  }

  const availableSlotIndexes = normalizedSlots.filter((slot) => slot.kind === 'datatable').map((slot) => slot.index);
  const nextSlots = normalizedSlots.map((slot) => ({
    ...slot,
    datatableIndex: -1,
    resolved: false,
  }));

  normalizedDatatables.forEach((datatable, index) => {
    const explicitSlotIndex = Number.isInteger(datatable?.slotIndex) ? datatable.slotIndex : -1;
    const slotIndex = explicitSlotIndex >= 0 ? explicitSlotIndex : availableSlotIndexes[index] ?? -1;
    normalizedDatatables[index] = {
      ...datatable,
      slotIndex,
    };
    if (slotIndex >= 0 && nextSlots[slotIndex]) {
      nextSlots[slotIndex] = {
        ...nextSlots[slotIndex],
        kind: 'datatable',
        datatableIndex: index,
        resolved: true,
      };
    }
  });

  return {
    cardSlots: nextSlots,
    datatables: normalizedDatatables,
  };
}

function assignBoardSlots(cardSlots = [], boards = []) {
  const normalizedSlots = normalizeCardSlots(cardSlots);
  const normalizedBoards = Array.isArray(boards)
    ? boards.map((board) => ({
        ...board,
      }))
    : [];

  if (normalizedSlots.length === 0 || normalizedBoards.length === 0) {
    return {
      cardSlots: normalizedSlots,
      boards: normalizedBoards,
    };
  }

  const availableSlotIndexes = normalizedSlots.filter((slot) => slot.kind === 'board').map((slot) => slot.index);
  const nextSlots = normalizedSlots.map((slot) => ({
    ...slot,
    boardIndex: -1,
    resolved: slot.kind === 'datatable' ? slot.resolved : false,
  }));

  normalizedBoards.forEach((board, index) => {
    const explicitSlotIndex = Number.isInteger(board?.slotIndex) ? board.slotIndex : -1;
    const slotIndex = explicitSlotIndex >= 0 ? explicitSlotIndex : availableSlotIndexes[index] ?? -1;
    normalizedBoards[index] = {
      ...board,
      slotIndex,
    };
    if (slotIndex >= 0 && nextSlots[slotIndex]) {
      nextSlots[slotIndex] = {
        ...nextSlots[slotIndex],
        kind: 'board',
        boardIndex: index,
        resolved: true,
      };
    }
  });

  return {
    cardSlots: nextSlots,
    boards: normalizedBoards,
  };
}

function extractEmbeddedCardAssetInfo(attributes = {}) {
  const labelCandidates = [
    attributes.label,
    attributes.title,
    attributes.filename,
    attributes['file-name'],
    attributes.name,
    attributes.text,
  ];
  const directUrlKeys = ['url', 'href', 'src', 'file', 'downloadurl', 'download-url', 'fileurl', 'file-url'];
  for (const key of directUrlKeys) {
    const directUrl = normalizeEmbeddedCardAssetUrl(attributes[key]);
    if (directUrl) {
      return {
        url: directUrl,
        label: pickFirstText(labelCandidates) || inferAssetLabelFromUrl(directUrl),
        fileNameHint: inferAssetLabelFromUrl(directUrl),
      };
    }
  }

  const nestedValueKeys = ['value', 'data', 'payload', 'meta', 'defaultvalue', 'default-value'];
  for (const key of nestedValueKeys) {
    const nestedInfo = extractEmbeddedCardAssetInfoFromValue(attributes[key], labelCandidates);
    if (nestedInfo.url) {
      return nestedInfo;
    }
  }

  return {
    url: '',
    label: pickFirstText(labelCandidates),
    fileNameHint: '',
  };
}

function extractEmbeddedCardAssetInfoFromValue(rawValue, labelCandidates = []) {
  const directUrl = normalizeEmbeddedCardAssetUrl(rawValue);
  if (directUrl) {
    return {
      url: directUrl,
      label: pickFirstText(labelCandidates) || inferAssetLabelFromUrl(directUrl),
      fileNameHint: inferAssetLabelFromUrl(directUrl),
    };
  }

  const decodedPayload = decodeEmbeddedCardPayload(rawValue);
  const discovered = findEmbeddedAttachmentCandidate(decodedPayload);
  if (!discovered.url) {
    return { url: '', label: pickFirstText(labelCandidates), fileNameHint: '' };
  }

  return {
    url: discovered.url,
    label: pickFirstText([discovered.label, ...labelCandidates]) || inferAssetLabelFromUrl(discovered.url),
    fileNameHint: discovered.fileNameHint || inferAssetLabelFromUrl(discovered.url),
  };
}

function decodeEmbeddedCardPayload(rawValue) {
  const source = String(rawValue || '').trim();
  if (!source) {
    return null;
  }
  if (source.startsWith('data:')) {
    try {
      return JSON.parse(decodeURIComponent(source.slice(5)));
    } catch {
      return null;
    }
  }
  if ((source.startsWith('{') && source.endsWith('}')) || (source.startsWith('[') && source.endsWith(']'))) {
    try {
      return JSON.parse(source);
    } catch {
      return null;
    }
  }
  return null;
}

function findEmbeddedAttachmentCandidate(value) {
  if (typeof value === 'string') {
    const directUrl = normalizeEmbeddedCardAssetUrl(value);
    return directUrl ? { url: directUrl, label: '', fileNameHint: inferAssetLabelFromUrl(directUrl) } : { url: '' };
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const discovered = findEmbeddedAttachmentCandidate(item);
      if (discovered.url) {
        return discovered;
      }
    }
    return { url: '' };
  }

  if (!value || typeof value !== 'object') {
    return { url: '' };
  }

  const preferredUrlKeys = ['downloadUrl', 'download_url', 'fileUrl', 'file_url', 'src', 'url', 'href', 'originUrl', 'origin_url'];
  const preferredLabelKeys = ['title', 'name', 'filename', 'fileName', 'label', 'text'];
  for (const key of preferredUrlKeys) {
    const directUrl = normalizeEmbeddedCardAssetUrl(value[key]);
    if (directUrl) {
      return {
        url: directUrl,
        label: pickFirstText(preferredLabelKeys.map((labelKey) => value[labelKey])),
        fileNameHint: inferAssetLabelFromUrl(directUrl),
      };
    }
  }

  for (const nestedValue of Object.values(value)) {
    const discovered = findEmbeddedAttachmentCandidate(nestedValue);
    if (discovered.url) {
      return discovered;
    }
  }

  return { url: '' };
}

function normalizeEmbeddedCardAssetUrl(value) {
  const source = String(value || '').trim();
  if (!/^https?:\/\//i.test(source)) {
    return '';
  }

  try {
    const parsed = new URL(source);
    return isLikelyAttachment(parsed) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function pickFirstText(values = []) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function inferAssetLabelFromUrl(assetUrl) {
  try {
    return path.basename(new URL(assetUrl).pathname) || '附件';
  } catch {
    return '附件';
  }
}

async function rewriteEmbeddedAssetCardPlaceholders(markdown, docDetail, context = {}) {
  const cardSlots = buildEmbeddedCardSlots(markdown, docDetail);
  if (cardSlots.length === 0) {
    return markdown;
  }

  let placeholderIndex = 0;
  return replaceAsync(markdown, GENERIC_CARD_PLACEHOLDER_RE, async (match) => {
    const slot = cardSlots[placeholderIndex];
    placeholderIndex += 1;

    if (!slot || slot.kind !== 'attachment' || !slot.assetUrl || typeof context.downloadAsset !== 'function') {
      return match;
    }

    const localAssetPath = await context.downloadAsset(slot.assetUrl, 'file', {
      fileNameHint: slot.assetFileNameHint || inferAssetLabelFromUrl(slot.assetUrl),
    });
    if (!localAssetPath) {
      return match;
    }

    const label = slot.assetLabel || inferAssetLabelFromUrl(slot.assetUrl);
    const relativePath = relativeMarkdownPath(context.targetMdPath, localAssetPath);
    return isEmbeddedMediaPath(localAssetPath) ? `![${label}](${relativePath})` : `[${label}](${relativePath})`;
  });
}

function isEmbeddedMediaPath(filePath) {
  const extension = path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
  return EMBEDDED_MEDIA_EXTENSIONS.has(extension);
}

function mergePartialArtifacts(currentArtifacts, nextArtifacts) {
  if (!nextArtifacts) {
    return currentArtifacts || null;
  }

  const current = normalizeArtifacts(currentArtifacts || emptyArtifacts());
  const next = normalizeArtifacts(nextArtifacts);

  return normalizeArtifacts({
    ...current,
    ...next,
    tables: next.tables.length > 0 ? next.tables : current.tables,
    datatables: next.datatables.length > 0 ? next.datatables : current.datatables,
    standaloneTables: next.standaloneTables.length > 0 ? next.standaloneTables : current.standaloneTables,
    boards: next.boards.length > 0 ? next.boards : current.boards,
    codeBlocks: next.codeBlocks.length > 0 ? next.codeBlocks : current.codeBlocks,
    renderedImages: next.renderedImages.length > 0 ? next.renderedImages : current.renderedImages,
    blockImages: next.blockImages.length > 0 ? next.blockImages : current.blockImages,
    encryptedBlocks: next.encryptedBlocks.length > 0 ? next.encryptedBlocks : current.encryptedBlocks,
    artifactKinds: dedupeTexts([...(current.artifactKinds || []), ...(next.artifactKinds || [])]),
    encryptedState: {
      ...(current.encryptedState || {}),
      ...(next.encryptedState || {}),
    },
  });
}

function buildWorkerCheckpointPayload(artifacts, meta = {}) {
  return {
    status: 'partial',
    stage: String(meta.stage || '').trim(),
    artifacts: normalizeArtifacts(artifacts),
  };
}

function unwrapWorkerArtifactsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (payload.status === 'partial' && payload.artifacts && typeof payload.artifacts === 'object') {
    return payload.artifacts;
  }
  return payload;
}

function cloneJsonValue(value, fallbackValue = null) {
  if (value == null) {
    return fallbackValue;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function buildArtifactKindsFromBoards(boards = []) {
  if (!Array.isArray(boards) || boards.length === 0) {
    return [];
  }
  return dedupeTexts([
    'board',
    ...(boards.some((board) => board?.isPureMindmap) ? ['mindmap'] : []),
  ]);
}

function createInitialComplexArtifacts(preparedBoards = [], options = {}) {
  return {
    ...emptyArtifacts(),
    boards: cloneJsonValue(preparedBoards, []),
    cardSlots: normalizeCardSlots(options.cardSlots),
    artifactKinds: buildArtifactKindsFromBoards(preparedBoards),
    needsWorker: Boolean(options.needsWorker),
    requestedTasks: cloneJsonValue(options.requestedTasks, {}),
    workerStatus: options.needsWorker ? 'pending' : 'skipped-unneeded',
    retryCount: 0,
    crashExitCode: '',
    degradedReason: '',
  };
}

function isInlineOnlyComplexCardKind(kind) {
  return kind === 'encrypted' || kind === 'attachment';
}

function hasLikelyEncryptedCardMarkup(docDetail) {
  const sources = [
    typeof docDetail?.content === 'string' ? docDetail.content : '',
    typeof docDetail?.body === 'string' ? docDetail.body : '',
  ];
  return sources.some((source) =>
    /<card\b[^>]*(?:name|type)\s*=\s*["'][^"']*(?:locked(?:-text)?|encrypt(?:ed)?|secret|password)[^"']*["']/i.test(
      source,
    ),
  );
}

export function prepareStructuredBoards(docDetail, docPlan, bookPlan, options = {}) {
  const sourceBoards = extractBoardsFromDocDetail(docDetail);
  if (sourceBoards.length === 0) {
    return [];
  }

  const documentDir = ensureDir(path.join(bookPlan.assets.boards, buildBoardDocumentDirName(bookPlan, docPlan)));
  const exported = [];

  for (const [index, sourceBoard] of sourceBoards.entries()) {
    const files = writeBoardSidecarFiles(sourceBoard.diagramData, documentDir, index);
    const renderPlan = createBoardRenderPlan(sourceBoard.diagramData, {
      diagramExportMode: options.diagramExportMode,
      diagramSnapshotMode: resolveBoardSnapshotMode(options),
      capabilities: options.diagramCapabilities,
      // 直接调用旧 API 的第三方脚本继续获得 Canvas 侧车；桌面端新配置会显式传入模式，默认不再制造额外 Canvas。
      emitCanvasCompatibility: options.emitCanvasCompatibility === true || options.diagramExportMode === undefined,
    });
    if (renderPlan.canvasDocument) {
      writeJson(files.canvasPath, renderPlan.canvasDocument);
    }
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(sourceBoard.diagramData)).digest('hex');
    const excalidrawResult = renderPlan.excalidrawRequested
      ? persistBoardExcalidrawArtifact({
          sourceBoard,
          renderPlan,
          files,
          docPlan,
          sourceHash,
          index,
        })
      : null;
    if (excalidrawResult?.path) {
      renderPlan.structuredExport = true;
      renderPlan.structuredFormat = 'excalidraw-flowchart';
      renderPlan.primaryFormat = 'excalidraw';
      renderPlan.excalidrawPath = excalidrawResult.path;
      renderPlan.excalidrawStatus = excalidrawResult.status;
      renderPlan.warnings.push(...excalidrawResult.warnings);
    }
    const manifest = createBoardManifest(renderPlan, {
      sourceHash,
      generatedHash: excalidrawResult?.generatedHash || '',
      sourceType: sourceBoard.sourceType,
      title: resolveStructuredBoardTitle(sourceBoard, renderPlan.ir.kind, index),
      generatedFiles: [
        files.jsonPath,
        ...(renderPlan.canvasDocument ? [files.canvasPath] : []),
        ...(excalidrawResult?.path ? [excalidrawResult.path] : []),
      ],
    });
    writeJson(files.manifestPath, manifest);

    exported.push({
      index,
      title: resolveStructuredBoardTitle(sourceBoard, renderPlan.ir.kind, index),
      sourceType: sourceBoard.sourceType,
      diagramData: sourceBoard.diagramData,
      boardIR: renderPlan.ir,
      classification: renderPlan.classification,
      primaryFormat: renderPlan.primaryFormat,
      isPureMindmap: renderPlan.ir.kind === 'mindmap',
      detectedKind: renderPlan.ir.kind,
      structuredFormat: renderPlan.structuredFormat,
      structuredExport: renderPlan.structuredExport,
      failureReason: renderPlan.failureReason,
      markdown: renderPlan.markdown,
      mermaid: renderPlan.mermaid,
      canvasDocument: renderPlan.canvasDocument,
      partialStructured: renderPlan.partialStructured,
      ignoredElementCount: renderPlan.ignoredElementCount,
      fallbackRequired: renderPlan.fallbackRequired,
      excalidrawRequested: renderPlan.excalidrawRequested,
      excalidrawPath: excalidrawResult?.path || '',
      excalidrawStatus: excalidrawResult?.status || '',
      warnings: renderPlan.warnings,
      files,
      pngRequested: renderPlan.pngRequested,
      pngOptional: false,
      pngCaptured: false,
      pngCaptureError: '',
    });
  }

  return exported;
}

export function planComplexArtifactWork({
  markdown = '',
  rewrittenMarkdown = '',
  complexBlockMode = 'auto',
  preparedBoards = [],
  docDetail = null,
} = {}) {
  const mode = normalizeComplexBlockModeValue(complexBlockMode);
  const normalizedMarkdown = rewrittenMarkdown || markdown;
  const placeholderCount = countGenericCardPlaceholders(normalizedMarkdown);
  const cardSlots = buildEmbeddedCardSlots(normalizedMarkdown, docDetail);
  const hasDatatableSlots = cardSlots.some((slot) => slot.kind === 'datatable');
  const hasEncryptedSlots =
    cardSlots.some((slot) => slot.kind === 'encrypted') || hasLikelyEncryptedCardMarkup(docDetail);
  const hasUnknownSlots = cardSlots.some((slot) => slot.kind === 'unknown');
  const hasInlineOnlySlots =
    placeholderCount > 0 &&
    cardSlots.length === placeholderCount &&
    cardSlots.every((slot) => isInlineOnlyComplexCardKind(slot.kind));
  const requestedTasks = {
    captureGenericArtifacts: mode !== 'skip' && placeholderCount > 0 && !hasInlineOnlySlots,
    captureDatatables: mode !== 'skip' && hasDatatableSlots,
    captureEncryptedTexts: mode !== 'skip' && placeholderCount > 0 && hasEncryptedSlots,
    captureBoardPngs:
      mode !== 'skip' &&
      Array.isArray(preparedBoards) &&
      preparedBoards.some((board) => board?.pngRequested),
    forceFallbackSnapshot: false,
  };
  if (requestedTasks.captureGenericArtifacts && !hasUnknownSlots && !hasDatatableSlots && !requestedTasks.captureBoardPngs) {
    requestedTasks.captureGenericArtifacts = false;
  }
  const needsWorker = Object.values(requestedTasks).some(Boolean);

  return {
    needsWorker,
    placeholderCount,
    structuredBoards: cloneJsonValue(preparedBoards, []),
    requestedTasks,
    baseArtifacts: createInitialComplexArtifacts(preparedBoards, {
      needsWorker,
      requestedTasks,
      cardSlots,
    }),
  };
}

function formatExitCodeHex(exitCode) {
  if (!Number.isFinite(exitCode)) {
    return '';
  }
  return `0x${(Number(exitCode) >>> 0).toString(16).toUpperCase()}`;
}

function isNativeWorkerCrash(error) {
  const exitCode = Number(error?.exitCode);
  if (!Number.isFinite(exitCode)) {
    return false;
  }
  return exitCode > 255;
}

function extractComplexArtifactCrashExitCode(error) {
  const exitCode = Number(error?.exitCode);
  if (!Number.isFinite(exitCode)) {
    return '';
  }
  return `${exitCode} (${formatExitCodeHex(exitCode)})`;
}

function buildComplexArtifactWorkerErrorMessage(error) {
  if (isNativeWorkerCrash(error)) {
    return `Complex artifact worker crashed with exit code ${extractComplexArtifactCrashExitCode(error)}.`;
  }
  return errorToMessage(error);
}

function shouldRetryComplexArtifactWorkerError(error) {
  return Boolean(error?.isWorkerCrash) || isBrowserDisconnectedError(error);
}

export async function executeComplexArtifactPlan(plan, options = {}) {
  const baseArtifacts = normalizeArtifacts(cloneJsonValue(plan?.baseArtifacts, emptyArtifacts()) || emptyArtifacts());
  baseArtifacts.needsWorker = Boolean(plan?.needsWorker);
  baseArtifacts.requestedTasks = cloneJsonValue(plan?.requestedTasks, {}) || {};
  baseArtifacts.workerStatus = plan?.needsWorker ? 'pending' : 'skipped-unneeded';
  baseArtifacts.retryCount = 0;
  baseArtifacts.crashExitCode = '';
  baseArtifacts.degradedReason = '';

  if (!plan?.needsWorker) {
    return baseArtifacts;
  }

  let lastError = null;
  let retainedPartialArtifacts = null;

  for (let attempt = 1; attempt <= COMPLEX_ARTIFACT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const attemptArtifacts = await options.runAttempt?.({ attempt, plan });
      return normalizeArtifacts({
        ...baseArtifacts,
        ...(attemptArtifacts || {}),
        needsWorker: true,
        requestedTasks: cloneJsonValue(plan?.requestedTasks, {}) || {},
        workerStatus: attempt > 1 ? 'retried-success' : 'success',
        retryCount: attempt - 1,
        crashExitCode: '',
        degradedReason: '',
      });
    } catch (error) {
      lastError = error;
      if (error?.partialArtifacts) {
        retainedPartialArtifacts = mergePartialArtifacts(retainedPartialArtifacts, error.partialArtifacts);
      }
      if (attempt < COMPLEX_ARTIFACT_MAX_ATTEMPTS && shouldRetryComplexArtifactWorkerError(error)) {
        options.onRetry?.({
          attempt,
          nextAttempt: attempt + 1,
          error,
          message: buildComplexArtifactWorkerErrorMessage(error),
        });
        continue;
      }
      break;
    }
  }

  return normalizeArtifacts({
    ...baseArtifacts,
    ...(retainedPartialArtifacts || {}),
    cardSlots: retainedPartialArtifacts?.cardSlots?.length > 0 ? retainedPartialArtifacts.cardSlots : baseArtifacts.cardSlots,
    needsWorker: true,
    requestedTasks: cloneJsonValue(plan?.requestedTasks, {}) || {},
    workerStatus: 'degraded',
    retryCount: shouldRetryComplexArtifactWorkerError(lastError) ? COMPLEX_ARTIFACT_MAX_ATTEMPTS - 1 : 0,
    crashExitCode: extractComplexArtifactCrashExitCode(lastError),
    degradedReason: buildComplexArtifactWorkerErrorMessage(lastError),
  });
}

export function createSelectionMatcher(config = {}) {
  const explicitDocuments = new Set((config.selectedDocuments || []).map(normalizeSelectedDocumentValue).filter(Boolean));
  const wholeBookSelectionSource =
    Array.isArray(config.fullySelectedBooks) && config.fullySelectedBooks.length > 0
      ? config.fullySelectedBooks
      : explicitDocuments.size === 0
        ? config.selectedBooks || []
        : [];
  const fullySelectedBooks = new Set(wholeBookSelectionSource.map((value) => String(value)));

  return {
    fullySelectedBooks,
    explicitDocuments,
    shouldIncludeDocument(bookId, absoluteDocUrl) {
      if (fullySelectedBooks.has(String(bookId))) {
        return true;
      }
      if (explicitDocuments.size === 0) {
        return true;
      }
      return explicitDocuments.has(normalizeSelectedDocumentValue(absoluteDocUrl));
    },
  };
}

function normalizeSelectedDocumentValue(value) {
  return String(value ?? '').trim().replace(/\/$/, '');
}

function buildExportPlan(books, outputDir, selectionMatcher = createSelectionMatcher()) {
  const allocator = createAllocator();
  const plan = { books: [], documents: [] };

  for (const book of books) {
    const bookDir = path.join(outputDir, allocator.uniqueDir(outputDir, sanitizeFileName(book.name)));
    const assets = {
      root: ensureDir(path.join(bookDir, '_assets')),
    };
    assets.images = ensureDir(path.join(assets.root, 'images'));
    assets.files = ensureDir(path.join(assets.root, 'files'));
    assets.blocks = ensureDir(path.join(assets.root, 'blocks'));
    assets.boards = ensureDir(path.join(assets.root, 'boards'));
    assets.datatables = ensureDir(path.join(assets.root, 'datatables'));
    assets.spreadsheets = ensureDir(path.join(assets.root, 'spreadsheets'));

    const bookPlan = {
      book,
      bookDir,
      assets,
      documents: [],
      assetCache: new Map(),
      assetNames: new Map(),
    };

    annotateNode(book.root, bookDir, bookPlan, allocator, plan.documents, selectionMatcher);
    plan.books.push(bookPlan);
  }

  return plan;
}

function annotateNode(node, currentDir, bookPlan, allocator, allDocuments, selectionMatcher) {
  switch (node.type) {
    case type.Book:
      ensureDir(currentDir);
      break;
    case type.Title: {
      const titleDir = path.join(currentDir, allocator.uniqueDir(currentDir, sanitizeFileName(node.name)));
      ensureDir(titleDir);
      currentDir = titleDir;
      break;
    }
    case type.TitleDoc: {
      const titleDir = path.join(currentDir, allocator.uniqueDir(currentDir, sanitizeFileName(node.name)));
      ensureDir(titleDir);
      currentDir = titleDir;
      node.targetMdPath = path.join(
        titleDir,
        allocator.uniqueFile(titleDir, `${sanitizeFileName(node.name)}.md`),
      );
      break;
    }
    case type.Document:
      node.targetMdPath = path.join(
        currentDir,
        allocator.uniqueFile(currentDir, `${sanitizeFileName(node.name)}.md`),
      );
      break;
    default:
      break;
  }

  if (node.type === type.Document || node.type === type.TitleDoc) {
    const absoluteDocUrl = `https://www.yuque.com/${bookPlan.book.user_url}/${bookPlan.book.slug}/${node.object.url}`;
    if (selectionMatcher.shouldIncludeDocument(bookPlan.book.id, absoluteDocUrl)) {
      const docPlan = {
        book: bookPlan.book,
        node,
        targetMdPath: node.targetMdPath,
        docSlug: node.object.url,
        docUrl: `${bookPlan.book.user_url}/${bookPlan.book.slug}/${node.object.url}`,
        absoluteDocUrl,
      };
      bookPlan.documents.push(docPlan);
      allDocuments.push(docPlan);
    }
  }

  for (const child of node.children ?? []) {
    annotateNode(child, currentDir, bookPlan, allocator, allDocuments, selectionMatcher);
  }
}

async function downloadAsset(
  client,
  bookPlan,
  docPlan,
  assetUrl,
  kind,
  emit,
  completed,
  totalDocuments,
  bookContext,
  recordDocIssue,
  options = {},
) {
  const imageCacheKeys =
    kind === 'image'
      ? buildDocumentImageCacheKeys(assetUrl, {
          rawUrl: options.rawUrl || assetUrl,
          originalUrl: options.originalUrl,
          downloadUrl: options.downloadUrl,
          basenameCandidates: options.basenameCandidates,
          imageOccurrence: options.imageOccurrence,
          assetAlt: options.assetAlt,
          cacheAliases: options.cacheAliases,
        })
      : [];
  const assetCacheKeys =
    kind === 'image'
      ? imageCacheKeys
      : dedupeTexts([assetUrl, ...(Array.isArray(options.cacheAliases) ? options.cacheAliases : [])]).filter(Boolean);
  for (const cacheKey of assetCacheKeys) {
    if (bookPlan.assetCache.has(cacheKey)) {
      return bookPlan.assetCache.get(cacheKey);
    }
  }

  const folder = kind === 'image' ? bookPlan.assets.images : bookPlan.assets.files;
  const rawName = sanitizeFileName(
    options.fileNameHint || inferAssetFileName(assetUrl, `${docPlan.node.name}-${kind}`),
    `${docPlan.node.name}-${kind}`,
  );
  const fileName = reserveAssetName(bookPlan, folder, rawName);
  const targetPath = path.join(folder, fileName);
  const failureCacheKeys =
    kind === 'image'
      ? buildDocumentImageCacheKeys(assetUrl, {
          rawUrl: options.rawUrl || assetUrl,
          originalUrl: options.originalUrl,
          downloadUrl: options.downloadUrl,
          basenameCandidates: options.basenameCandidates,
          imageOccurrence: options.imageOccurrence,
          assetAlt: options.assetAlt,
          cacheAliases: options.cacheAliases,
        })
      : dedupeTexts([assetUrl, ...(Array.isArray(options.cacheAliases) ? options.cacheAliases : [])]).filter(Boolean);

  emit(buildDocEvent({
    bookPlan,
    docPlan,
    completed,
    totalDocuments,
    bookCompleted: bookContext.completed,
    bookTotal: bookContext.total,
    message: `Downloading ${kind}: ${fileName}`,
  }));

  let response;
  let resolvedAssetUrl = assetUrl;
  try {
    ({ response, resolvedAssetUrl } = await downloadBinaryAsset(client, assetUrl, { kind }));
  } catch (error) {
    let failureError = error;
    if (!options.skipRenderedAssetFallback && kind === 'image') {
      const fallback = await resolveRenderedImageFallback(docPlan, assetUrl, {
        browserSession: options.browserSession,
        cookiePath: options.cookiePath,
        imageOccurrence: normalizeImageOccurrence(options.imageOccurrence),
        assetAlt: String(options.assetAlt || '').trim(),
      });
      let captureOutcome = null;
      if (fallback?.isLoaded && fallback.downloadUrl) {
        const fallbackPath = await downloadAsset(
          client,
          bookPlan,
          docPlan,
          fallback.downloadUrl,
          kind,
          emit,
          completed,
          totalDocuments,
          bookContext,
          recordDocIssue,
          {
            ...options,
            rawUrl: options.rawUrl || assetUrl,
            fileNameHint: fallback.fileNameHint || rawName,
            originalUrl: fallback.originalUrl,
            downloadUrl: fallback.downloadUrl,
            basenameCandidates: fallback.basenameCandidates,
            skipRenderedAssetFallback: true,
            suppressFailureIssue: true,
          },
        );
        if (fallbackPath) {
          for (const cacheKey of buildDocumentImageCacheKeys(assetUrl, {
            rawUrl: options.rawUrl || assetUrl,
            originalUrl: fallback.originalUrl,
            downloadUrl: fallback.downloadUrl,
            basenameCandidates: fallback.basenameCandidates,
            imageOccurrence: options.imageOccurrence,
            assetAlt: options.assetAlt,
            cacheAliases: [fallback.downloadUrl, fallback.originalUrl, ...(Array.isArray(options.cacheAliases) ? options.cacheAliases : [])],
          })) {
            if (cacheKey) {
              bookPlan.assetCache.set(cacheKey, fallbackPath);
            }
          }
          return fallbackPath;
        }
      }
      if (shouldAttemptRenderedImageScreenshotFallback(fallback)) {
        captureOutcome = await captureRenderedImageFallbackWithRecovery(docPlan, fallback, targetPath, {
          browserSession: options.browserSession,
          cookiePath: options.cookiePath,
          interactiveRecoveryLaunchOptions: options.interactiveRecoveryLaunchOptions,
        });
        if (captureOutcome?.path) {
          for (const cacheKey of buildDocumentImageCacheKeys(assetUrl, {
            rawUrl: options.rawUrl || assetUrl,
            originalUrl: fallback?.originalUrl,
            downloadUrl: fallback?.downloadUrl,
            basenameCandidates: fallback?.basenameCandidates,
            imageOccurrence: options.imageOccurrence,
            assetAlt: options.assetAlt,
            cacheAliases: [
              fallback?.downloadUrl,
              fallback?.originalUrl,
              ...(Array.isArray(options.cacheAliases) ? options.cacheAliases : []),
            ],
          })) {
            if (cacheKey) {
              bookPlan.assetCache.set(cacheKey, captureOutcome.path);
            }
          }
          return captureOutcome.path;
        }
      }
      if (fallback) {
        failureCacheKeys.push(...dedupeTexts([fallback.downloadUrl, fallback.originalUrl]).filter(Boolean));
        failureError = buildRenderedImageFallbackRejectedError(assetUrl, error, {
          ...fallback,
          ...(captureOutcome || {}),
        });
      }
    }

    if (kind === 'image') {
      cleanupFailedImageAssetTarget(bookPlan, folder, fileName, targetPath, failureCacheKeys);
    }

    if (options.suppressFailureIssue) {
      if (kind !== 'image') {
        bookPlan.assetCache.set(assetUrl, null);
      }
      return null;
    }

    const warningErrorType = inferAssetDownloadWarningType(kind, failureError);
    const warningMessage = buildAssetDownloadSkipMessage(kind, assetUrl, failureError);
    recordDocIssue?.({
      phase: 'rewrite-markdown',
      error_type: warningErrorType,
      error_message: warningMessage,
    });
    emit({
      type: 'progress',
      phase: 'asset-warning',
      status: 'warning',
      book: bookPlan.book.name,
      doc: docPlan.node.name,
      targetMdPath: docPlan.targetMdPath,
      message: `${bookPlan.book.name} / ${docPlan.node.name}: ${warningMessage}`,
      error: errorToMessage(failureError),
      percent: percent(completed, totalDocuments),
      bookPercent: percent(bookContext.completed, bookContext.total),
      bookCompleted: bookContext.completed,
      bookTotal: bookContext.total,
    });
    if (kind !== 'image') {
      bookPlan.assetCache.set(assetUrl, null);
    }
    return null;
  }

  fs.writeFileSync(targetPath, response.data);
  if (kind === 'image') {
    registerDocumentImageAssetSuccess(
      docPlan,
      {
        rawUrl: options.rawUrl || assetUrl,
        originalUrl: options.originalUrl,
        downloadUrl: resolvedAssetUrl,
        basenameCandidates: options.basenameCandidates,
        imageOccurrence: options.imageOccurrence,
        assetAlt: options.assetAlt,
      },
      {
        targetPath,
        recoveryMode: 'download',
      },
    );
  }
  const successCacheKeys =
    kind === 'image'
      ? buildDocumentImageCacheKeys(assetUrl, {
          rawUrl: options.rawUrl || assetUrl,
          originalUrl: options.originalUrl,
          downloadUrl: resolvedAssetUrl,
          basenameCandidates: options.basenameCandidates,
          imageOccurrence: options.imageOccurrence,
          assetAlt: options.assetAlt,
          cacheAliases: [resolvedAssetUrl, ...(Array.isArray(options.cacheAliases) ? options.cacheAliases : [])],
        })
      : dedupeTexts([assetUrl, resolvedAssetUrl, ...(Array.isArray(options.cacheAliases) ? options.cacheAliases : [])]);
  for (const cacheKey of successCacheKeys) {
    if (cacheKey) {
      bookPlan.assetCache.set(cacheKey, targetPath);
    }
  }
  return targetPath;
}

function buildAssetDownloadSkipMessage(kind, assetUrl, error) {
  return `Skipped downloading ${kind} asset ${assetUrl} because ${errorToMessage(
    error,
  )}. The original remote link will be kept in markdown.`;
}

export function buildAssetDownloadCandidateUrls(assetUrl) {
  const source = String(assetUrl || '').trim();
  if (!source) {
    return [];
  }

  const derived = [];
  const appendDerived = (candidate) => {
    const nested = extractNestedAssetUrl(candidate);
    if (nested) {
      derived.push(nested);
      const nestedGithubRaw = convertGithubBlobAssetUrlToRaw(nested);
      if (nestedGithubRaw) {
        derived.push(nestedGithubRaw);
      }
    }
    const githubRaw = convertGithubBlobAssetUrlToRaw(candidate);
    if (githubRaw) {
      derived.push(githubRaw);
    }
  };

  appendDerived(source);
  const yuqueOriginal = extractOriginalAssetUrlFromYuqueProxy(source);
  if (yuqueOriginal) {
    derived.push(yuqueOriginal);
    appendDerived(yuqueOriginal);
  }

  return dedupeTexts([source, ...derived]).filter(Boolean);
}

async function downloadBinaryAsset(client, assetUrl, options = {}) {
  const candidates = buildAssetDownloadCandidateUrls(assetUrl);
  let lastError = null;

  for (const candidateUrl of candidates) {
    for (let attempt = 1; attempt <= ASSET_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await requestBinaryAsset(client, candidateUrl, options);
        validateBinaryAssetResponse(response, {
          assetUrl: candidateUrl,
          kind: options.kind,
        });
        return {
          response,
          resolvedAssetUrl: candidateUrl,
        };
      } catch (error) {
        lastError = error;
        if (attempt >= ASSET_DOWNLOAD_MAX_ATTEMPTS || !shouldRetryAssetDownload(error)) {
          break;
        }
        await sleep(350 * attempt);
      }
    }
  }

  throw lastError || new Error(`Failed to download asset: ${assetUrl}`);
}

async function requestBinaryAsset(client, assetUrl, options = {}) {
  const requestOptions = {
    url: assetUrl,
    method: 'get',
    responseType: 'arraybuffer',
    transformResponse: [(value) => value],
    timeout: options.timeout ?? 120000,
    headers: {
      ...buildExternalAssetHeaders(assetUrl),
      ...(options.headers || {}),
    },
  };

  if (typeof client.request === 'function') {
    return await client.request(requestOptions);
  }

  return await client.get(assetUrl, requestOptions);
}

function buildExternalAssetHeaders(assetUrl) {
  try {
    const parsed = new URL(String(assetUrl || ''));
    const origin = `${parsed.protocol}//${parsed.host}`;
    return {
      Cookie: '',
      Referer: `${origin}/`,
      Origin: origin,
    };
  } catch {
    return {};
  }
}

export function validateBinaryAssetResponse(response, options = {}) {
  if (String(options.kind || '').toLowerCase() !== 'image') {
    return response;
  }

  const assetUrl = String(options.assetUrl || '').trim() || 'unknown asset';
  const buffer = toBinaryBuffer(response?.data);
  if (buffer.length === 0) {
    throw new Error(`Downloaded image asset ${assetUrl} was empty.`);
  }

  const contentType = extractResponseHeaderValue(response, 'content-type').split(';')[0].trim().toLowerCase();
  if (looksLikeHtmlResponseBuffer(buffer)) {
    throw new Error(`Received an HTML document instead of image bytes while downloading image asset ${assetUrl}.`);
  }

  const detectedMimeType = detectImageMimeTypeFromBuffer(buffer);
  const svgMimeType = looksLikeSvgResponseBuffer(buffer) ? 'image/svg+xml' : '';
  const effectiveMimeType = detectedMimeType || svgMimeType || contentType;
  if (!effectiveMimeType || !effectiveMimeType.startsWith('image/')) {
    const suffix = contentType ? ` (content-type: ${contentType})` : '';
    throw new Error(`Received a non-image response while downloading image asset ${assetUrl}${suffix}.`);
  }

  if (isRejectedImagePlaceholderBuffer(buffer, options)) {
    throw new Error(
      `Downloaded image asset ${assetUrl} matched a known placeholder image ("该图片可能违规或链接失效") instead of the real image bytes.`,
    );
  }

  return response;
}

function isRejectedImagePlaceholderBuffer(buffer, options = {}) {
  const expectedHashes = Array.isArray(options.rejectedImagePlaceholderHashes)
    ? options.rejectedImagePlaceholderHashes
    : KNOWN_REJECTED_IMAGE_PLACEHOLDER_HASHES;
  if (!Array.isArray(expectedHashes) || expectedHashes.length === 0 || buffer.length === 0) {
    return false;
  }

  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  return expectedHashes.includes(digest);
}

function shouldRetryAssetDownload(error) {
  const source = errorToMessage(error);
  if (!source) {
    return false;
  }
  if (/\b(400|403|404)\b/.test(source)) {
    return false;
  }
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|timed out/i.test(source);
}

function extractNestedAssetUrl(assetUrl) {
  try {
    const parsed = new URL(String(assetUrl || ''));
    for (const key of ['url', 'src', 'image', 'img', 'target']) {
      const nested = parsed.searchParams.get(key);
      if (!nested) {
        continue;
      }
      const decoded = safeDecodeUriComponent(nested).trim();
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    }

    const pathMatch = parsed.pathname.match(/(?:^|\/)(?:url|src|image|img|target)=([^&]+)(?:&|$)/i);
    if (pathMatch?.[1]) {
      const decoded = safeDecodeUriComponent(pathMatch[1]).trim();
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    }
  } catch {
    return '';
  }
  return '';
}

function convertGithubBlobAssetUrlToRaw(assetUrl) {
  try {
    const parsed = new URL(String(assetUrl || ''));
    if (!/^github\.com$/i.test(parsed.hostname)) {
      return '';
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 5 || segments[2] !== 'blob') {
      return '';
    }
    const [owner, repo, , ref, ...fileParts] = segments;
    if (!owner || !repo || !ref || fileParts.length === 0) {
      return '';
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${fileParts.join('/')}`;
  } catch {
    return '';
  }
}

function reserveAssetName(bookPlan, folder, fileName) {
  const seen = bookPlan.assetNames.get(folder) ?? new Set();
  bookPlan.assetNames.set(folder, seen);
  return uniqueName(fileName, seen);
}

function releaseReservedAssetName(bookPlan, folder, fileName) {
  const seen = bookPlan?.assetNames?.get?.(folder);
  if (seen instanceof Set && fileName) {
    seen.delete(fileName);
  }
}

function clearAssetCacheAliases(bookPlan, cacheKeys = [], nullOut = false) {
  for (const cacheKey of dedupeTexts(Array.isArray(cacheKeys) ? cacheKeys : [])) {
    if (!cacheKey) {
      continue;
    }
    if (nullOut) {
      bookPlan?.assetCache?.set?.(cacheKey, null);
    } else {
      bookPlan?.assetCache?.delete?.(cacheKey);
    }
  }
}

function cleanupFailedImageAssetTarget(bookPlan, folder, fileName, targetPath, cacheKeys = []) {
  removeIfExists(targetPath);
  releaseReservedAssetName(bookPlan, folder, fileName);
  clearAssetCacheAliases(bookPlan, cacheKeys, true);
}

function normalizeDocumentImageIdentityUrl(value) {
  const normalized = normalizeAssetMatchUrl(value);
  return normalized || String(value || '').trim();
}

function normalizeDocumentImageBasenameCandidates(values = []) {
  return dedupeTexts((Array.isArray(values) ? values : []).map((value) => String(value || '').toLowerCase())).filter(Boolean);
}

function buildDocumentImageSlotIdentity(source = {}) {
  const rawUrl = String(source?.rawUrl || source?.assetUrl || source?.downloadUrl || '').trim();
  const imageOccurrence = normalizeImageOccurrence(source?.imageOccurrence);
  const assetAlt = String(source?.assetAlt || '').trim();
  const originalUrl = normalizeDocumentImageIdentityUrl(source?.originalUrl);
  const downloadUrl = normalizeDocumentImageIdentityUrl(source?.downloadUrl);
  const basenameCandidates = normalizeDocumentImageBasenameCandidates([
    ...(Array.isArray(source?.basenameCandidates) ? source.basenameCandidates : []),
    extractAssetBasename(source?.rawUrl).toLowerCase(),
    extractAssetBasename(source?.assetUrl).toLowerCase(),
    extractAssetBasename(source?.originalUrl).toLowerCase(),
    extractAssetBasename(source?.downloadUrl).toLowerCase(),
  ]);
  const normalizedAlt = normalizeComparableText(assetAlt);
  const slotKey = dedupeTexts([
    normalizeDocumentImageIdentityUrl(rawUrl),
    originalUrl,
    downloadUrl,
    basenameCandidates.join('|'),
    normalizedAlt,
    Number.isFinite(imageOccurrence) && imageOccurrence >= 0 ? String(imageOccurrence) : '',
  ]).join('::');
  return {
    slotKey,
    rawUrl,
    imageOccurrence,
    assetAlt,
    normalizedAlt,
    originalUrl,
    downloadUrl,
    basenameCandidates,
  };
}

function buildDocumentImageCacheKeys(assetUrl, options = {}) {
  const identity = buildDocumentImageSlotIdentity({
    rawUrl: options?.rawUrl || assetUrl,
    assetUrl,
    originalUrl: options?.originalUrl,
    downloadUrl: options?.downloadUrl,
    basenameCandidates: options?.basenameCandidates,
    imageOccurrence: options?.imageOccurrence,
    assetAlt: options?.assetAlt,
  });
  if (!identity.slotKey) {
    return dedupeTexts([
      normalizeDocumentImageIdentityUrl(assetUrl),
      ...((Array.isArray(options?.cacheAliases) ? options.cacheAliases : []).map(normalizeDocumentImageIdentityUrl)),
    ]).filter(Boolean);
  }
  const aliases = dedupeTexts([
    normalizeDocumentImageIdentityUrl(assetUrl),
    identity.originalUrl,
    identity.downloadUrl,
    ...((Array.isArray(options?.cacheAliases) ? options.cacheAliases : []).map(normalizeDocumentImageIdentityUrl)),
  ]).filter(Boolean);
  if (aliases.length === 0) {
    return [`image-slot::${identity.slotKey}`];
  }
  return aliases.map((alias) => `image-slot::${identity.slotKey}::${alias}`);
}

function getDocumentImageRecoveryLedger(docPlan) {
  if (!docPlan || typeof docPlan !== 'object') {
    return {
      slots: new Map(),
    };
  }
  if (!docPlan.__imageRecoveryLedger || typeof docPlan.__imageRecoveryLedger !== 'object') {
    docPlan.__imageRecoveryLedger = {
      slots: new Map(),
    };
  }
  if (!(docPlan.__imageRecoveryLedger.slots instanceof Map)) {
    docPlan.__imageRecoveryLedger.slots = new Map();
  }
  return docPlan.__imageRecoveryLedger;
}

function upsertDocumentImageRecoverySlotEntry(docPlan, source = {}, extra = {}) {
  const ledger = getDocumentImageRecoveryLedger(docPlan);
  const identity = buildDocumentImageSlotIdentity(source);
  const key =
    identity.slotKey ||
    `anonymous::${String(extra?.targetPath || extra?.recoveryMode || '').trim()}::${ledger.slots.size}`;
  const existing = ledger.slots.get(key) || {};
  const entry = {
    ...existing,
    ...identity,
    slotKey: key,
    rawUrl: identity.rawUrl || existing.rawUrl || '',
    imageOccurrence: identity.imageOccurrence >= 0 ? identity.imageOccurrence : existing.imageOccurrence ?? -1,
    assetAlt: identity.assetAlt || existing.assetAlt || '',
    normalizedAlt: identity.normalizedAlt || existing.normalizedAlt || '',
    originalUrl: identity.originalUrl || existing.originalUrl || '',
    downloadUrl: identity.downloadUrl || existing.downloadUrl || '',
    basenameCandidates:
      identity.basenameCandidates.length > 0
        ? identity.basenameCandidates
        : normalizeDocumentImageBasenameCandidates(existing.basenameCandidates),
    targetPath: String(extra?.targetPath || existing.targetPath || '').trim(),
    recoveryMode: String(extra?.recoveryMode || existing.recoveryMode || '').trim(),
    contentHash: String(extra?.contentHash || existing.contentHash || '').trim(),
    status: String(extra?.status || existing.status || 'pending').trim(),
    rejectionCode: String(extra?.rejectionCode || existing.rejectionCode || '').trim(),
    rejectionReason: String(extra?.rejectionReason || existing.rejectionReason || '').trim(),
  };
  ledger.slots.set(key, entry);
  return entry;
}

function computeFileContentHash(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hasComparableDocumentImageStrongIdentity(entry = {}) {
  return Boolean(
    normalizeDocumentImageIdentityUrl(entry?.rawUrl) ||
      normalizeDocumentImageIdentityUrl(entry?.originalUrl) ||
      normalizeDocumentImageIdentityUrl(entry?.downloadUrl) ||
      normalizeDocumentImageBasenameCandidates(entry?.basenameCandidates).length > 0 ||
      normalizeComparableText(entry?.assetAlt),
  );
}

function areDocumentImageSlotsStronglyEquivalent(left = {}, right = {}) {
  const leftSlotKey = String(left?.slotKey || '').trim();
  const rightSlotKey = String(right?.slotKey || '').trim();
  if (leftSlotKey && rightSlotKey && leftSlotKey === rightSlotKey) {
    return true;
  }

  const leftRawUrl = normalizeDocumentImageIdentityUrl(left?.rawUrl);
  const rightRawUrl = normalizeDocumentImageIdentityUrl(right?.rawUrl);
  if (leftRawUrl && rightRawUrl && leftRawUrl === rightRawUrl) {
    return true;
  }

  const leftOriginalUrl = normalizeDocumentImageIdentityUrl(left?.originalUrl);
  const rightOriginalUrl = normalizeDocumentImageIdentityUrl(right?.originalUrl);
  if (leftOriginalUrl && rightOriginalUrl && leftOriginalUrl === rightOriginalUrl) {
    return true;
  }

  const leftDownloadUrl = normalizeDocumentImageIdentityUrl(left?.downloadUrl);
  const rightDownloadUrl = normalizeDocumentImageIdentityUrl(right?.downloadUrl);
  if (leftDownloadUrl && rightDownloadUrl && leftDownloadUrl === rightDownloadUrl) {
    return true;
  }

  const leftBasenames = normalizeDocumentImageBasenameCandidates(left?.basenameCandidates);
  const rightBasenames = normalizeDocumentImageBasenameCandidates(right?.basenameCandidates);
  const leftAlt = normalizeComparableText(left?.assetAlt);
  const rightAlt = normalizeComparableText(right?.assetAlt);
  if (leftBasenames.length > 0 && rightBasenames.length > 0 && leftAlt && rightAlt && leftAlt === rightAlt) {
    return leftBasenames.some((basename) => rightBasenames.includes(basename));
  }

  return false;
}

function findSuspiciousDuplicateDocumentImageEntry(docPlan, slotEntry = {}) {
  if (!docPlan || !slotEntry?.contentHash || !hasComparableDocumentImageStrongIdentity(slotEntry)) {
    return null;
  }
  const ledger = getDocumentImageRecoveryLedger(docPlan);
  for (const existing of ledger.slots.values()) {
    if (!existing || existing === slotEntry) {
      continue;
    }
    if (String(existing.status || '').trim() !== 'success') {
      continue;
    }
    if (!existing.contentHash || existing.contentHash !== slotEntry.contentHash) {
      continue;
    }
    if (!hasComparableDocumentImageStrongIdentity(existing)) {
      continue;
    }
    if (!areDocumentImageSlotsStronglyEquivalent(existing, slotEntry)) {
      return existing;
    }
  }
  return null;
}

function registerDocumentImageAssetSuccess(docPlan, source = {}, options = {}) {
  const targetPath = String(options?.targetPath || '').trim();
  const contentHash =
    String(options?.contentHash || '').trim() || (targetPath && fs.existsSync(targetPath) ? computeFileContentHash(targetPath) : '');
  const entry = upsertDocumentImageRecoverySlotEntry(
    docPlan,
    source,
    {
      targetPath,
      recoveryMode: options?.recoveryMode,
      contentHash,
      status: 'success',
      rejectionCode: '',
      rejectionReason: '',
    },
  );
  if (options?.detectDuplicateHash) {
    const duplicateEntry = findSuspiciousDuplicateDocumentImageEntry(docPlan, entry);
    if (duplicateEntry) {
      const failure = {
        path: '',
        recoveryMode: String(options?.recoveryMode || '').trim(),
        rejectionCode: 'edit-duplicate-image-suspected',
        naturalWidth: Number(options?.naturalWidth) || 0,
        naturalHeight: Number(options?.naturalHeight) || 0,
        clientWidth: Number(options?.clientWidth) || 0,
        clientHeight: Number(options?.clientHeight) || 0,
        complete: Boolean(options?.complete),
        captureBytes: Number(options?.captureBytes) || 0,
        currentSrc: String(options?.currentSrc || '').trim(),
        actualAlt: String(options?.actualAlt || options?.assetAlt || source?.assetAlt || '').trim(),
        contentHash,
        duplicateTargetPath: String(duplicateEntry?.targetPath || '').trim(),
      };
      removeIfExists(targetPath);
      const rejectionReason = buildRenderedImageRecoveryFailureDescription(failure);
      upsertDocumentImageRecoverySlotEntry(
        docPlan,
        source,
        {
          targetPath: '',
          recoveryMode: failure.recoveryMode,
          contentHash,
          status: 'rejected',
          rejectionCode: failure.rejectionCode,
          rejectionReason,
        },
      );
      return {
        ...failure,
        rejectionReason,
      };
    }
  }
  return {
    contentHash,
    slotEntry: entry,
    rejectionCode: '',
    rejectionReason: '',
  };
}

function finalizeRecoveredDocumentImageOutcome(docPlan, fallback, outcome = {}) {
  if (!outcome?.path || !fs.existsSync(outcome.path)) {
    return outcome;
  }
  const registration = registerDocumentImageAssetSuccess(
    docPlan,
    {
      rawUrl: fallback?.rawUrl || fallback?.originalUrl || fallback?.downloadUrl,
      originalUrl: fallback?.originalUrl,
      downloadUrl: fallback?.downloadUrl,
      basenameCandidates: fallback?.basenameCandidates,
      imageOccurrence: fallback?.imageOccurrence,
      assetAlt: fallback?.assetAlt,
    },
    {
      targetPath: outcome.path,
      recoveryMode: outcome.recoveryMode,
      detectDuplicateHash: String(outcome?.recoveryMode || '').trim().toLowerCase() === 'visible-browser-edit',
      naturalWidth: outcome?.naturalWidth,
      naturalHeight: outcome?.naturalHeight,
      clientWidth: outcome?.clientWidth,
      clientHeight: outcome?.clientHeight,
      complete: outcome?.complete,
      captureBytes: outcome?.captureBytes,
      currentSrc: outcome?.currentSrc,
      actualAlt: outcome?.actualAlt,
    },
  );
  if (registration.rejectionCode) {
    return {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      ...normalizeRenderedImageRecoveryOutcome(outcome),
      ...registration,
      path: '',
    };
  }
  return {
    ...outcome,
    contentHash: registration.contentHash,
  };
}

function inferAssetFileName(assetUrl, fallbackName = 'asset') {
  const candidates = [assetUrl, extractOriginalAssetUrlFromYuqueProxy(assetUrl)].filter(Boolean);
  for (const candidate of candidates) {
    const basename = extractAssetBasename(candidate);
    if (basename) {
      return basename;
    }
  }
  return fallbackName;
}

function extractOriginalAssetUrlFromYuqueProxy(assetUrl) {
  try {
    const parsed = new URL(String(assetUrl || ''));
    const nestedUrl = parsed.searchParams.get('url');
    if (!nestedUrl) {
      return '';
    }
    return decodeURIComponent(nestedUrl);
  } catch {
    return '';
  }
}

function normalizeImageOccurrence(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : -1;
}

function extractAssetBasename(value) {
  const source = String(value ?? '').trim();
  if (!source) {
    return '';
  }

  try {
    const parsed = new URL(source, 'https://www.yuque.com');
    const basename = path.basename(parsed.pathname || '');
    return safeDecodeUriComponent(basename);
  } catch {
    const withoutHash = source.split('#')[0];
    const withoutQuery = withoutHash.split('?')[0];
    return safeDecodeUriComponent(path.basename(withoutQuery));
  }
}

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return String(value ?? '');
  }
}

async function resolveRenderedImageFallback(docPlan, assetUrl, options = {}) {
  const renderedImages = await getRenderedImageCatalog(docPlan, options);
  const match = findRenderedImageForAssetReference(renderedImages, assetUrl, options);
  if (!match?.downloadUrl) {
    return null;
  }

  return {
    rawUrl: String(assetUrl || '').trim(),
    downloadUrl: match.downloadUrl,
    originalUrl: match.originalUrl || '',
    basenameCandidates: Array.isArray(match.basenameCandidates) ? [...match.basenameCandidates] : [],
    fileNameHint: inferAssetFileName(match.originalUrl || assetUrl, inferAssetFileName(assetUrl)),
    imageOccurrence: normalizeImageOccurrence(options.imageOccurrence),
    assetAlt: String(options.assetAlt || '').trim(),
    slotKey: buildDocumentImageSlotIdentity({
      rawUrl: assetUrl,
      originalUrl: match.originalUrl || '',
      downloadUrl: match.downloadUrl,
      basenameCandidates: Array.isArray(match.basenameCandidates) ? match.basenameCandidates : [],
      imageOccurrence: options.imageOccurrence,
      assetAlt: String(options.assetAlt || '').trim(),
    }).slotKey,
    renderIndex: Number.isFinite(Number(match.index)) ? Number(match.index) : -1,
    naturalWidth: Number(match.naturalWidth) || 0,
    naturalHeight: Number(match.naturalHeight) || 0,
    clientWidth: Number(match.clientWidth) || 0,
    clientHeight: Number(match.clientHeight) || 0,
    complete: Boolean(match.complete),
    isLoaded: isRenderedImageFallbackUsable(match),
  };
}

async function getRenderedImageCatalog(docPlan, options = {}) {
  if (Array.isArray(docPlan?.__renderedImageCatalog) && docPlan.__renderedImageCatalog.length > 0) {
    return docPlan.__renderedImageCatalog;
  }
  if (docPlan?.__renderedImageCatalogLoaded) {
    return docPlan.__renderedImageCatalog || [];
  }
  if (docPlan?.__renderedImageCatalogPromise) {
    return await docPlan.__renderedImageCatalogPromise;
  }
  if (!options.browserSession || !options.cookiePath || !docPlan?.absoluteDocUrl) {
    return [];
  }

  docPlan.__renderedImageCatalogPromise = withAuthenticatedExportPage(
    options.browserSession,
    options.cookiePath,
    async (page) => {
      await page.goto(docPlan.absoluteDocUrl, {
        timeout: 120000,
        waitUntil: 'networkidle2',
      });
      return normalizeRenderedImageCatalog(
        await page.evaluate(() => {
          const root =
            document.querySelector('article') ||
            document.querySelector('.ne-viewer-body') ||
            document.querySelector('.lake-content') ||
            document.body;
          return Array.from(root?.querySelectorAll?.('img') || []).map((img, index) => ({
            index,
            src: img.getAttribute('src') || '',
            currentSrc: img.currentSrc || '',
            dataSrc: img.getAttribute('data-src') || '',
            alt: img.getAttribute('alt') || '',
            naturalWidth: Number(img.naturalWidth || 0),
            naturalHeight: Number(img.naturalHeight || 0),
            clientWidth: Number(img.clientWidth || 0),
            clientHeight: Number(img.clientHeight || 0),
            complete: Boolean(img.complete),
          }));
        }),
      );
    },
  );

  try {
    const renderedImages = await docPlan.__renderedImageCatalogPromise;
    docPlan.__renderedImageCatalog = renderedImages;
    return renderedImages;
  } finally {
    docPlan.__renderedImageCatalogLoaded = true;
    docPlan.__renderedImageCatalogPromise = null;
  }
}

async function captureRenderedImageFallbackToPath(docPlan, fallback, targetPath, options = {}) {
  const outcome = await captureRenderedImageFallbackWithRecovery(docPlan, fallback, targetPath, options);
  return outcome?.path || '';
}

export async function captureRenderedImageFallbackToLocalAsset(bookPlan, docPlan, fallback, fileNameHint, options = {}) {
  const assetDir = bookPlan?.assets?.images;
  if (!assetDir) {
    return '';
  }

  const rawName = sanitizeFileName(
    fileNameHint || fallback?.fileNameHint || inferAssetFileName(fallback?.originalUrl || fallback?.downloadUrl, 'image'),
    `${docPlan?.node?.name || 'image'}-image`,
  );
  const fileName = reserveAssetName(bookPlan, assetDir, rawName);
  const targetPath = path.join(assetDir, fileName);
  const outcome = await captureRenderedImageFallbackWithRecovery(docPlan, fallback, targetPath, options);
  if (!outcome?.path) {
    cleanupFailedImageAssetTarget(
      bookPlan,
      assetDir,
      fileName,
      targetPath,
      buildDocumentImageCacheKeys(fallback?.rawUrl || fallback?.originalUrl || fallback?.downloadUrl, {
        rawUrl: fallback?.rawUrl || fallback?.originalUrl || fallback?.downloadUrl,
        originalUrl: fallback?.originalUrl,
        downloadUrl: fallback?.downloadUrl,
        basenameCandidates: fallback?.basenameCandidates,
        imageOccurrence: fallback?.imageOccurrence,
        assetAlt: fallback?.assetAlt,
        cacheAliases: options.cacheAliases,
      }),
    );
    return '';
  }

  for (const cacheKey of buildDocumentImageCacheKeys(fallback?.rawUrl || fallback?.originalUrl || fallback?.downloadUrl, {
    rawUrl: fallback?.rawUrl || fallback?.originalUrl || fallback?.downloadUrl,
    originalUrl: fallback?.originalUrl,
    downloadUrl: fallback?.downloadUrl,
    basenameCandidates: fallback?.basenameCandidates,
    imageOccurrence: fallback?.imageOccurrence,
    assetAlt: fallback?.assetAlt,
    cacheAliases: options.cacheAliases,
  })) {
    if (cacheKey) {
      bookPlan.assetCache.set(cacheKey, outcome.path);
    }
  }

  return outcome.path;
}

async function captureRenderedImageFallbackWithRecovery(docPlan, fallback, targetPath, options = {}) {
  const headlessOutcome = await captureRenderedImageFallbackViaSession(docPlan, fallback, targetPath, {
    browserSession: options.browserSession,
    cookiePath: options.cookiePath,
    recoveryMode: 'headless',
  });
  if (headlessOutcome?.path) {
    const finalizedHeadlessOutcome = finalizeRecoveredDocumentImageOutcome(docPlan, fallback, headlessOutcome);
    if (finalizedHeadlessOutcome?.path) {
      return {
        ...normalizeRenderedImageRecoveryOutcome(fallback),
        ...finalizedHeadlessOutcome,
      };
    }
    Object.assign(headlessOutcome, finalizedHeadlessOutcome);
  }

  let finalOutcome = chooseRenderedImageRecoveryOutcome(headlessOutcome, fallback);
  if (options.interactiveRecoveryLaunchOptions && options.cookiePath) {
    const visibleOutcome = await captureRenderedImageFallbackInVisibleBrowser(docPlan, fallback, targetPath, {
      browserSession: options.browserSession,
      cookiePath: options.cookiePath,
      launchOptions: options.interactiveRecoveryLaunchOptions,
      recoveryMode: 'visible-browser',
    });
    if (visibleOutcome?.path) {
      const finalizedVisibleOutcome = finalizeRecoveredDocumentImageOutcome(docPlan, fallback, visibleOutcome);
      if (finalizedVisibleOutcome?.path) {
        return {
          ...normalizeRenderedImageRecoveryOutcome(fallback),
          ...finalizedVisibleOutcome,
        };
      }
      Object.assign(visibleOutcome, finalizedVisibleOutcome);
    }
    finalOutcome = chooseRenderedImageRecoveryOutcome(visibleOutcome, finalOutcome || fallback);
  }

  return {
    ...normalizeRenderedImageRecoveryOutcome(fallback),
    ...(finalOutcome || {}),
  };
}

function normalizeRenderedImageRecoveryOutcome(source = {}) {
  return {
    path: '',
    recoveryMode: String(source?.recoveryMode || '').trim(),
    rejectionCode: String(source?.rejectionCode || '').trim(),
    rejectionReason: String(source?.rejectionReason || '').trim(),
    visibleText: formatRenderedImageVisibleText(source?.visibleText),
    naturalWidth: Number(source?.naturalWidth) || 0,
    naturalHeight: Number(source?.naturalHeight) || 0,
    clientWidth: Number(source?.clientWidth) || 0,
    clientHeight: Number(source?.clientHeight) || 0,
    captureBytes: Number(source?.captureBytes) || 0,
    complete: Boolean(source?.complete),
  };
}

function chooseRenderedImageRecoveryOutcome(primary, fallback) {
  const primaryOutcome = normalizeRenderedImageRecoveryOutcome(primary);
  const fallbackOutcome = normalizeRenderedImageRecoveryOutcome(fallback);
  return scoreRenderedImageRecoveryOutcome(primaryOutcome) >= scoreRenderedImageRecoveryOutcome(fallbackOutcome)
    ? primaryOutcome
    : fallbackOutcome;
}

function scoreRenderedImageRecoveryOutcome(outcome = {}) {
  if (outcome.path) {
    return 100;
  }

  const rejectionCode = String(outcome.rejectionCode || '').trim().toLowerCase();
  const scores = {
    'edit-duplicate-image-suspected': 97,
    'edit-image-identity-mismatch': 96,
    'edit-entry-missing': 95,
    'edit-mode-not-entered': 94,
    'edit-image-slot-missing': 93,
    'edit-capture-target-ambiguous': 92,
    'edit-capture-target-missing': 92,
    'edit-placeholder-only': 91,
    'edit-blank-container': 90,
    'edit-blank-capture': 89,
    'edit-screenshot-failed': 88,
    'blank-capture': 80,
    'placeholder-only': 70,
    'blank-container': 65,
    'not-rendered': 60,
    'capture-target-missing': 50,
    'image-slot-missing': 40,
    'screenshot-failed': 30,
    'document-open-failed': 20,
    'browser-launch-failed': 10,
    'capture-exception': 5,
  };
  if (rejectionCode.startsWith('edit-')) {
    return scores[rejectionCode] ?? 85;
  }
  return scores[rejectionCode] ?? (outcome.rejectionReason ? 1 : 0);
}

export function classifyRenderedImageCaptureInspection(snapshot = {}) {
  const normalized = normalizeRenderedImageRecoveryOutcome(snapshot);
  const placeholderTextDetected =
    Boolean(snapshot?.placeholderTextDetected) ||
    /该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(normalized.visibleText);
  const placeholderAttributeDetected = Boolean(snapshot?.placeholderAttributeDetected);
  const hasLoadedImage =
    Boolean(snapshot?.hasLoadedImage) || (normalized.naturalWidth > 0 && normalized.naturalHeight > 0);
  const hasRenderableVisualNode = Boolean(snapshot?.hasRenderableVisualNode);
  const hasBackgroundImage = Boolean(snapshot?.hasBackgroundImage);
  const hasMeaningfulText =
    Boolean(snapshot?.hasMeaningfulText) || (Boolean(normalized.visibleText) && !placeholderTextDetected);
  const hasRealContent = hasLoadedImage || hasRenderableVisualNode || hasMeaningfulText || hasBackgroundImage;

  let rejectionCode = normalized.rejectionCode;
  if (!rejectionCode) {
    if ((placeholderTextDetected || placeholderAttributeDetected) && !hasLoadedImage && !hasRenderableVisualNode && !hasBackgroundImage) {
      rejectionCode = 'placeholder-only';
    } else if (!hasRealContent && !(normalized.clientWidth > 8 && normalized.clientHeight > 8)) {
      rejectionCode = 'not-rendered';
    } else if (!hasRealContent) {
      rejectionCode = 'blank-container';
    }
  }

  return {
    ...normalized,
    rejectionCode,
    placeholderTextDetected,
    placeholderAttributeDetected,
    hasLoadedImage,
    hasRenderableVisualNode,
    hasBackgroundImage,
    hasMeaningfulText,
    hasRealContent,
  };
}

export function isRenderedImageBlankCapture(inspection = {}, fileInfo = {}) {
  const classified = classifyRenderedImageCaptureInspection(inspection);
  const width = Number(fileInfo.width ?? classified.clientWidth) || 0;
  const height = Number(fileInfo.height ?? classified.clientHeight) || 0;
  const captureBytes = Number(fileInfo.captureBytes ?? fileInfo.bytes ?? classified.captureBytes) || 0;
  return (
    !classified.hasRealContent &&
    width >= RENDERED_IMAGE_BLANK_CAPTURE_MIN_WIDTH &&
    height >= RENDERED_IMAGE_BLANK_CAPTURE_MIN_HEIGHT &&
    captureBytes > 0 &&
    captureBytes < RENDERED_IMAGE_BLANK_CAPTURE_MAX_BYTES
  );
}

export function pickVisibleDocumentEditEntry(entries = []) {
  return [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => {
      const normalizedText = normalizeComparableText(entry?.text || '');
      const className = String(entry?.className || '');
      const top = Number(entry?.rect?.y);
      return (
        entry?.visible === true &&
        normalizedText === normalizeComparableText(DOCUMENT_EDIT_ENTRY_TEXT) &&
        /\bant-btn\b/.test(className) &&
        /\bant-btn-primary\b/.test(className) &&
        /\blarkui-tooltip\b/.test(className) &&
        Number.isFinite(top) &&
        top >= -4 &&
        top <= DOCUMENT_EDIT_ENTRY_MAX_TOP
      );
    })
    .sort((left, right) => {
      const topDelta = Number(left?.rect?.y || 0) - Number(right?.rect?.y || 0);
      if (topDelta !== 0) {
        return topDelta;
      }
      return Number(right?.rect?.x || 0) - Number(left?.rect?.x || 0);
    })[0] || null;
}

export function classifyDocumentEditModeState(snapshot = {}) {
  const visibleDocumentEditorCount = Math.max(0, Number(snapshot?.visibleDocumentEditorCount) || 0);
  const visibleToolbarCount = Math.max(0, Number(snapshot?.visibleToolbarCount) || 0);
  const visibleMinorEditorCount = Math.max(0, Number(snapshot?.visibleMinorEditorCount) || 0);
  const maxDocumentEditorArea = Math.max(0, Number(snapshot?.maxDocumentEditorArea) || 0);
  const ready =
    visibleDocumentEditorCount > 0 || (visibleToolbarCount > 0 && maxDocumentEditorArea > 0);

  return {
    ready,
    rejectionCode: ready ? '' : 'edit-mode-not-entered',
    visibleDocumentEditorCount,
    visibleToolbarCount,
    visibleMinorEditorCount,
    maxDocumentEditorArea,
  };
}

export function pickDocumentEditImageCandidate(candidates = [], fallback = {}) {
  const allCandidates = Array.isArray(candidates) ? candidates : [];
  if (allCandidates.length === 0) {
    return null;
  }
  const visibleCandidates = allCandidates.filter((candidate) => candidate?.visible !== false);
  const preferredCandidates = visibleCandidates.length > 0 ? visibleCandidates : allCandidates;
  const renderableCandidates = preferredCandidates.filter((candidate) => isRenderableDocumentEditImageCandidate(candidate));

  const targetUrls = dedupeTexts([
    normalizeAssetMatchUrl(fallback?.originalUrl),
    normalizeAssetMatchUrl(fallback?.downloadUrl),
    normalizeAssetMatchUrl(extractOriginalAssetUrlFromYuqueProxy(fallback?.downloadUrl)),
  ]).filter(Boolean);
  if (targetUrls.length > 0) {
    const urlMatch = preferredCandidates.find((candidate) =>
      getImageCandidateMatchUrls(candidate).some((url) => targetUrls.includes(url)),
    );
    if (urlMatch) {
      return urlMatch;
    }
  }

  const targetBasenames = dedupeTexts([
    ...(Array.isArray(fallback?.basenameCandidates) ? fallback.basenameCandidates : []),
    extractAssetBasename(fallback?.originalUrl).toLowerCase(),
    extractAssetBasename(fallback?.downloadUrl).toLowerCase(),
  ]).filter(Boolean);
  if (targetBasenames.length > 0) {
    const basenameMatch = preferredCandidates.find((candidate) =>
      getImageCandidateBasenames(candidate).some((name) => targetBasenames.includes(name)),
    );
    if (basenameMatch) {
      return basenameMatch;
    }
  }

  const occurrenceMatch = findDocumentEditImageByOccurrence(renderableCandidates, fallback?.imageOccurrence);
  if (occurrenceMatch) {
    return occurrenceMatch;
  }

  const altMatch = findDocumentEditImageByAlt(renderableCandidates.length > 0 ? renderableCandidates : preferredCandidates, fallback?.assetAlt);
  if (altMatch) {
    return altMatch;
  }

  const renderIndex = resolveRenderedImageRecoveryIndex(fallback);
  if (renderIndex >= 0) {
    return preferredCandidates[renderIndex] || null;
  }

  return null;
}

function getImageCandidateMatchUrls(candidate = {}) {
  return dedupeTexts([
    normalizeAssetMatchUrl(candidate?.currentSrc),
    normalizeAssetMatchUrl(candidate?.src),
    normalizeAssetMatchUrl(candidate?.dataSrc),
    normalizeAssetMatchUrl(extractOriginalAssetUrlFromYuqueProxy(candidate?.currentSrc)),
    normalizeAssetMatchUrl(extractOriginalAssetUrlFromYuqueProxy(candidate?.src)),
    normalizeAssetMatchUrl(extractOriginalAssetUrlFromYuqueProxy(candidate?.dataSrc)),
  ]).filter(Boolean);
}

function getImageCandidateBasenames(candidate = {}) {
  return dedupeTexts([
    extractAssetBasename(candidate?.currentSrc).toLowerCase(),
    extractAssetBasename(candidate?.src).toLowerCase(),
    extractAssetBasename(candidate?.dataSrc).toLowerCase(),
  ]).filter(Boolean);
}

function findDocumentEditImageByOccurrence(candidates = [], imageOccurrence) {
  const occurrence = normalizeImageOccurrence(imageOccurrence);
  if (occurrence < 0) {
    return null;
  }
  return candidates[occurrence] || null;
}

function findDocumentEditImageByAlt(candidates = [], assetAlt = '') {
  const normalizedAlt = normalizeComparableText(assetAlt);
  if (!normalizedAlt) {
    return null;
  }

  return (
    candidates.find((candidate) => normalizeComparableText(candidate?.alt) === normalizedAlt) ||
    candidates.find((candidate) => normalizeComparableText(candidate?.alt).includes(normalizedAlt)) ||
    candidates.find((candidate) => normalizedAlt.includes(normalizeComparableText(candidate?.alt))) ||
    null
  );
}

function isRenderableDocumentEditImageCandidate(candidate = {}) {
  if (candidate?.visible === false) {
    return false;
  }

  const naturalWidth = Number(candidate?.naturalWidth) || 0;
  const naturalHeight = Number(candidate?.naturalHeight) || 0;
  const clientWidth = Number(candidate?.clientWidth) || 0;
  const clientHeight = Number(candidate?.clientHeight) || 0;
  const hasRenderableDimensions =
    (naturalWidth > 8 && naturalHeight > 8) || (clientWidth > 8 && clientHeight > 8);
  if (!hasRenderableDimensions) {
    return false;
  }

  const source = `${String(candidate?.currentSrc || '')} ${String(candidate?.src || '')} ${String(candidate?.dataSrc || '')} ${String(candidate?.alt || '')}`.toLowerCase();
  if (/该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(source)) {
    return false;
  }

  return !isLikelyPlaceholderImageCandidate({
    downloadUrl: candidate?.currentSrc || candidate?.src || candidate?.dataSrc || '',
    originalUrl:
      extractOriginalAssetUrlFromYuqueProxy(candidate?.currentSrc) ||
      extractOriginalAssetUrlFromYuqueProxy(candidate?.src) ||
      extractOriginalAssetUrlFromYuqueProxy(candidate?.dataSrc) ||
      '',
    alt: candidate?.alt || '',
  });
}

async function captureRenderedImageFallbackViaSession(docPlan, fallback, targetPath, options = {}) {
  const renderIndex = resolveRenderedImageRecoveryIndex(fallback);
  if (
    !fallback ||
    !targetPath ||
    !options.browserSession ||
    !options.cookiePath ||
    !docPlan?.absoluteDocUrl ||
    renderIndex < 0
  ) {
    return normalizeRenderedImageRecoveryOutcome(fallback);
  }

  try {
    return await withAuthenticatedExportPage(options.browserSession, options.cookiePath, async (page) =>
      await captureRenderedImageFallbackOnPage(page, docPlan, fallback, targetPath, options),
    );
  } catch {
    return {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      recoveryMode: String(options.recoveryMode || '').trim(),
      rejectionCode: 'capture-exception',
      rejectionReason: 'the recovery browser failed while opening or capturing the Yuque image slot',
    };
  }
}

function buildRenderedImageRecoveryError(rejectionCode, rejectionReason) {
  const error = new Error(String(rejectionReason || rejectionCode || 'rendered image recovery failed'));
  error.rejectionCode = String(rejectionCode || '').trim();
  error.rejectionReason = String(rejectionReason || '').trim();
  return error;
}

function getDocumentInteractiveRecoverySession(docPlan) {
  return docPlan?.__interactiveRecoverySession || null;
}

function isDocumentInteractiveRecoverySessionUsable(docPlan) {
  const session = getDocumentInteractiveRecoverySession(docPlan);
  if (!docPlan || !session || session.disposed) {
    return false;
  }
  if (!isBrowserConnectionUsable(session.browser)) {
    return false;
  }
  if (!session.page || session.page.isClosed?.()) {
    return false;
  }
  return true;
}

async function openDocumentInteractiveRecoveryPage(docPlan, session, options = {}) {
  if (!docPlan?.absoluteDocUrl || !session?.page) {
    throw buildRenderedImageRecoveryError(
      'document-open-failed',
      'the recovery browser could not open the Yuque document',
    );
  }
  if (session.openedDocUrl !== docPlan.absoluteDocUrl) {
    try {
      await session.page.goto(docPlan.absoluteDocUrl, {
        timeout: 120000,
        waitUntil: 'networkidle2',
      });
    } catch {
      throw buildRenderedImageRecoveryError(
        'document-open-failed',
        'the recovery browser could not open the Yuque document',
      );
    }
    session.openedDocUrl = docPlan.absoluteDocUrl;
    session.mode = 'read';
    session.enteredEditMode = false;
  }

  if (options.bringToFront) {
    try {
      await session.page.bringToFront();
    } catch {
      // Ignore focus failures in browser environments that do not support bringToFront.
    }
  }

  return session;
}

export async function ensureDocumentInteractiveRecoverySession(docPlan, options = {}) {
  if (!docPlan?.absoluteDocUrl || !options.cookiePath) {
    return null;
  }

  if (!isDocumentInteractiveRecoverySessionUsable(docPlan)) {
    await disposeDocumentInteractiveRecoverySession(docPlan);

    try {
      await options.browserSession?.resetBrowser?.();
    } catch {
      // Ignore reset failures and still attempt to open the visible recovery browser.
    }

    const launchVisibleBrowser = typeof options.launchBrowserFn === 'function' ? options.launchBrowserFn : launchBrowser;
    const openVisiblePage =
      typeof options.openAuthenticatedPageFn === 'function' ? options.openAuthenticatedPageFn : openAuthenticatedPage;
    const configureVisiblePage =
      typeof options.configurePageFn === 'function' ? options.configurePageFn : configureExportPage;

    let browser = null;
    let page = null;
    try {
      browser = await launchVisibleBrowser(options.launchOptions || {});
    } catch {
      throw buildRenderedImageRecoveryError(
        'browser-launch-failed',
        'the visible recovery browser could not be launched',
      );
    }

    try {
      page = await openVisiblePage(browser, options.cookiePath);
      await configureVisiblePage(page);
    } catch {
      await closePageSafely(page);
      await closeBrowserSafely(browser);
      throw buildRenderedImageRecoveryError(
        'capture-exception',
        'the visible recovery browser failed while capturing the Yuque image slot',
      );
    }

    docPlan.__interactiveRecoverySession = {
      browser,
      page,
      openedDocUrl: '',
      mode: 'read',
      enteredEditMode: false,
      disposed: false,
    };
  }

  return await openDocumentInteractiveRecoveryPage(docPlan, getDocumentInteractiveRecoverySession(docPlan), options);
}

export async function disposeDocumentInteractiveRecoverySession(docPlan) {
  const session = getDocumentInteractiveRecoverySession(docPlan);
  if (!docPlan) {
    return;
  }

  delete docPlan.__interactiveRecoverySession;
  if (!session) {
    return;
  }

  session.disposed = true;
  await closePageSafely(session.page);
  await closeBrowserSafely(session.browser);
}

export async function captureRenderedImageFallbackInVisibleBrowser(docPlan, fallback, targetPath, options = {}) {
  const renderIndex = resolveRenderedImageRecoveryIndex(fallback);
  if (
    !fallback ||
    !targetPath ||
    !options.cookiePath ||
    !docPlan?.absoluteDocUrl ||
    renderIndex < 0
  ) {
    return normalizeRenderedImageRecoveryOutcome(fallback);
  }

  let session = null;
  try {
    session = await ensureDocumentInteractiveRecoverySession(docPlan, {
      ...options,
      bringToFront: true,
    });
    if (!session?.page) {
      return normalizeRenderedImageRecoveryOutcome(fallback);
    }

    const captureReadOnPage =
      typeof options.captureReadOnPage === 'function' ? options.captureReadOnPage : captureRenderedImageFallbackOnPage;
    const captureEditOnPage =
      typeof options.captureEditOnPage === 'function'
        ? options.captureEditOnPage
        : captureRenderedImageFallbackInEditModeOnPage;

    let readOutcome = normalizeRenderedImageRecoveryOutcome(fallback);
    if (!session.enteredEditMode && session.mode !== 'edit') {
      readOutcome = await captureReadOnPage(session.page, docPlan, fallback, targetPath, {
        ...options,
        bringToFront: true,
        skipDocumentOpen: true,
      });
      if (readOutcome?.path) {
        return readOutcome;
      }
    }

    const editOutcome = await captureEditOnPage(session.page, docPlan, fallback, targetPath, {
      ...options,
      bringToFront: true,
      recoveryMode: 'visible-browser-edit',
      skipEnterEditMode: session.enteredEditMode || session.mode === 'edit',
    });
    if (!['edit-entry-missing', 'edit-mode-not-entered'].includes(String(editOutcome?.rejectionCode || '').trim())) {
      session.mode = 'edit';
      session.enteredEditMode = true;
    }
    if (editOutcome?.path) {
      return editOutcome;
    }

    return {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      ...chooseRenderedImageRecoveryOutcome(editOutcome, readOutcome || fallback),
    };
  } catch (error) {
    await disposeDocumentInteractiveRecoverySession(docPlan);
    const rejectionCode = String(error?.rejectionCode || '').trim() || 'capture-exception';
    const failure = {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      recoveryMode: String(options.recoveryMode || '').trim(),
      rejectionCode,
    };
    return {
      ...failure,
      rejectionReason:
        String(error?.rejectionReason || '').trim() || buildRenderedImageRecoveryFailureDescription(failure),
    };
  }
}

function buildDocumentEditDomProbePayload(extra = {}) {
  return {
    entrySelector: DOCUMENT_EDIT_ENTRY_SELECTOR,
    rootSelector: DOCUMENT_EDIT_ROOT_SELECTOR,
    excludedSelector: DOCUMENT_EDIT_EXCLUDED_ROOT_SELECTOR,
    toolbarSelector: DOCUMENT_EDIT_TOOLBAR_SELECTOR,
    ...extra,
  };
}

function mapEditModeRejectionCode(code = '') {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  switch (normalized) {
    case 'image-slot-missing':
      return 'edit-image-slot-missing';
    case 'capture-target-missing':
      return 'edit-capture-target-missing';
    case 'placeholder-only':
      return 'edit-placeholder-only';
    case 'blank-container':
      return 'edit-blank-container';
    case 'blank-capture':
      return 'edit-blank-capture';
    case 'screenshot-failed':
      return 'edit-screenshot-failed';
    default:
      return normalized.startsWith('edit-') ? normalized : `edit-${normalized}`;
  }
}

export function classifyDocumentEditImageCaptureInspection(inspection = {}) {
  const normalized = classifyRenderedImageCaptureInspection(inspection);
  return {
    ...normalized,
    rejectionCode: mapEditModeRejectionCode(normalized.rejectionCode),
  };
}

async function collectVisibleDocumentEditEntries(page) {
  return await page.evaluate((payload) => {
    const visible = (node) => {
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    return Array.from(document.querySelectorAll(payload.entrySelector)).map((node, domIndex) => {
      const rect = node.getBoundingClientRect();
      return {
        domIndex,
        tag: node.tagName,
        text: String(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .trim(),
        className: String(node.className || ''),
        visible: visible(node),
        rect: {
          x: Number(rect.x || 0),
          y: Number(rect.y || 0),
          width: Number(rect.width || 0),
          height: Number(rect.height || 0),
        },
      };
    });
  }, buildDocumentEditDomProbePayload());
}

async function clickDocumentEditEntryOnPage(page, entry) {
  const domIndex = Number(entry?.domIndex);
  if (!Number.isFinite(domIndex) || domIndex < 0) {
    return false;
  }

  return await page.evaluate((payload) => {
    const node = Array.from(document.querySelectorAll(payload.entrySelector))[payload.domIndex] || null;
    if (!node) {
      return false;
    }
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    if (typeof node.click === 'function') {
      node.click();
      return true;
    }
    return false;
  }, buildDocumentEditDomProbePayload({ domIndex }));
}

async function inspectDocumentEditModeOnPage(page) {
  return await page.evaluate((payload) => {
    const visible = (node) => {
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
    const roots = Array.from(document.querySelectorAll(payload.rootSelector))
      .filter((node) => visible(node) && !isExcluded(node))
      .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    const toolbars = Array.from(document.querySelectorAll(payload.toolbarSelector)).filter(
      (node) => visible(node) && !isExcluded(node),
    );
    const minorEditors = Array.from(document.querySelectorAll(payload.excludedSelector)).filter((node) => visible(node));
    const maxDocumentEditorArea = roots.reduce((maxArea, node) => {
      const rect = node.getBoundingClientRect();
      return Math.max(maxArea, Number(rect.width || 0) * Number(rect.height || 0));
    }, 0);

    return {
      visibleDocumentEditorCount: roots.length,
      visibleToolbarCount: toolbars.length,
      visibleMinorEditorCount: minorEditors.length,
      maxDocumentEditorArea,
    };
  }, buildDocumentEditDomProbePayload());
}

async function enterDocumentEditModeOnPage(page, options = {}) {
  const recoveryMode = String(options.recoveryMode || 'visible-browser-edit').trim();
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    // Ignore scroll failures and still try to find the edit entry.
  }
  await page.waitForTimeout(700);

  const editEntry = pickVisibleDocumentEditEntry(await collectVisibleDocumentEditEntries(page));
  if (!editEntry) {
    return {
      ...normalizeRenderedImageRecoveryOutcome(),
      recoveryMode,
      rejectionCode: 'edit-entry-missing',
    };
  }

  const clicked = await clickDocumentEditEntryOnPage(page, editEntry);
  if (!clicked) {
    return {
      ...normalizeRenderedImageRecoveryOutcome(),
      recoveryMode,
      rejectionCode: 'edit-entry-missing',
    };
  }

  await page.waitForTimeout(1200);
  try {
    await page.waitForFunction(
      (payload) => {
        const visible = (node) => {
          if (!node) {
            return false;
          }
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0.01 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
        const roots = Array.from(document.querySelectorAll(payload.rootSelector)).filter(
          (node) => visible(node) && !isExcluded(node),
        );
        const toolbars = Array.from(document.querySelectorAll(payload.toolbarSelector)).filter(
          (node) => visible(node) && !isExcluded(node),
        );
        return roots.length > 0 || toolbars.length > 0;
      },
      { timeout: DOCUMENT_EDIT_MODE_WAIT_MS },
      buildDocumentEditDomProbePayload(),
    );
  } catch {
    // Keep going and inspect the final DOM state so we can return a precise reason.
  }

  const editState = classifyDocumentEditModeState(await inspectDocumentEditModeOnPage(page));
  return {
    ...normalizeRenderedImageRecoveryOutcome(),
    ...editState,
    recoveryMode,
    rejectionCode: editState.rejectionCode,
  };
}

async function collectDocumentEditImageCandidates(page) {
  return await page.evaluate((payload) => {
    const visible = (node) => {
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
    const roots = Array.from(document.querySelectorAll(payload.rootSelector))
      .filter((node) => visible(node) && !isExcluded(node))
      .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    const images = [];

    for (const root of roots) {
      for (const node of Array.from(root.querySelectorAll('img'))) {
        if (isExcluded(node)) {
          continue;
        }
        const rect = node.getBoundingClientRect();
        images.push({
          domIndex: images.length,
          currentSrc: String(node.currentSrc || ''),
          src: String(node.getAttribute('src') || ''),
          dataSrc: String(node.getAttribute('data-src') || ''),
          alt: String(node.getAttribute('alt') || ''),
          naturalWidth: Number(node.naturalWidth || 0),
          naturalHeight: Number(node.naturalHeight || 0),
          clientWidth: Number(node.clientWidth || rect.width || 0),
          clientHeight: Number(node.clientHeight || rect.height || 0),
          complete: Boolean(node.complete),
          visible: visible(node),
        });
      }
    }

    return images;
  }, buildDocumentEditDomProbePayload());
}

async function inspectDocumentEditImageCaptureTarget(page, domIndex) {
  try {
    const snapshot = await page.evaluate((payload) => {
      const visible = (node) => {
        if (!node) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.01 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
      const roots = Array.from(document.querySelectorAll(payload.rootSelector))
        .filter((node) => visible(node) && !isExcluded(node))
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
      const images = [];
      for (const root of roots) {
        for (const node of Array.from(root.querySelectorAll('img'))) {
          if (!isExcluded(node)) {
            images.push(node);
          }
        }
      }

      const img = images[payload.domIndex] || null;
      if (!img) {
        return {
          exists: false,
          rejectionCode: 'image-slot-missing',
          visibleText: '',
          naturalWidth: 0,
          naturalHeight: 0,
          clientWidth: 0,
          clientHeight: 0,
          captureBytes: 0,
          complete: false,
          hasLoadedImage: false,
          hasRenderableVisualNode: false,
          hasMeaningfulText: false,
          hasBackgroundImage: false,
          placeholderTextDetected: false,
          placeholderAttributeDetected: false,
        };
      }

      const seen = new Set();
      const candidates = [];
      const addCandidate = (node) => {
        if (!node || seen.has(node) || isExcluded(node)) {
          return;
        }
        seen.add(node);
        candidates.push(node);
      };

      addCandidate(img.closest('[data-testid="ne-card-image"]'));
      addCandidate(img.closest('.ne-image-wrap'));
      addCandidate(img.closest('.ne-image-box'));
      addCandidate(img.closest('.ne-card-container'));
      addCandidate(img.closest('figure'));
      addCandidate(img.closest('a'));
      addCandidate(img.closest('li'));
      addCandidate(img.closest('p'));

      let current = img;
      let depth = 0;
      while (current && depth < 8) {
        addCandidate(current);
        current = current.parentElement;
        depth += 1;
      }

      const captureNode =
        candidates.find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 8 && rect.height > 8;
        }) || img;
      const rect = captureNode.getBoundingClientRect();
      const candidateImages = [
        ...(captureNode.tagName === 'IMG' ? [captureNode] : []),
        ...Array.from(captureNode.querySelectorAll?.('img') || []),
      ];
      const visibleText = String(captureNode.innerText || captureNode.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      const hasLoadedImage = candidateImages.some(
        (node) => Number(node?.naturalWidth || 0) > 8 && Number(node?.naturalHeight || 0) > 8,
      );
      const hasRenderableVisualNode = Boolean(captureNode.querySelector?.('canvas, svg, video, picture'));
      const hasBackgroundImage = [captureNode, ...Array.from(captureNode.querySelectorAll?.('*') || []).slice(0, 24)].some(
        (node) => {
          if (!visible(node)) {
            return false;
          }
          const style = window.getComputedStyle(node);
          const backgroundImage = String(style?.backgroundImage || '').trim();
          return Boolean(backgroundImage) && backgroundImage !== 'none';
        },
      );
      const placeholderTextDetected = /该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(
        visibleText,
      );
      const placeholderAttributeDetected = candidateImages.some((node) =>
        /forbid|forbidden|reject|banned|placeholder|unavailable/i.test(
          `${node?.currentSrc || ''} ${node?.getAttribute?.('src') || ''} ${node?.getAttribute?.('alt') || ''}`.toLowerCase(),
        ),
      );

      return {
        exists: true,
        rejectionCode: '',
        visibleText,
        naturalWidth: Number(img.naturalWidth || 0),
        naturalHeight: Number(img.naturalHeight || 0),
        clientWidth: Number(img.clientWidth || rect.width || 0),
        clientHeight: Number(img.clientHeight || rect.height || 0),
        captureBytes: 0,
        complete: Boolean(img.complete),
        hasLoadedImage,
        hasRenderableVisualNode,
        hasMeaningfulText: Boolean(visibleText),
        hasBackgroundImage,
        placeholderTextDetected,
        placeholderAttributeDetected,
      };
    }, buildDocumentEditDomProbePayload({ domIndex }));
    return classifyRenderedImageCaptureInspection(snapshot);
  } catch {
    return classifyRenderedImageCaptureInspection({
      exists: false,
      rejectionCode: 'capture-exception',
      visibleText: '',
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
      captureBytes: 0,
      complete: false,
      hasLoadedImage: false,
      hasRenderableVisualNode: false,
      hasMeaningfulText: false,
      hasBackgroundImage: false,
      placeholderTextDetected: false,
      placeholderAttributeDetected: false,
    });
  }
}

async function getDocumentEditImageCaptureHandle(page, domIndex) {
  return await page.evaluateHandle((payload) => {
    const visible = (node) => {
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
    const roots = Array.from(document.querySelectorAll(payload.rootSelector))
      .filter((node) => visible(node) && !isExcluded(node))
      .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    const images = [];
    for (const root of roots) {
      for (const node of Array.from(root.querySelectorAll('img'))) {
        if (!isExcluded(node)) {
          images.push(node);
        }
      }
    }

    const img = images[payload.domIndex] || null;
    if (!img) {
      return null;
    }

    const seen = new Set();
    const candidates = [];
    const addCandidate = (node) => {
      if (!node || seen.has(node) || isExcluded(node)) {
        return;
      }
      seen.add(node);
      candidates.push(node);
    };

    addCandidate(img.closest('[data-testid="ne-card-image"]'));
    addCandidate(img.closest('.ne-image-wrap'));
    addCandidate(img.closest('.ne-image-box'));
    addCandidate(img.closest('.ne-card-container'));
    addCandidate(img.closest('figure'));
    addCandidate(img.closest('a'));
    addCandidate(img.closest('li'));
    addCandidate(img.closest('p'));

    let current = img;
    let depth = 0;
    while (current && depth < 8) {
      addCandidate(current);
      current = current.parentElement;
      depth += 1;
    }

    return (
      candidates.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      }) || img
    );
  }, buildDocumentEditDomProbePayload({ domIndex }));
}

async function scrollDocumentEditImageIntoView(page, domIndex) {
  try {
    await page.evaluate((payload) => {
      const visible = (node) => {
        if (!node) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.01 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
      const roots = Array.from(document.querySelectorAll(payload.rootSelector))
        .filter((node) => visible(node) && !isExcluded(node))
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
      const images = [];
      for (const root of roots) {
        for (const node of Array.from(root.querySelectorAll('img'))) {
          if (!isExcluded(node)) {
            images.push(node);
          }
        }
      }
      images[payload.domIndex]?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    }, buildDocumentEditDomProbePayload({ domIndex }));
  } catch {
    // Ignore scroll failures and let downstream inspection report the concrete problem.
  }
}

async function waitForDocumentEditImageReady(page, domIndex, options = {}) {
  const timeout = Math.max(1000, Number(options.timeoutMs) || 12000);
  try {
    await page.waitForFunction(
      (payload) => {
        const visible = (node) => {
          if (!node) {
            return false;
          }
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0.01 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
        const roots = Array.from(document.querySelectorAll(payload.rootSelector))
          .filter((node) => visible(node) && !isExcluded(node))
          .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
        const images = [];
        for (const root of roots) {
          for (const node of Array.from(root.querySelectorAll('img'))) {
            if (!isExcluded(node)) {
              images.push(node);
            }
          }
        }

        const img = images[payload.domIndex] || null;
        if (!img) {
          return false;
        }

        const seen = new Set();
        const candidates = [];
        const addCandidate = (node) => {
          if (!node || seen.has(node) || isExcluded(node)) {
            return;
          }
          seen.add(node);
          candidates.push(node);
        };

        addCandidate(img.closest('[data-testid="ne-card-image"]'));
        addCandidate(img.closest('.ne-image-wrap'));
        addCandidate(img.closest('.ne-image-box'));
        addCandidate(img.closest('.ne-card-container'));
        addCandidate(img.closest('figure'));
        addCandidate(img.closest('a'));
        addCandidate(img.closest('li'));
        addCandidate(img.closest('p'));

        let current = img;
        let depth = 0;
        while (current && depth < 8) {
          addCandidate(current);
          current = current.parentElement;
          depth += 1;
        }

        const captureNode = candidates.find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 8 && rect.height > 8;
        }) || img;

        const visibleText = String(captureNode.innerText || captureNode.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        if (/该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(visibleText)) {
          return true;
        }

        if (Number(img.naturalWidth || 0) > 8 && Number(img.naturalHeight || 0) > 8) {
          return true;
        }

        if (captureNode.querySelector?.('canvas, svg, video, picture')) {
          return true;
        }

        const hasBackgroundImage = [captureNode, ...Array.from(captureNode.querySelectorAll?.('*') || []).slice(0, 24)].some(
          (node) => {
            if (!visible(node)) {
              return false;
            }
            const style = window.getComputedStyle(node);
            const backgroundImage = String(style?.backgroundImage || '').trim();
            return Boolean(backgroundImage) && backgroundImage !== 'none';
          },
        );
        if (hasBackgroundImage) {
          return true;
        }

        const rect = img.getBoundingClientRect();
        return Boolean(img.complete) && rect.width > 8 && rect.height > 8;
      },
      { timeout },
      buildDocumentEditDomProbePayload({ domIndex }),
    );
    return true;
  } catch {
    return false;
  }
}

async function getDocumentEditImageHandle(page, domIndex) {
  const handleRef = await page.evaluateHandle((payload) => {
    const visible = (node) => {
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const isExcluded = (node) => Boolean(payload.excludedSelector && node?.closest?.(payload.excludedSelector));
    const roots = Array.from(document.querySelectorAll(payload.rootSelector))
      .filter((node) => visible(node) && !isExcluded(node))
      .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    const images = [];
    for (const root of roots) {
      for (const node of Array.from(root.querySelectorAll('img'))) {
        if (!isExcluded(node)) {
          images.push(node);
        }
      }
    }
    return images[payload.domIndex] || null;
  }, buildDocumentEditDomProbePayload({ domIndex }));

  const elementHandle = typeof handleRef?.asElement === 'function' ? handleRef.asElement() : null;
  if (!elementHandle) {
    await disposeHandleSafely(handleRef);
    return null;
  }
  return elementHandle;
}

async function isDocumentEditImageHandleUsable(imageHandle) {
  if (!imageHandle) {
    return false;
  }

  try {
    return await imageHandle.evaluate((node) => Boolean(node?.isConnected));
  } catch {
    return false;
  }
}

async function inspectDocumentEditImageHandle(imageHandle) {
  try {
    return await imageHandle.evaluate((img) => {
      if (!img || !img.isConnected) {
        return {
          exists: false,
          currentSrc: '',
          src: '',
          dataSrc: '',
          alt: '',
          naturalWidth: 0,
          naturalHeight: 0,
          clientWidth: 0,
          clientHeight: 0,
          complete: false,
          visible: false,
        };
      }

      const style = window.getComputedStyle(img);
      const rect = img.getBoundingClientRect();
      return {
        exists: true,
        currentSrc: String(img.currentSrc || ''),
        src: String(img.getAttribute('src') || ''),
        dataSrc: String(img.getAttribute('data-src') || ''),
        alt: String(img.getAttribute('alt') || ''),
        naturalWidth: Number(img.naturalWidth || 0),
        naturalHeight: Number(img.naturalHeight || 0),
        clientWidth: Number(img.clientWidth || rect.width || 0),
        clientHeight: Number(img.clientHeight || rect.height || 0),
        complete: Boolean(img.complete),
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.01 &&
          rect.width > 0 &&
          rect.height > 0,
      };
    });
  } catch {
    return {
      exists: false,
      currentSrc: '',
      src: '',
      dataSrc: '',
      alt: '',
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
      complete: false,
      visible: false,
    };
  }
}

async function scrollDocumentEditImageHandleIntoView(imageHandle) {
  try {
    await imageHandle.evaluate((node) => node?.scrollIntoView?.({ block: 'center', inline: 'nearest' }));
  } catch {
    // Ignore scroll failures and let downstream inspection report the concrete problem.
  }
}

async function waitForDocumentEditImageHandleReady(page, imageHandle, options = {}) {
  const timeout = Math.max(1000, Number(options.timeoutMs) || 12000);
  try {
    await page.waitForFunction(
      (img) => {
        const visible = (node) => {
          if (!node) {
            return false;
          }
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0.01 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const addCandidate = (target, list, seen) => {
          if (!target || seen.has(target)) {
            return;
          }
          seen.add(target);
          list.push(target);
        };
        if (!img || !img.isConnected) {
          return false;
        }

        const seen = new Set();
        const candidates = [];
        addCandidate(img.closest('[data-testid="ne-card-image"]'), candidates, seen);
        addCandidate(img.closest('.ne-image-wrap'), candidates, seen);
        addCandidate(img.closest('.ne-image-box'), candidates, seen);
        addCandidate(img.closest('.ne-card-container'), candidates, seen);
        addCandidate(img.closest('figure'), candidates, seen);
        addCandidate(img.closest('a'), candidates, seen);
        addCandidate(img.closest('li'), candidates, seen);
        addCandidate(img.closest('p'), candidates, seen);

        let current = img;
        let depth = 0;
        while (current && depth < 8) {
          addCandidate(current, candidates, seen);
          current = current.parentElement;
          depth += 1;
        }

        const captureNode =
          candidates.find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8;
          }) || img;

        const visibleText = String(captureNode.innerText || captureNode.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        if (/该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(visibleText)) {
          return true;
        }

        if (Number(img.naturalWidth || 0) > 8 && Number(img.naturalHeight || 0) > 8) {
          return true;
        }

        if (captureNode.querySelector?.('canvas, svg, video, picture')) {
          return true;
        }

        const hasBackgroundImage = [captureNode, ...Array.from(captureNode.querySelectorAll?.('*') || []).slice(0, 24)].some(
          (node) => {
            if (!visible(node)) {
              return false;
            }
            const style = window.getComputedStyle(node);
            const backgroundImage = String(style?.backgroundImage || '').trim();
            return Boolean(backgroundImage) && backgroundImage !== 'none';
          },
        );
        if (hasBackgroundImage) {
          return true;
        }

        const rect = img.getBoundingClientRect();
        return Boolean(img.complete) && rect.width > 8 && rect.height > 8;
      },
      { timeout },
      imageHandle,
    );
    return true;
  } catch {
    return false;
  }
}

function getDocumentEditCaptureTargetRoleRank(role = '') {
  switch (String(role || '').trim().toLowerCase()) {
    case 'img':
      return 0;
    case 'picture':
      return 1;
    case 'card-image':
      return 2;
    case 'image-wrap':
      return 3;
    case 'image-box':
      return 4;
    case 'figure':
      return 5;
    case 'anchor':
      return 8;
    case 'list-item':
      return 10;
    case 'paragraph':
      return 11;
    default:
      return 14;
  }
}

export function pickDocumentEditCaptureTargetCandidate(candidates = [], options = {}) {
  const allCandidates = Array.isArray(candidates) ? candidates : [];
  const boundArea = Math.max(
    1,
    Number(options?.boundArea) ||
      (Number(options?.boundClientWidth) || 0) * (Number(options?.boundClientHeight) || 0) ||
      (Number(options?.boundNaturalWidth) || 0) * (Number(options?.boundNaturalHeight) || 0) ||
      1,
  );
  const accepted = [];
  let ambiguous = false;

  for (const candidate of allCandidates) {
    const width = Number(candidate?.width) || 0;
    const height = Number(candidate?.height) || 0;
    if (candidate?.visible === false || width <= 8 || height <= 8 || candidate?.containsBoundImage === false) {
      continue;
    }

    const roleRank = getDocumentEditCaptureTargetRoleRank(candidate?.role);
    const isPreferredRole = roleRank <= 5;
    const area = Number(candidate?.area) || width * height;
    const areaRatio = Number(candidate?.areaRatio) || (boundArea > 0 ? area / boundArea : area);
    const renderableImageCount = Math.max(0, Number(candidate?.renderableImageCount) || 0);
    const totalImageCount = Math.max(renderableImageCount, Number(candidate?.totalImageCount) || 0);
    const oversized = areaRatio > (isPreferredRole ? 16 : 9);
    const sharedRenderableContainer = renderableImageCount > 1;
    const oversizedSharedContainer = !isPreferredRole && (totalImageCount > 1 || oversized);
    if (sharedRenderableContainer || oversizedSharedContainer) {
      ambiguous = true;
      continue;
    }

    accepted.push({
      ...candidate,
      roleRank,
      area,
      areaRatio,
      renderableImageCount,
      totalImageCount,
    });
  }

  if (accepted.length === 0) {
    return {
      candidate: null,
      ambiguous,
    };
  }

  accepted.sort((left, right) => {
    const roleDelta = Number(left.roleRank || 0) - Number(right.roleRank || 0);
    if (roleDelta !== 0) {
      return roleDelta;
    }
    const ratioDelta = Number(left.areaRatio || 0) - Number(right.areaRatio || 0);
    if (ratioDelta !== 0) {
      return ratioDelta;
    }
    const areaDelta = Number(left.area || 0) - Number(right.area || 0);
    if (areaDelta !== 0) {
      return areaDelta;
    }
    const depthDelta = Number(left.depth || 0) - Number(right.depth || 0);
    if (depthDelta !== 0) {
      return depthDelta;
    }
    return Number(left.key || 0) - Number(right.key || 0);
  });

  return {
    candidate: accepted[0],
    ambiguous: false,
  };
}

async function collectDocumentEditImageHandleCaptureTargetProbe(imageHandle) {
  try {
    return await imageHandle.evaluate((img) => {
      const visible = (node) => {
        if (!node) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0.01 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const placeholderPattern = /该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable|forbid|forbidden|reject|banned|placeholder|unavailable/i;
      const isPlaceholderImage = (node) =>
        placeholderPattern.test(
          `${node?.currentSrc || ''} ${node?.getAttribute?.('src') || ''} ${node?.getAttribute?.('alt') || ''}`.toLowerCase(),
        );
      const isRenderableImage = (node) => {
        if (!node || !visible(node) || isPlaceholderImage(node)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return Boolean(
          (Number(node.naturalWidth || 0) > 8 && Number(node.naturalHeight || 0) > 8) ||
            rect.width > 8 ||
            rect.height > 8 ||
            Number(node.clientWidth || 0) > 8 ||
            Number(node.clientHeight || 0) > 8,
        );
      };
      const addCandidate = (target, role, depth, list, seen) => {
        if (!target || seen.has(target)) {
          return;
        }
        seen.add(target);
        list.push({
          node: target,
          role,
          depth,
        });
      };

      if (!img || !img.isConnected) {
        return {
          exists: false,
          currentSrc: '',
          src: '',
          dataSrc: '',
          alt: '',
          boundNaturalWidth: 0,
          boundNaturalHeight: 0,
          boundClientWidth: 0,
          boundClientHeight: 0,
          boundComplete: false,
          boundArea: 1,
          candidates: [],
        };
      }

      const imgRect = img.getBoundingClientRect();
      const boundClientWidth = Number(img.clientWidth || imgRect.width || 0);
      const boundClientHeight = Number(img.clientHeight || imgRect.height || 0);
      const boundArea = Math.max(1, boundClientWidth * boundClientHeight);
      const seen = new Set();
      const candidates = [];
      addCandidate(img, 'img', 0, candidates, seen);
      addCandidate(img.closest('picture'), 'picture', 1, candidates, seen);
      addCandidate(img.closest('[data-testid="ne-card-image"]'), 'card-image', 1, candidates, seen);
      addCandidate(img.closest('.ne-image-wrap'), 'image-wrap', 1, candidates, seen);
      addCandidate(img.closest('.ne-image-box'), 'image-box', 1, candidates, seen);
      addCandidate(img.closest('figure'), 'figure', 1, candidates, seen);
      addCandidate(img.closest('a'), 'anchor', 1, candidates, seen);
      addCandidate(img.closest('li'), 'list-item', 1, candidates, seen);
      addCandidate(img.closest('p'), 'paragraph', 1, candidates, seen);

      let current = img.parentElement;
      let depth = 0;
      while (current && depth < 8) {
        addCandidate(current, 'ancestor', depth + 1, candidates, seen);
        current = current.parentElement;
        depth += 1;
      }
      return {
        exists: true,
        currentSrc: String(img.currentSrc || ''),
        src: String(img.getAttribute('src') || ''),
        dataSrc: String(img.getAttribute('data-src') || ''),
        alt: String(img.getAttribute('alt') || ''),
        boundNaturalWidth: Number(img.naturalWidth || 0),
        boundNaturalHeight: Number(img.naturalHeight || 0),
        boundClientWidth,
        boundClientHeight,
        boundComplete: Boolean(img.complete),
        boundArea,
        candidates: candidates.map((entry, index) => {
          const captureNode = entry.node;
          const rect = captureNode.getBoundingClientRect();
          const candidateImages = [
            ...(captureNode.tagName === 'IMG' ? [captureNode] : []),
            ...Array.from(captureNode.querySelectorAll?.('img') || []),
          ];
          const visibleText = String(captureNode.innerText || captureNode.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          const hasLoadedImage = candidateImages.some(
            (node) => Number(node?.naturalWidth || 0) > 8 && Number(node?.naturalHeight || 0) > 8,
          );
          const hasRenderableVisualNode = Boolean(captureNode.querySelector?.('canvas, svg, video, picture'));
          const hasBackgroundImage = [captureNode, ...Array.from(captureNode.querySelectorAll?.('*') || []).slice(0, 24)].some(
            (node) => {
              if (!visible(node)) {
                return false;
              }
              const style = window.getComputedStyle(node);
              const backgroundImage = String(style?.backgroundImage || '').trim();
              return Boolean(backgroundImage) && backgroundImage !== 'none';
            },
          );
          const placeholderTextDetected = /该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(
            visibleText,
          );
          const placeholderAttributeDetected = candidateImages.some((node) => isPlaceholderImage(node));
          return {
            key: index,
            role: entry.role,
            depth: entry.depth,
            visible: visible(captureNode),
            containsBoundImage: captureNode === img || captureNode.contains?.(img) === true,
            width: Number(rect.width || 0),
            height: Number(rect.height || 0),
            area: Number(rect.width || 0) * Number(rect.height || 0),
            areaRatio: boundArea > 0 ? (Number(rect.width || 0) * Number(rect.height || 0)) / boundArea : 0,
            renderableImageCount: candidateImages.filter((node) => isRenderableImage(node)).length,
            totalImageCount: candidateImages.length,
            visibleText,
            hasLoadedImage,
            hasRenderableVisualNode,
            hasMeaningfulText: Boolean(visibleText) && !placeholderTextDetected,
            hasBackgroundImage,
            placeholderTextDetected,
            placeholderAttributeDetected,
          };
        }),
      };
    });
  } catch {
    return {
      exists: false,
      currentSrc: '',
      src: '',
      dataSrc: '',
      alt: '',
      boundNaturalWidth: 0,
      boundNaturalHeight: 0,
      boundClientWidth: 0,
      boundClientHeight: 0,
      boundComplete: false,
      boundArea: 1,
      candidates: [],
      probeFailed: true,
    };
  }
}

async function inspectDocumentEditImageHandleCaptureTarget(imageHandle) {
  const probe = await collectDocumentEditImageHandleCaptureTargetProbe(imageHandle);
  if (!probe?.exists) {
    return classifyRenderedImageCaptureInspection({
      exists: false,
      rejectionCode: probe?.probeFailed ? 'capture-exception' : 'capture-target-missing',
      visibleText: '',
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
      captureBytes: 0,
      complete: false,
      hasLoadedImage: false,
      hasRenderableVisualNode: false,
      hasMeaningfulText: false,
      hasBackgroundImage: false,
      placeholderTextDetected: false,
      placeholderAttributeDetected: false,
    });
  }

  const selection = pickDocumentEditCaptureTargetCandidate(probe.candidates, probe);
  if (!selection.candidate) {
    const classified = classifyDocumentEditImageCaptureInspection({
      exists: true,
      rejectionCode: selection.ambiguous ? 'edit-capture-target-ambiguous' : 'edit-capture-target-missing',
      visibleText: '',
      naturalWidth: Number(probe.boundNaturalWidth) || 0,
      naturalHeight: Number(probe.boundNaturalHeight) || 0,
      clientWidth: Number(probe.boundClientWidth) || 0,
      clientHeight: Number(probe.boundClientHeight) || 0,
      captureBytes: 0,
      complete: Boolean(probe.boundComplete),
      hasLoadedImage: false,
      hasRenderableVisualNode: false,
      hasMeaningfulText: false,
      hasBackgroundImage: false,
      placeholderTextDetected: false,
      placeholderAttributeDetected: false,
      currentSrc: probe.currentSrc,
      src: probe.src,
      dataSrc: probe.dataSrc,
      alt: probe.alt,
    });
    return {
      ...classified,
      selectedCandidateKey: -1,
    };
  }

  const classified = classifyDocumentEditImageCaptureInspection({
    exists: true,
    rejectionCode: '',
    selectedCandidateKey: selection.candidate.key,
    visibleText: selection.candidate.visibleText,
    naturalWidth: Number(probe.boundNaturalWidth) || 0,
    naturalHeight: Number(probe.boundNaturalHeight) || 0,
    clientWidth: Number(probe.boundClientWidth || selection.candidate.width) || 0,
    clientHeight: Number(probe.boundClientHeight || selection.candidate.height) || 0,
    captureBytes: 0,
    complete: Boolean(probe.boundComplete),
    hasLoadedImage: Boolean(selection.candidate.hasLoadedImage),
    hasRenderableVisualNode: Boolean(selection.candidate.hasRenderableVisualNode),
    hasMeaningfulText: Boolean(selection.candidate.hasMeaningfulText),
    hasBackgroundImage: Boolean(selection.candidate.hasBackgroundImage),
    placeholderTextDetected: Boolean(selection.candidate.placeholderTextDetected),
    placeholderAttributeDetected: Boolean(selection.candidate.placeholderAttributeDetected),
    captureTargetRole: selection.candidate.role,
    captureTargetArea: Number(selection.candidate.area) || 0,
    captureTargetAreaRatio: Number(selection.candidate.areaRatio) || 0,
    renderableImageCount: Number(selection.candidate.renderableImageCount) || 0,
    totalImageCount: Number(selection.candidate.totalImageCount) || 0,
    captureTargetContainsBoundImage: Boolean(selection.candidate.containsBoundImage),
    currentSrc: probe.currentSrc,
    src: probe.src,
    dataSrc: probe.dataSrc,
    alt: probe.alt,
  });
  return {
    ...classified,
    selectedCandidateKey: selection.candidate.key,
    captureTargetRole: selection.candidate.role,
    captureTargetArea: Number(selection.candidate.area) || 0,
    captureTargetAreaRatio: Number(selection.candidate.areaRatio) || 0,
    renderableImageCount: Number(selection.candidate.renderableImageCount) || 0,
    totalImageCount: Number(selection.candidate.totalImageCount) || 0,
    captureTargetContainsBoundImage: Boolean(selection.candidate.containsBoundImage),
  };
}

async function getDocumentEditImageHandleCaptureTarget(imageHandle, preferredCandidateKey = -1) {
  const probe = await collectDocumentEditImageHandleCaptureTargetProbe(imageHandle);
  if (!probe?.exists) {
    return null;
  }

  const selection = pickDocumentEditCaptureTargetCandidate(probe.candidates, probe);
  const candidateKey =
    Number.isFinite(Number(preferredCandidateKey)) &&
    Number(preferredCandidateKey) >= 0 &&
    selection?.candidate?.key === Number(preferredCandidateKey)
      ? Number(preferredCandidateKey)
      : Number(selection?.candidate?.key);
  if (!Number.isFinite(candidateKey) || candidateKey < 0) {
    return null;
  }

  const handleRef = await imageHandle.evaluateHandle((img, targetCandidateKey) => {
    const visible = (node) => {
      if (!node) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const addCandidate = (target, role, depth, list, seen) => {
      if (!target || seen.has(target)) {
        return;
      }
      seen.add(target);
      list.push({
        node: target,
        role,
        depth,
      });
    };

    if (!img || !img.isConnected) {
      return null;
    }

    const seen = new Set();
    const candidates = [];
    addCandidate(img, 'img', 0, candidates, seen);
    addCandidate(img.closest('picture'), 'picture', 1, candidates, seen);
    addCandidate(img.closest('[data-testid="ne-card-image"]'), 'card-image', 1, candidates, seen);
    addCandidate(img.closest('.ne-image-wrap'), 'image-wrap', 1, candidates, seen);
    addCandidate(img.closest('.ne-image-box'), 'image-box', 1, candidates, seen);
    addCandidate(img.closest('figure'), 'figure', 1, candidates, seen);
    addCandidate(img.closest('a'), 'anchor', 1, candidates, seen);
    addCandidate(img.closest('li'), 'list-item', 1, candidates, seen);
    addCandidate(img.closest('p'), 'paragraph', 1, candidates, seen);

    let current = img.parentElement;
    let depth = 0;
    while (current && depth < 8) {
      addCandidate(current, 'ancestor', depth + 1, candidates, seen);
      current = current.parentElement;
      depth += 1;
    }

    const selected = candidates.find((entry, index) => index === targetCandidateKey && visible(entry.node));
    return selected?.node || null;
  }, candidateKey);

  const elementHandle = typeof handleRef?.asElement === 'function' ? handleRef.asElement() : null;
  if (!elementHandle) {
    await disposeHandleSafely(handleRef);
    return null;
  }
  return elementHandle;
}

function doesDocumentEditImageMatchStrongIdentity(snapshot = {}, fallback = {}) {
  return evaluateDocumentEditImageStrongIdentity(snapshot, fallback).matches;
}

function evaluateDocumentEditImageStrongIdentity(snapshot = {}, fallback = {}) {
  const strongChecks = [];
  let hasComparableIdentity = false;

  const targetOriginalUrl = normalizeAssetMatchUrl(fallback?.originalUrl);
  if (targetOriginalUrl) {
    const actualUrls = getImageCandidateMatchUrls(snapshot);
    if (actualUrls.length > 0) {
      hasComparableIdentity = true;
      strongChecks.push(actualUrls.includes(targetOriginalUrl));
    }
  }

  const targetBasenames = dedupeTexts(
    (Array.isArray(fallback?.basenameCandidates) ? fallback.basenameCandidates : []).map((value) =>
      String(value || '').toLowerCase(),
    ),
  ).filter(Boolean);
  if (targetBasenames.length > 0) {
    const actualBasenames = getImageCandidateBasenames(snapshot);
    if (actualBasenames.length > 0) {
      hasComparableIdentity = true;
      strongChecks.push(actualBasenames.some((name) => targetBasenames.includes(name)));
    }
  }

  const normalizedAlt = normalizeComparableText(fallback?.assetAlt);
  if (normalizedAlt) {
    const actualAlt = normalizeComparableText(snapshot?.alt);
    if (actualAlt) {
      hasComparableIdentity = true;
      strongChecks.push(
        actualAlt === normalizedAlt ||
          actualAlt.includes(normalizedAlt) ||
          normalizedAlt.includes(actualAlt),
      );
    }
  }

  return {
    hasComparableIdentity,
    matches: !hasComparableIdentity || strongChecks.some(Boolean),
  };
}

function isDocumentEditImageSnapshotWeak(snapshot = {}) {
  if (snapshot?.exists === false) {
    return true;
  }

  const hasIdentity =
    getImageCandidateMatchUrls(snapshot).length > 0 ||
    getImageCandidateBasenames(snapshot).length > 0 ||
    Boolean(normalizeComparableText(snapshot?.alt));
  const hasDimensions =
    Number(snapshot?.naturalWidth) > 0 ||
    Number(snapshot?.naturalHeight) > 0 ||
    Number(snapshot?.clientWidth) > 0 ||
    Number(snapshot?.clientHeight) > 0;

  return !hasIdentity && !hasDimensions && !Boolean(snapshot?.complete);
}

function buildDocumentEditImageCandidateSnapshot(candidate = {}) {
  return {
    exists: true,
    currentSrc: String(candidate?.currentSrc || '').trim(),
    src: String(candidate?.src || '').trim(),
    dataSrc: String(candidate?.dataSrc || '').trim(),
    alt: String(candidate?.alt || '').trim(),
    naturalWidth: Number(candidate?.naturalWidth) || 0,
    naturalHeight: Number(candidate?.naturalHeight) || 0,
    clientWidth: Number(candidate?.clientWidth) || 0,
    clientHeight: Number(candidate?.clientHeight) || 0,
    complete: Boolean(candidate?.complete),
    visible: candidate?.visible !== false,
  };
}

function buildDocumentEditImageEffectiveIdentitySnapshot(snapshot = {}, candidate = {}) {
  if (!isDocumentEditImageSnapshotWeak(snapshot)) {
    return snapshot;
  }

  const candidateSnapshot = buildDocumentEditImageCandidateSnapshot(candidate);
  return {
    ...candidateSnapshot,
    ...snapshot,
    exists: snapshot?.exists !== false || candidateSnapshot.exists === true,
    currentSrc: String(snapshot?.currentSrc || candidateSnapshot.currentSrc || '').trim(),
    src: String(snapshot?.src || candidateSnapshot.src || '').trim(),
    dataSrc: String(snapshot?.dataSrc || candidateSnapshot.dataSrc || '').trim(),
    alt: String(snapshot?.alt || candidateSnapshot.alt || '').trim(),
    naturalWidth: Number(snapshot?.naturalWidth) || Number(candidateSnapshot.naturalWidth) || 0,
    naturalHeight: Number(snapshot?.naturalHeight) || Number(candidateSnapshot.naturalHeight) || 0,
    clientWidth: Number(snapshot?.clientWidth) || Number(candidateSnapshot.clientWidth) || 0,
    clientHeight: Number(snapshot?.clientHeight) || Number(candidateSnapshot.clientHeight) || 0,
    complete: Boolean(snapshot?.complete || candidateSnapshot.complete),
    visible: snapshot?.visible !== false || candidateSnapshot.visible === true,
  };
}

function buildDocumentEditImageIdentityMismatchFailure(fallback = {}, snapshot = {}, recoveryMode = '') {
  const failure = {
    ...normalizeRenderedImageRecoveryOutcome(fallback),
    recoveryMode,
    rejectionCode: 'edit-image-identity-mismatch',
    visibleText: formatRenderedImageVisibleText(snapshot?.alt || ''),
    naturalWidth: Number(snapshot?.naturalWidth) || 0,
    naturalHeight: Number(snapshot?.naturalHeight) || 0,
    clientWidth: Number(snapshot?.clientWidth) || 0,
    clientHeight: Number(snapshot?.clientHeight) || 0,
    complete: Boolean(snapshot?.complete),
    currentSrc: String(snapshot?.currentSrc || '').trim(),
    dataSrc: String(snapshot?.dataSrc || '').trim(),
    actualAlt: String(snapshot?.alt || '').trim(),
  };
  return {
    ...failure,
    rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
  };
}

export async function captureRenderedImageFallbackInEditModeOnPage(page, docPlan, fallback, targetPath, options = {}) {
  const recoveryMode = String(options.recoveryMode || 'visible-browser-edit').trim();
  if (!options.skipEnterEditMode) {
    const editModeState = await enterDocumentEditModeOnPage(page, {
      ...options,
      recoveryMode,
    });
    if (editModeState.rejectionCode) {
      return {
        ...normalizeRenderedImageRecoveryOutcome(fallback),
        ...editModeState,
        rejectionReason: buildRenderedImageRecoveryFailureDescription(editModeState),
      };
    }
  }

  const collectEditCandidates =
    typeof options.collectDocumentEditImageCandidatesFn === 'function'
      ? options.collectDocumentEditImageCandidatesFn
      : collectDocumentEditImageCandidates;
  const captureEditElementScreenshot =
    typeof options.captureElementScreenshotFn === 'function' ? options.captureElementScreenshotFn : captureElementScreenshot;
  const getEditImageHandle =
    typeof options.getDocumentEditImageHandleFn === 'function' ? options.getDocumentEditImageHandleFn : null;
  const isEditImageHandleStillUsable =
    typeof options.isDocumentEditImageHandleUsableFn === 'function'
      ? options.isDocumentEditImageHandleUsableFn
      : isDocumentEditImageHandleUsable;
  const inspectEditImageHandle =
    typeof options.inspectDocumentEditImageHandleFn === 'function'
      ? options.inspectDocumentEditImageHandleFn
      : inspectDocumentEditImageHandle;
  const scrollEditImageHandleIntoViewFn =
    typeof options.scrollDocumentEditImageHandleIntoViewFn === 'function'
      ? options.scrollDocumentEditImageHandleIntoViewFn
      : null;
  const waitForEditImageHandleReadyFn =
    typeof options.waitForDocumentEditImageHandleReadyFn === 'function'
      ? options.waitForDocumentEditImageHandleReadyFn
      : null;
  const inspectEditHandleCaptureTarget =
    typeof options.inspectDocumentEditImageHandleCaptureTargetFn === 'function'
      ? options.inspectDocumentEditImageHandleCaptureTargetFn
      : null;
  const getEditHandleCaptureTarget =
    typeof options.getDocumentEditImageHandleCaptureTargetFn === 'function'
      ? options.getDocumentEditImageHandleCaptureTargetFn
      : null;
  const legacyDomIndexHooksAvailable =
    typeof options.scrollDocumentEditImageIntoViewFn === 'function' ||
    typeof options.waitForDocumentEditImageReadyFn === 'function' ||
    typeof options.inspectDocumentEditImageCaptureTargetFn === 'function' ||
    typeof options.getDocumentEditImageCaptureHandleFn === 'function';

  const matchedImage = pickDocumentEditImageCandidate(await collectEditCandidates(page), fallback);
  if (!matchedImage) {
    const failure = {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      recoveryMode,
      rejectionCode: 'edit-image-slot-missing',
    };
    return {
      ...failure,
      rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
    };
  }

  let activeBinding = null;
  let rematchUsed = false;

  const createBinding = async (candidate) => {
    if (!candidate) {
      return null;
    }
    let imageHandle = null;
    if (typeof getEditImageHandle === 'function') {
      imageHandle = await getEditImageHandle(page, candidate, fallback, options);
    } else if (typeof page?.evaluateHandle === 'function') {
      imageHandle = await getDocumentEditImageHandle(page, candidate.domIndex);
    }
    if (!imageHandle && !legacyDomIndexHooksAvailable) {
      return null;
    }
    return {
      matchedImage: candidate,
      imageHandle,
      usesLegacyDomIndex: !imageHandle,
    };
  };

  const rematchBinding = async () => {
    if (rematchUsed) {
      return null;
    }
    rematchUsed = true;
    await disposeHandleSafely(activeBinding?.imageHandle);
    activeBinding = null;
    const rematchedImage = pickDocumentEditImageCandidate(await collectEditCandidates(page), fallback);
    if (!rematchedImage) {
      return null;
    }
    activeBinding = await createBinding(rematchedImage);
    return activeBinding;
  };

  const ensureBinding = async () => {
    if (activeBinding?.usesLegacyDomIndex && activeBinding?.matchedImage) {
      return activeBinding;
    }
    if (
      activeBinding?.imageHandle &&
      (await isEditImageHandleStillUsable(activeBinding.imageHandle, activeBinding.matchedImage, page, fallback, options))
    ) {
      return activeBinding;
    }
    return await rematchBinding();
  };

  const scrollBoundImageIntoView = async (binding) => {
    if (scrollEditImageHandleIntoViewFn) {
      await scrollEditImageHandleIntoViewFn(page, binding.imageHandle, binding.matchedImage, fallback, options);
      return;
    }
    if (typeof options.scrollDocumentEditImageIntoViewFn === 'function') {
      await options.scrollDocumentEditImageIntoViewFn(page, binding.matchedImage?.domIndex, options);
      return;
    }
    if (!binding?.imageHandle) {
      return;
    }
    await scrollDocumentEditImageHandleIntoView(binding.imageHandle);
  };

  const waitForBoundImageReady = async (binding) => {
    if (waitForEditImageHandleReadyFn) {
      return await waitForEditImageHandleReadyFn(page, binding.imageHandle, binding.matchedImage, {
        ...options,
        timeoutMs: options.editImageReadyTimeoutMs,
      });
    }
    if (typeof options.waitForDocumentEditImageReadyFn === 'function') {
      return await options.waitForDocumentEditImageReadyFn(page, binding.matchedImage?.domIndex, {
        ...options,
        timeoutMs: options.editImageReadyTimeoutMs,
      });
    }
    if (!binding?.imageHandle) {
      return false;
    }
    return await waitForDocumentEditImageHandleReady(page, binding.imageHandle, {
      ...options,
      timeoutMs: options.editImageReadyTimeoutMs,
    });
  };

  const inspectBoundImage = async (binding) => {
    if (!binding?.matchedImage) {
      return { exists: false };
    }
    if (!binding?.imageHandle) {
      return {
        exists: true,
        currentSrc: String(binding.matchedImage.currentSrc || ''),
        src: String(binding.matchedImage.src || ''),
        dataSrc: String(binding.matchedImage.dataSrc || ''),
        alt: String(binding.matchedImage.alt || ''),
        naturalWidth: Number(binding.matchedImage.naturalWidth) || 0,
        naturalHeight: Number(binding.matchedImage.naturalHeight) || 0,
        clientWidth: Number(binding.matchedImage.clientWidth) || 0,
        clientHeight: Number(binding.matchedImage.clientHeight) || 0,
        complete: Boolean(binding.matchedImage.complete),
        visible: Boolean(binding.matchedImage.visible),
      };
    }
    return await inspectEditImageHandle(page, binding.imageHandle, binding.matchedImage, options);
  };

  const inspectBoundCaptureTarget = async (binding) => {
    if (inspectEditHandleCaptureTarget) {
      return await inspectEditHandleCaptureTarget(page, binding.imageHandle, binding.matchedImage, options);
    }
    if (typeof options.inspectDocumentEditImageCaptureTargetFn === 'function') {
      return await options.inspectDocumentEditImageCaptureTargetFn(page, binding.matchedImage?.domIndex);
    }
    if (!binding?.imageHandle) {
      return classifyRenderedImageCaptureInspection({
        exists: false,
        rejectionCode: 'image-slot-missing',
      });
    }
    return await inspectDocumentEditImageHandleCaptureTarget(binding.imageHandle);
  };

  const getBoundCaptureTargetHandle = async (binding, inspection = null) => {
    let rawHandle = null;
    if (getEditHandleCaptureTarget) {
      rawHandle = await getEditHandleCaptureTarget(page, binding.imageHandle, binding.matchedImage, options);
    } else if (typeof options.getDocumentEditImageCaptureHandleFn === 'function') {
      rawHandle = await options.getDocumentEditImageCaptureHandleFn(page, binding.matchedImage?.domIndex);
    } else {
      if (!binding?.imageHandle) {
        return null;
      }
      rawHandle = await getDocumentEditImageHandleCaptureTarget(binding.imageHandle, inspection?.selectedCandidateKey);
    }

    const elementHandle = typeof rawHandle?.asElement === 'function' ? rawHandle.asElement() : rawHandle;
    if (!elementHandle) {
      await disposeHandleSafely(rawHandle);
      return null;
    }
    return elementHandle;
  };

  const bindingHasTarget = (binding) => Boolean(binding?.imageHandle || binding?.usesLegacyDomIndex);
  const buildEffectiveImageSnapshot = (binding, snapshot) =>
    buildDocumentEditImageEffectiveIdentitySnapshot(snapshot, binding?.matchedImage);
  const evaluateImageIdentity = (binding, snapshot) =>
    evaluateDocumentEditImageStrongIdentity(buildEffectiveImageSnapshot(binding, snapshot), fallback);
  const normalizeEditCaptureInspection = (snapshot) => ({
    ...classifyDocumentEditImageCaptureInspection(snapshot),
    selectedCandidateKey: Number.isFinite(Number(snapshot?.selectedCandidateKey)) ? Number(snapshot.selectedCandidateKey) : -1,
    captureTargetRole: String(snapshot?.captureTargetRole || '').trim(),
    captureTargetArea: Number(snapshot?.captureTargetArea) || 0,
    captureTargetAreaRatio: Number(snapshot?.captureTargetAreaRatio) || 0,
    renderableImageCount: Number(snapshot?.renderableImageCount) || 0,
    totalImageCount: Number(snapshot?.totalImageCount) || 0,
    captureTargetContainsBoundImage: Boolean(snapshot?.captureTargetContainsBoundImage),
  });

  activeBinding = await createBinding(matchedImage);
  if (!activeBinding) {
    const failure = {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      recoveryMode,
      rejectionCode: 'edit-image-slot-missing',
    };
    return {
      ...failure,
      rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
    };
  }

  try {
    await scrollBoundImageIntoView(activeBinding);
    await page.waitForTimeout(options.bringToFront ? 1400 : 1000);
    await waitForBoundImageReady(activeBinding);

    activeBinding = (await ensureBinding()) || activeBinding;
    if (!bindingHasTarget(activeBinding)) {
      const failure = {
        ...normalizeRenderedImageRecoveryOutcome(fallback),
        recoveryMode,
        rejectionCode: 'edit-image-slot-missing',
      };
      return {
        ...failure,
        rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
      };
    }

    let imageSnapshot = await inspectBoundImage(activeBinding);
    if (!imageSnapshot?.exists) {
      activeBinding = await rematchBinding();
      if (!bindingHasTarget(activeBinding)) {
        const failure = {
          ...normalizeRenderedImageRecoveryOutcome(fallback),
          recoveryMode,
          rejectionCode: 'edit-image-slot-missing',
        };
        return {
          ...failure,
          rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
        };
      }
      imageSnapshot = await inspectBoundImage(activeBinding);
    }

    const initialIdentity = evaluateImageIdentity(activeBinding, imageSnapshot);
    if (initialIdentity.hasComparableIdentity && !initialIdentity.matches) {
      return buildDocumentEditImageIdentityMismatchFailure(
        fallback,
        buildEffectiveImageSnapshot(activeBinding, imageSnapshot),
        recoveryMode,
      );
    }

    let inspection = normalizeEditCaptureInspection(await inspectBoundCaptureTarget(activeBinding));
    if (inspection.rejectionCode === 'edit-image-slot-missing' && !rematchUsed) {
      activeBinding = await rematchBinding();
      if (bindingHasTarget(activeBinding)) {
        const rematchedSnapshot = await inspectBoundImage(activeBinding);
        const rematchedIdentity = evaluateImageIdentity(activeBinding, rematchedSnapshot);
        if (rematchedIdentity.hasComparableIdentity && !rematchedIdentity.matches) {
          return buildDocumentEditImageIdentityMismatchFailure(
            fallback,
            buildEffectiveImageSnapshot(activeBinding, rematchedSnapshot),
            recoveryMode,
          );
        }
        inspection = normalizeEditCaptureInspection(await inspectBoundCaptureTarget(activeBinding));
      }
    }

    if (inspection.rejectionCode) {
      return {
        ...inspection,
        recoveryMode,
        rejectionReason: buildRenderedImageRecoveryFailureDescription({
          ...inspection,
          recoveryMode,
        }),
      };
    }

    let elementHandle = await getBoundCaptureTargetHandle(activeBinding, inspection);
    if (!elementHandle && !rematchUsed) {
      activeBinding = await rematchBinding();
      if (bindingHasTarget(activeBinding)) {
        const rematchedSnapshot = await inspectBoundImage(activeBinding);
        const rematchedIdentity = evaluateImageIdentity(activeBinding, rematchedSnapshot);
        if (rematchedIdentity.hasComparableIdentity && !rematchedIdentity.matches) {
          return buildDocumentEditImageIdentityMismatchFailure(
            fallback,
            buildEffectiveImageSnapshot(activeBinding, rematchedSnapshot),
            recoveryMode,
          );
        }
        inspection = normalizeEditCaptureInspection(await inspectBoundCaptureTarget(activeBinding));
        if (inspection.rejectionCode) {
          return {
            ...inspection,
            recoveryMode,
            rejectionReason: buildRenderedImageRecoveryFailureDescription({
              ...inspection,
              recoveryMode,
            }),
          };
        }
        elementHandle = await getBoundCaptureTargetHandle(activeBinding, inspection);
      }
    }
    if (!elementHandle) {
      const failure = {
        ...inspection,
        recoveryMode,
        rejectionCode: 'edit-capture-target-missing',
      };
      return {
        ...failure,
        rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
      };
    }

    let finalImageSnapshot = imageSnapshot;
    try {
      await elementHandle.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await page.waitForTimeout(options.bringToFront ? 1400 : 1000);

      finalImageSnapshot = await inspectBoundImage(activeBinding);
      const finalIdentity = evaluateImageIdentity(activeBinding, finalImageSnapshot);
      if (finalIdentity.hasComparableIdentity && !finalIdentity.matches) {
        return buildDocumentEditImageIdentityMismatchFailure(
          fallback,
          buildEffectiveImageSnapshot(activeBinding, finalImageSnapshot),
          recoveryMode,
        );
      }
      const finalInspection = normalizeEditCaptureInspection(await inspectBoundCaptureTarget(activeBinding));
      if (finalInspection.rejectionCode) {
        return {
          ...finalInspection,
          recoveryMode,
          rejectionReason: buildRenderedImageRecoveryFailureDescription({
            ...finalInspection,
            recoveryMode,
          }),
        };
      }
      inspection = finalInspection;
    } catch {
      // Ignore scroll timing failures and still attempt the screenshot.
    }

    try {
      const screenshotPath = await captureEditElementScreenshot(page, elementHandle, targetPath);
      if (screenshotPath && fs.existsSync(screenshotPath)) {
        const captureBytes = Number(fs.statSync(screenshotPath).size) || 0;
        if (
          isRenderedImageBlankCapture(inspection, {
            width: inspection.clientWidth,
            height: inspection.clientHeight,
            captureBytes,
          })
        ) {
          removeIfExists(screenshotPath);
          const failure = {
            ...inspection,
            recoveryMode,
            captureBytes,
            rejectionCode: 'edit-blank-capture',
          };
          return {
            ...failure,
            rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
          };
        }

        const registration = registerDocumentImageAssetSuccess(
          docPlan,
          {
            rawUrl: fallback?.rawUrl || fallback?.originalUrl || fallback?.downloadUrl,
            originalUrl: fallback?.originalUrl,
            downloadUrl: fallback?.downloadUrl,
            basenameCandidates: fallback?.basenameCandidates,
            imageOccurrence: fallback?.imageOccurrence,
            assetAlt: fallback?.assetAlt,
          },
          {
            targetPath: screenshotPath,
            recoveryMode,
            detectDuplicateHash: true,
            naturalWidth: inspection.naturalWidth,
            naturalHeight: inspection.naturalHeight,
            clientWidth: inspection.clientWidth,
            clientHeight: inspection.clientHeight,
            complete: inspection.complete,
            captureBytes,
            currentSrc: String(finalImageSnapshot?.currentSrc || imageSnapshot?.currentSrc || '').trim(),
            actualAlt: String(finalImageSnapshot?.alt || imageSnapshot?.alt || '').trim(),
          },
        );
        if (registration.rejectionCode) {
          return {
            ...normalizeRenderedImageRecoveryOutcome(fallback),
            ...registration,
            recoveryMode,
          };
        }

        return {
          ...inspection,
          recoveryMode,
          path: screenshotPath,
          captureBytes,
          contentHash: registration.contentHash,
          currentSrc: String(finalImageSnapshot?.currentSrc || imageSnapshot?.currentSrc || '').trim(),
          actualAlt: String(finalImageSnapshot?.alt || imageSnapshot?.alt || '').trim(),
          rejectionCode: '',
          rejectionReason: '',
        };
      }

      const failure = {
        ...inspection,
        recoveryMode,
        rejectionCode: 'edit-screenshot-failed',
      };
      return {
        ...failure,
        rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
      };
    } finally {
      await disposeHandleSafely(elementHandle);
    }
  } finally {
    await disposeHandleSafely(activeBinding?.imageHandle);
  }

  const failure = {
    ...normalizeRenderedImageRecoveryOutcome(fallback),
    recoveryMode,
    rejectionCode: 'edit-screenshot-failed',
  };
  return {
    ...failure,
    rejectionReason: buildRenderedImageRecoveryFailureDescription(failure),
  };
}

async function captureRenderedImageFallbackOnPage(page, docPlan, fallback, targetPath, options = {}) {
  if (!options.skipDocumentOpen) {
    try {
      await page.goto(docPlan.absoluteDocUrl, {
        timeout: 120000,
        waitUntil: 'networkidle2',
      });
    } catch {
      return {
        ...normalizeRenderedImageRecoveryOutcome(fallback),
        recoveryMode: String(options.recoveryMode || '').trim(),
        rejectionCode: 'document-open-failed',
        rejectionReason: 'the recovery browser could not open the Yuque document',
      };
    }
  }

  if (options.bringToFront) {
    try {
      await page.bringToFront();
    } catch {
      // Ignore focus failures in browser environments that do not support bringToFront.
    }
  }

  const renderIndex = resolveRenderedImageRecoveryIndex(fallback);
  try {
    await page.evaluate((targetIndex) => {
      const root =
        document.querySelector('article') ||
        document.querySelector('.ne-viewer-body') ||
        document.querySelector('.lake-content') ||
        document.body;
      const img = Array.from(root?.querySelectorAll?.('img') || [])[targetIndex];
      img?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    }, renderIndex);
  } catch {
    return {
      ...normalizeRenderedImageRecoveryOutcome(fallback),
      recoveryMode: String(options.recoveryMode || '').trim(),
      rejectionCode: 'image-slot-missing',
      rejectionReason: 'the recovery browser could not locate the original image slot',
    };
  }

  await page.waitForTimeout(options.bringToFront ? 2200 : 1500);

  try {
    await page.waitForFunction(
      (targetIndex) => {
        const root =
          document.querySelector('article') ||
          document.querySelector('.ne-viewer-body') ||
          document.querySelector('.lake-content') ||
          document.body;
        const img = Array.from(root?.querySelectorAll?.('img') || [])[targetIndex];
        if (!img) {
          return false;
        }
        const rect = img.getBoundingClientRect();
        return Boolean(
          (img.naturalWidth > 0 && img.naturalHeight > 0) ||
            (rect.width > 8 && rect.height > 8) ||
            (img.clientWidth > 8 && img.clientHeight > 8),
        );
      },
      { timeout: 20000 },
      renderIndex,
    );
  } catch {
    // Keep going and inspect the final DOM state; some failures still leave a visible placeholder or card container.
  }

  const inspection = await inspectRenderedImageCaptureTarget(page, renderIndex);
  if (inspection.rejectionCode) {
    return {
      ...inspection,
      recoveryMode: String(options.recoveryMode || '').trim(),
      rejectionReason: buildRenderedImageRecoveryFailureDescription(inspection),
    };
  }

  const handleRef = await page.evaluateHandle((targetIndex) => {
    const root =
      document.querySelector('article') ||
      document.querySelector('.ne-viewer-body') ||
      document.querySelector('.lake-content') ||
      document.body;
    const img = Array.from(root?.querySelectorAll?.('img') || [])[targetIndex] || null;
    if (!img) {
      return null;
    }

    const seen = new Set();
    const candidates = [];
    const addCandidate = (node) => {
      if (!node || seen.has(node)) {
        return;
      }
      seen.add(node);
      candidates.push(node);
    };

    addCandidate(img.closest('[data-testid="ne-card-image"]'));
    addCandidate(img.closest('.ne-image-wrap'));
    addCandidate(img.closest('.ne-image-box'));
    addCandidate(img.closest('.ne-card-container'));
    addCandidate(img.closest('figure'));
    addCandidate(img.closest('a'));
    addCandidate(img.closest('li'));
    addCandidate(img.closest('p'));

    let current = img;
    let depth = 0;
    while (current && depth < 6) {
      addCandidate(current);
      current = current.parentElement;
      depth += 1;
    }

    return (
      candidates.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      }) || img
    );
  }, renderIndex);

  const elementHandle = typeof handleRef?.asElement === 'function' ? handleRef.asElement() : null;
  if (!elementHandle) {
    await disposeHandleSafely(handleRef);
    return {
      ...inspection,
      recoveryMode: String(options.recoveryMode || '').trim(),
      rejectionCode: 'capture-target-missing',
      rejectionReason: buildRenderedImageRecoveryFailureDescription({
        ...inspection,
        rejectionCode: 'capture-target-missing',
      }),
    };
  }

  try {
    try {
      await elementHandle.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await page.waitForTimeout(options.bringToFront ? 1400 : 1000);
    } catch {
      // Ignore scroll timing failures and still attempt the screenshot.
    }

    const screenshotPath = await captureElementScreenshot(page, elementHandle, targetPath);
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const captureBytes = Number(fs.statSync(screenshotPath).size) || 0;
      if (
        isRenderedImageBlankCapture(inspection, {
          width: inspection.clientWidth,
          height: inspection.clientHeight,
          captureBytes,
        })
      ) {
        removeIfExists(screenshotPath);
        return {
          ...inspection,
          recoveryMode: String(options.recoveryMode || '').trim(),
          captureBytes,
          rejectionCode: 'blank-capture',
          rejectionReason: buildRenderedImageRecoveryFailureDescription({
            ...inspection,
            captureBytes,
            rejectionCode: 'blank-capture',
          }),
        };
      }

      return {
        ...inspection,
        recoveryMode: String(options.recoveryMode || '').trim(),
        path: screenshotPath,
        captureBytes,
        rejectionCode: '',
        rejectionReason: '',
      };
    }
  } finally {
    await disposeHandleSafely(handleRef);
  }

  return {
    ...inspection,
    recoveryMode: String(options.recoveryMode || '').trim(),
    rejectionCode: 'screenshot-failed',
    rejectionReason: buildRenderedImageRecoveryFailureDescription({
      ...inspection,
      rejectionCode: 'screenshot-failed',
    }),
  };
}

async function inspectRenderedImageCaptureTarget(page, renderIndex) {
  try {
    const snapshot = await page.evaluate((targetIndex) => {
      const root =
        document.querySelector('article') ||
        document.querySelector('.ne-viewer-body') ||
        document.querySelector('.lake-content') ||
        document.body;
      const img = Array.from(root?.querySelectorAll?.('img') || [])[targetIndex] || null;
      if (!img) {
        return {
          exists: false,
          rejectionCode: 'image-slot-missing',
          visibleText: '',
          naturalWidth: 0,
          naturalHeight: 0,
            clientWidth: 0,
            clientHeight: 0,
            captureBytes: 0,
            complete: false,
            hasLoadedImage: false,
            hasRenderableVisualNode: false,
            hasMeaningfulText: false,
            hasBackgroundImage: false,
            placeholderTextDetected: false,
            placeholderAttributeDetected: false,
          };
        }

        const seen = new Set();
        const candidates = [];
      const addCandidate = (node) => {
        if (!node || seen.has(node)) {
          return;
        }
        seen.add(node);
        candidates.push(node);
      };

      addCandidate(img.closest('[data-testid="ne-card-image"]'));
      addCandidate(img.closest('.ne-image-wrap'));
      addCandidate(img.closest('.ne-image-box'));
      addCandidate(img.closest('.ne-card-container'));
      addCandidate(img.closest('figure'));
      addCandidate(img.closest('a'));
      addCandidate(img.closest('li'));
      addCandidate(img.closest('p'));

      let current = img;
      let depth = 0;
      while (current && depth < 6) {
        addCandidate(current);
        current = current.parentElement;
        depth += 1;
      }

        const candidate =
          candidates.find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8;
          }) || img;
        const rect = candidate.getBoundingClientRect();
        const isVisibleNode = (node) => {
          if (!node) {
            return false;
          }
          const nodeRect = node.getBoundingClientRect();
          if (!(nodeRect.width > 1 && nodeRect.height > 1)) {
            return false;
          }
          const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
          if (!style) {
            return true;
          }
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0.01
          );
        };
        const collectCandidateNodes = (selector) => {
          const matches = [];
          if (typeof candidate.matches === 'function' && candidate.matches(selector)) {
            matches.push(candidate);
          }
          matches.push(...Array.from(candidate.querySelectorAll?.(selector) || []));
          return matches;
        };
        const candidateImages = [
          ...(candidate.tagName === 'IMG' ? [candidate] : []),
          ...Array.from(candidate.querySelectorAll?.('img') || []),
        ];
        const visibleText = String(candidate.innerText || candidate.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        const hasLoadedImage = candidateImages.some(
          (node) => Number(node?.naturalWidth || 0) > 8 && Number(node?.naturalHeight || 0) > 8,
        );
        const hasRenderableVisualNode = collectCandidateNodes('canvas, svg, video, picture').some((node) =>
          isVisibleNode(node),
        );
        const hasBackgroundImage = [candidate, ...Array.from(candidate.querySelectorAll?.('*') || []).slice(0, 24)].some(
          (node) => {
            if (!isVisibleNode(node)) {
              return false;
            }
            const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
            const backgroundImage = String(style?.backgroundImage || '').trim();
            return Boolean(backgroundImage) && backgroundImage !== 'none';
          },
        );
        const placeholderTextDetected = /该图片可能违规或链接失效|图片可能违规|链接失效|image unavailable|image is unavailable/i.test(
          visibleText,
        );
        const placeholderAttributeDetected = candidateImages.some((node) =>
          /forbid|forbidden|reject|banned|placeholder|unavailable/i.test(
            `${node?.currentSrc || ''} ${node?.getAttribute?.('src') || ''} ${node?.getAttribute?.('alt') || ''}`.toLowerCase(),
          ),
        );

        return {
          exists: true,
          rejectionCode: '',
          visibleText,
          naturalWidth: Number(img.naturalWidth || 0),
          naturalHeight: Number(img.naturalHeight || 0),
          clientWidth: Number(img.clientWidth || rect.width || 0),
          clientHeight: Number(img.clientHeight || rect.height || 0),
          captureBytes: 0,
          complete: Boolean(img.complete),
          hasLoadedImage,
          hasRenderableVisualNode,
          hasMeaningfulText: Boolean(visibleText),
          hasBackgroundImage,
          placeholderTextDetected,
          placeholderAttributeDetected,
        };
      }, renderIndex);
    return classifyRenderedImageCaptureInspection(snapshot);
  } catch {
    return classifyRenderedImageCaptureInspection({
      exists: false,
      rejectionCode: 'capture-exception',
      visibleText: '',
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
      captureBytes: 0,
      complete: false,
      hasLoadedImage: false,
      hasRenderableVisualNode: false,
      hasMeaningfulText: false,
      hasBackgroundImage: false,
      placeholderTextDetected: false,
      placeholderAttributeDetected: false,
    });
  }
}

function buildRenderedImageRecoveryFailureDescription(outcome = {}) {
  const normalized = classifyRenderedImageCaptureInspection(outcome);
  const metrics = `natural size: ${normalized.naturalWidth}x${normalized.naturalHeight}, client size: ${normalized.clientWidth}x${normalized.clientHeight}, complete: ${normalized.complete}`;
  const captureBytes = normalized.captureBytes ? `, screenshot bytes: ${normalized.captureBytes}` : '';
  const visibleText = normalized.visibleText ? `, visible text: "${normalized.visibleText}"` : '';
  const editModeMetrics = `visible document editors: ${Math.max(
    0,
    Number(outcome?.visibleDocumentEditorCount) || 0,
  )}, visible toolbars: ${Math.max(
    0,
    Number(outcome?.visibleToolbarCount) || 0,
  )}, visible minor editors: ${Math.max(
    0,
    Number(outcome?.visibleMinorEditorCount) || 0,
  )}, max editor area: ${Math.max(0, Number(outcome?.maxDocumentEditorArea) || 0)}`;

  switch (String(normalized.rejectionCode || '').trim().toLowerCase()) {
    case 'edit-duplicate-image-suspected': {
      const contentHash = String(outcome?.contentHash || '').trim();
      const actualCurrentSrc = String(outcome?.currentSrc || '').trim();
      const actualAlt = formatRenderedImageVisibleText(outcome?.actualAlt || outcome?.visibleText || '');
      const duplicateTargetPath = String(outcome?.duplicateTargetPath || '').trim();
      const hash = contentHash ? `, content hash: "${contentHash}"` : '';
      const currentSrc = actualCurrentSrc ? `, actual current src: "${actualCurrentSrc}"` : '';
      const alt = actualAlt ? `, actual alt: "${actualAlt}"` : '';
      const duplicateTarget = duplicateTargetPath ? `, duplicate target path: "${duplicateTargetPath}"` : '';
      return `the edit-mode recovery screenshot matched a previously exported image with different identity and was rejected to avoid silently saving the wrong first image (${metrics}${captureBytes}${hash}${currentSrc}${alt}${duplicateTarget})`;
    }
    case 'edit-image-identity-mismatch': {
      const actualCurrentSrc = String(outcome?.currentSrc || '').trim();
      const actualAlt = formatRenderedImageVisibleText(outcome?.actualAlt || outcome?.visibleText || '');
      const currentSrc = actualCurrentSrc ? `, actual current src: "${actualCurrentSrc}"` : '';
      const alt = actualAlt ? `, actual alt: "${actualAlt}"` : '';
      return `the edit-mode recovery matched a different image than the requested slot and was rejected to avoid saving the wrong export image (${metrics}${currentSrc}${alt})`;
    }
    case 'edit-entry-missing':
      return 'the recovery browser could not find a visible document edit entry button';
    case 'edit-mode-not-entered':
      return `clicking the document edit entry did not enter document edit mode (${editModeMetrics})`;
    case 'edit-image-slot-missing':
      return 'the edit-mode recovery could not locate the original image slot';
    case 'edit-capture-target-ambiguous':
      return `the edit-mode recovery found only oversized or shared capture containers for the image slot and rejected them to avoid saving the wrong screenshot region (${metrics}${visibleText})`;
    case 'edit-capture-target-missing':
      return `the edit-mode recovery could not locate a visible capture container for the image slot (${metrics}${visibleText})`;
    case 'edit-placeholder-only':
      return `the edit-mode recovery only showed a rejected-image placeholder instead of the real image (${metrics}${visibleText})`;
    case 'edit-blank-container':
      return `the edit-mode recovery only found a blank capture container for the image slot (${metrics}${visibleText})`;
    case 'edit-blank-capture':
      return `the edit-mode recovery screenshot was nearly blank and was rejected as a blank capture (${metrics}${captureBytes}${visibleText})`;
    case 'edit-screenshot-failed':
      return `the edit-mode recovery found the image slot but could not save a screenshot (${metrics}${visibleText})`;
    case 'blank-container':
      return `the recovery browser only found a blank capture container for the image slot (${metrics}${visibleText})`;
    case 'blank-capture':
      return `the recovery browser screenshot was nearly blank and was rejected as a blank capture (${metrics}${captureBytes}${visibleText})`;
    case 'placeholder-only':
      return `the recovery browser only showed a rejected-image placeholder instead of the real image (${metrics}${visibleText})`;
    case 'not-rendered':
      return `the image never finished loading in the recovery browser (${metrics}${visibleText})`;
    case 'capture-target-missing':
      return `the recovery browser could not locate a visible capture container for the image slot (${metrics})`;
    case 'screenshot-failed':
      return `the recovery browser found the image slot but could not save a screenshot (${metrics})`;
    case 'image-slot-missing':
      return 'the recovery browser could not locate the original image slot';
    case 'document-open-failed':
      return 'the recovery browser could not open the Yuque document';
    case 'browser-launch-failed':
      return 'the visible recovery browser could not be launched';
    case 'capture-exception':
      return 'the recovery browser failed while opening or capturing the Yuque image slot';
    default:
      if (String(normalized.rejectionCode || '').trim().toLowerCase().startsWith('edit-')) {
        return `the edit-mode recovery failed while capturing the image slot (${metrics}${visibleText})`;
      }
      return `the image never finished loading in the recovery browser (${metrics}${visibleText})`;
  }
}

function formatRenderedImageVisibleText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function resolveRenderedImageRecoveryIndex(item = {}) {
  const directIndex = Number(item?.renderIndex);
  if (Number.isFinite(directIndex) && directIndex >= 0) {
    return directIndex;
  }

  const catalogIndex = Number(item?.index);
  if (Number.isFinite(catalogIndex) && catalogIndex >= 0) {
    return catalogIndex;
  }

  return -1;
}

function normalizeRenderedImageCatalog(items = []) {
  return items
    .map((item, index) => {
      const downloadUrl = toAbsoluteYuqueUrl(item?.currentSrc || item?.src || item?.dataSrc || '');
      const originalUrl =
        extractOriginalAssetUrlFromYuqueProxy(downloadUrl) ||
        toAbsoluteYuqueUrl(item?.src || item?.dataSrc || '') ||
        '';
      const basenameCandidates = dedupeTexts([
        extractAssetBasename(downloadUrl).toLowerCase(),
        extractAssetBasename(originalUrl).toLowerCase(),
      ]).filter(Boolean);

      return {
        index: Number(item?.index ?? index) || index,
        renderIndex: Number(item?.index ?? index) || index,
        downloadUrl,
        originalUrl,
        alt: String(item?.alt || ''),
        naturalWidth: Number(item?.naturalWidth) || 0,
        naturalHeight: Number(item?.naturalHeight) || 0,
        clientWidth: Number(item?.clientWidth) || 0,
        clientHeight: Number(item?.clientHeight) || 0,
        complete: Boolean(item?.complete),
        isLoaded: isRenderedImageFallbackUsable(item),
        basenameCandidates,
      };
    })
    .filter((item) => item.downloadUrl);
}

export function isRenderedImageFallbackUsable(item = {}) {
  return Number(item?.naturalWidth) > 0 && Number(item?.naturalHeight) > 0;
}

export function shouldAttemptRenderedImageScreenshotFallback(item = {}) {
  return resolveRenderedImageRecoveryIndex(item) >= 0;
}

function toAbsoluteYuqueUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith('/')) {
    return `https://www.yuque.com${value}`;
  }
  return value;
}

function findRenderedImageForAssetReference(renderedImages, rawUrl, options = {}) {
  const exactMatch = findRenderedImageByUrl(renderedImages, rawUrl);
  if (exactMatch) {
    return exactMatch;
  }
  const basenameMatch = findRenderedImageByBasename(renderedImages, rawUrl);
  if (basenameMatch) {
    return basenameMatch;
  }
  return findRenderedImageByOccurrence(renderedImages, options.imageOccurrence, options.assetAlt);
}

function findRenderedImageByUrl(renderedImages, rawUrl) {
  const normalized = normalizeAssetMatchUrl(rawUrl);
  if (!normalized) {
    return null;
  }

  return (
    renderedImages.find((item) => normalizeAssetMatchUrl(item.originalUrl) === normalized) ||
    renderedImages.find((item) => normalizeAssetMatchUrl(item.downloadUrl) === normalized) ||
    null
  );
}

function findRenderedImageByBasename(renderedImages, rawUrl) {
  const basename = extractAssetBasename(rawUrl).toLowerCase();
  if (!basename) {
    return null;
  }

  return renderedImages.find((item) => item.basenameCandidates.includes(basename)) || null;
}

function findRenderedImageByOccurrence(renderedImages, imageOccurrence, assetAlt = '') {
  const occurrence = normalizeImageOccurrence(imageOccurrence);
  if (occurrence < 0 || !Array.isArray(renderedImages) || renderedImages.length === 0) {
    return null;
  }

  const normalizedAlt = String(assetAlt || '').trim().toLowerCase();
  const visibleImages = renderedImages.filter((item) => isRenderableImageCandidate(item));
  if (visibleImages.length === 0) {
    return null;
  }

  const orderedMatch = visibleImages[occurrence] || null;
  if (orderedMatch) {
    return orderedMatch;
  }

  if (!normalizedAlt) {
    return null;
  }

  return (
    visibleImages.find((item) => String(item.alt || '').trim().toLowerCase() === normalizedAlt) ||
    visibleImages.find((item) => String(item.alt || '').trim().toLowerCase().includes(normalizedAlt)) ||
    null
  );
}

function isRenderableImageCandidate(item = {}) {
  return Boolean(String(item?.downloadUrl || '').trim()) && !isLikelyPlaceholderImageCandidate(item);
}

function isLikelyPlaceholderImageCandidate(item = {}) {
  const source = `${String(item?.downloadUrl || '')} ${String(item?.originalUrl || '')} ${String(item?.alt || '')}`.toLowerCase();
  return /avatar|emoji|icon|favicon|logo|blank\.gif|spacer|loading|lazyload/.test(source);
}

function normalizeAssetMatchUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return '';
  }

  try {
    const parsed = new URL(value, 'https://www.yuque.com');
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value.split('#')[0].trim();
  }
}

function createBrowserSessionManager(options = {}) {
  const getBrowser = typeof options.getBrowser === 'function' ? options.getBrowser : () => null;
  const setBrowser = typeof options.setBrowser === 'function' ? options.setBrowser : () => {};
  const launchOptions = options.launchOptions || {};
  let launchPromise = null;

  return {
    async ensureBrowser() {
      const current = getBrowser();
      if (isBrowserConnectionUsable(current)) {
        return current;
      }

      if (launchPromise) {
        return await launchPromise;
      }

      launchPromise = (async () => {
        await closeBrowserSafely(current);
        const nextBrowser = await launchBrowser(launchOptions);
        if (typeof nextBrowser?.once === 'function') {
          nextBrowser.once('disconnected', () => {
            if (getBrowser() === nextBrowser) {
              setBrowser(null);
            }
          });
        }
        setBrowser(nextBrowser);
        return nextBrowser;
      })();

      try {
        return await launchPromise;
      } finally {
        launchPromise = null;
      }
    },
    async resetBrowser() {
      const current = getBrowser();
      setBrowser(null);
      await closeBrowserSafely(current);
    },
    async dispose() {
      const current = getBrowser();
      setBrowser(null);
      await closeBrowserSafely(current);
    },
  };
}

function isBrowserConnectionUsable(browser) {
  if (!browser) {
    return false;
  }
  if (typeof browser.isConnected === 'function') {
    try {
      return browser.isConnected();
    } catch {
      return false;
    }
  }
  return true;
}

async function withAuthenticatedExportPage(browserSession, cookiePath, callback) {
  const browser = await browserSession.ensureBrowser();
  const page = await openAuthenticatedPage(browser, cookiePath);
  try {
    await configureExportPage(page);
    return await callback(page);
  } catch (error) {
    if (isBrowserDisconnectedError(error)) {
      await browserSession.resetBrowser();
    }
    throw error;
  } finally {
    await closePageSafely(page);
  }
}

function resolveCliEntryPath() {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

function serializeBookPlanForWorker(bookPlan) {
  return {
    book: cloneJsonValue(bookPlan?.book, {}) || {},
    bookDir: String(bookPlan?.bookDir || ''),
    assets: cloneJsonValue(bookPlan?.assets, {}) || {},
  };
}

function serializeDocPlanForWorker(docPlan) {
  return {
    book: cloneJsonValue(docPlan?.book, {}) || {},
    node: cloneJsonValue(docPlan?.node, {}) || {},
    targetMdPath: String(docPlan?.targetMdPath || ''),
    docSlug: String(docPlan?.docSlug || ''),
    docUrl: String(docPlan?.docUrl || ''),
    absoluteDocUrl: String(docPlan?.absoluteDocUrl || ''),
  };
}

function createWorkerBookPlan(bookPlan) {
  return {
    book: cloneJsonValue(bookPlan?.book, {}) || {},
    bookDir: String(bookPlan?.bookDir || ''),
    assets: cloneJsonValue(bookPlan?.assets, {}) || {},
    documents: [],
    assetCache: new Map(),
    assetNames: new Map(),
  };
}

export function buildComplexArtifactWorkerTask({
  bookPlan,
  docPlan,
  requestedTasks,
  preparedBoards = [],
  contentOutputDir = '',
  fallbackReason = '',
  safeMode = false,
} = {}) {
  return {
    bookPlan: serializeBookPlanForWorker(bookPlan),
    docPlan: serializeDocPlanForWorker(docPlan),
    requestedTasks: cloneJsonValue(requestedTasks, {}) || {},
    precomputedBoards: cloneJsonValue(preparedBoards, []) || [],
    contentOutputDir: String(contentOutputDir || ''),
    fallbackReason: String(fallbackReason || ''),
    safeMode: Boolean(safeMode),
  };
}

export function applyComplexArtifactRetryStrategy(task = {}, attempt = 1) {
  const attemptNumber = Math.max(1, Number(attempt) || 1);
  const safeMode = attemptNumber > 1;
  const nextTask = cloneJsonValue(task, {}) || {};
  nextTask.requestedTasks = cloneJsonValue(task?.requestedTasks, {}) || {};
  if (safeMode) {
    nextTask.requestedTasks.captureBoardPngs = false;
  }
  nextTask.safeMode = safeMode;
  nextTask.retryAttempt = attemptNumber;
  return nextTask;
}

async function executeComplexArtifactWorkerProcess(config, task) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-artifact-worker-'));
  const taskFile = path.join(tempDir, 'task.json');
  const resultFile = path.join(tempDir, 'result.json');
  writeJson(taskFile, {
    ...task,
    resultFile,
  });

  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let parsedResult = null;
    let settled = false;

    const cleanup = () => {
      try {
        removeDirectoryIfExists(tempDir);
      } catch {
        // Ignore temp cleanup failures.
      }
    };

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      handler(value);
    };

    const child = spawn(process.execPath, [resolveCliEntryPath(), COMPLEX_ARTIFACT_WORKER_COMMAND], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        YUQUE_EXPORTER_CONFIG: JSON.stringify(config),
        YUQUE_COMPLEX_ARTIFACT_TASK_FILE: taskFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parseStdoutChunk = (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const payload = JSON.parse(trimmed);
          if (payload?.type === 'result') {
            parsedResult = payload;
          }
        } catch {
          // Ignore non-JSON worker noise.
        }
      }
    };

    child.stdout?.on('data', parseStdoutChunk);
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      let parsedFileResult = null;
      if (fs.existsSync(resultFile)) {
        try {
          parsedFileResult = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        } catch (error) {
          if (code === 0) {
            finish(reject, error);
            return;
          }
        }
      }

      const unwrappedResult = unwrapWorkerArtifactsPayload(parsedFileResult);
      if (code === 0 && unwrappedResult) {
        finish(resolve, unwrappedResult);
        return;
      }

      const error = new Error(
        parsedResult?.error ||
          stderr.trim() ||
          stdout.trim() ||
          `Complex artifact worker exited with code ${code}${signal ? ` and signal ${signal}` : ''}.`,
      );
      error.exitCode = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      error.isWorkerCrash = isNativeWorkerCrash(error);
      if (unwrappedResult) {
        error.partialArtifacts = unwrappedResult;
      }
      finish(reject, error);
    });
  });
}

export async function runComplexArtifactWorkerTask(config, task) {
  let browser = null;
  const writeCheckpoint = (artifacts, meta = {}) => {
    if (!task?.resultFile) {
      return;
    }
    writeJson(task.resultFile, buildWorkerCheckpointPayload(artifacts, meta));
  };
  const browserSession = createBrowserSessionManager({
    getBrowser: () => browser,
    setBrowser: (nextBrowser) => {
      browser = nextBrowser;
    },
    launchOptions: buildExportBrowserLaunchOptions(config, {
      headless: true,
    }),
  });

  try {
    return await withAuthenticatedExportPage(browserSession, config.cookiePath, (page) =>
      extractComplexArtifacts(page, task.docPlan, createWorkerBookPlan(task.bookPlan), {
        ...config,
        contentOutputDir: task.contentOutputDir,
        requestedTasks: task.requestedTasks,
        precomputedBoards: task.precomputedBoards,
        forceFallbackSnapshot: Boolean(task.requestedTasks?.forceFallbackSnapshot),
        fallbackReason: task.fallbackReason || '',
        safeMode: Boolean(task.safeMode),
        disableArtifactScreenshots: Boolean(task.safeMode),
        onArtifactsCheckpoint: writeCheckpoint,
      }),
    );
  } finally {
    await browserSession.dispose();
  }
}

function isBrowserDisconnectedError(error) {
  const message = errorToMessage(error).toLowerCase();
  return (
    message.includes('browser has disconnected') ||
    message.includes('target closed') ||
    message.includes('session closed') ||
    message.includes('connection closed') ||
    message.includes('most likely the page has been closed')
  );
}

async function configureExportPage(page) {
  try {
    await page.setViewport({
      width: SAFE_SCREENSHOT_VIEWPORT_WIDTH,
      height: SAFE_SCREENSHOT_VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    });
  } catch {
    // Ignore viewport failures and let Puppeteer use the browser default.
  }
}

async function closePageSafely(page) {
  if (!page) {
    return;
  }
  try {
    if (!page.isClosed?.()) {
      await page.close({ runBeforeUnload: false });
    }
  } catch {
    // Ignore teardown errors from crashed pages.
  }
}

function normalizeRequestedArtifactTasks(requestedTasks = {}, options = {}) {
  const captureGenericArtifacts = requestedTasks.captureGenericArtifacts !== false;
  return {
    captureGenericArtifacts,
    captureDatatables: requestedTasks.captureDatatables ?? captureGenericArtifacts,
    captureEncryptedTexts: requestedTasks.captureEncryptedTexts ?? captureGenericArtifacts,
    captureBoardPngs: Boolean(requestedTasks.captureBoardPngs) && !options.safeMode,
    forceFallbackSnapshot: Boolean(requestedTasks.forceFallbackSnapshot || options.forceFallbackSnapshot),
  };
}

async function capturePreparedBoardPngs(page, boards = []) {
  const capturedBoards = [];

  for (const board of cloneJsonValue(boards, []) || []) {
    if (!board?.pngRequested || !board?.files?.pngPath) {
      capturedBoards.push(board);
      continue;
    }

    try {
      const pngPath = await captureBoardPng(page, Number(board.index) || 0, board.files.pngPath);
      board.files.pngPath = pngPath;
      board.pngCaptured = Boolean(pngPath && fs.existsSync(pngPath));
      board.pngCaptureError = '';
    } catch (error) {
      board.pngCaptured = false;
      board.pngCaptureError = errorToMessage(error);
      board.pngStale = Boolean(board.files?.pngPath && fs.existsSync(board.files.pngPath));
    }

    // PNG 由浏览器工作线程异步生成，初始 manifest 创建时尚不存在该文件。
    // 截图完成（或复用旧快照）后立即补齐清单，避免用户排查产物时误以为快照缺失。
    refreshBoardManifestAfterPngCapture(board);

    capturedBoards.push(board);
  }

  return capturedBoards;
}

async function extractComplexArtifacts(page, docPlan, bookPlan, options = {}) {
  const requestedTasks = normalizeRequestedArtifactTasks(options.requestedTasks, options);
  let precomputedBoards = cloneJsonValue(options.precomputedBoards, []) || [];
  if (precomputedBoards.length === 0 && options.docDetail) {
    precomputedBoards = prepareStructuredBoards(options.docDetail, docPlan, bookPlan, options);
  }

  await page.goto(docPlan.absoluteDocUrl, {
    timeout: 120000,
    waitUntil: 'networkidle2',
  });

  const encryptedState = requestedTasks.captureEncryptedTexts
    ? await unlockEncryptedBlocks(
        page,
        options.encryptedBlockPasswords && options.encryptedBlockPasswords.length > 0
          ? options.encryptedBlockPasswords
          : options.encryptedBlockPassword || '',
      )
    : {
        attempted: false,
        detectedCount: 0,
        unlockedCount: 0,
        remainingLockedCount: 0,
        attemptedPasswordCount: 0,
        matchedPassword: '',
        unlockedBlocks: [],
      };

  if (!requestedTasks.captureGenericArtifacts) {
    const boards = requestedTasks.captureBoardPngs
      ? await capturePreparedBoardPngs(page, precomputedBoards)
      : precomputedBoards;
    const extractedEncryptedBlocks = requestedTasks.captureEncryptedTexts ? await extractEncryptedBlocks(page) : [];
    const encryptedBlocks = requestedTasks.captureEncryptedTexts
      ? normalizeEncryptedBlocks(
          extractedEncryptedBlocks.length > 0
            ? extractedEncryptedBlocks
            : encryptedState.unlockedBlocks?.length > 0
              ? encryptedState.unlockedBlocks
              : [],
        )
      : [];
    const lightArtifacts = {
      ...createInitialComplexArtifacts(boards, {
        needsWorker: true,
        requestedTasks,
      }),
      boards,
      encryptedBlocks,
      encryptedState,
      artifactKinds: dedupeTexts([
        ...buildArtifactKindsFromBoards(boards),
        ...(encryptedState.detectedCount > 0 || encryptedBlocks.length > 0 ? ['encrypted'] : []),
      ]),
      requiresFallback: false,
      fallbackReason: '',
    };
    options.onArtifactsCheckpoint?.(lightArtifacts, { stage: 'completed' });
    return lightArtifacts;
  }
  const pageData = await page.evaluate((selectorGroups, encryptedSelectors, datatableDomIdAttr, codeBlockSelectors) => {
    const root =
      document.querySelector('article') ||
      document.querySelector('.ne-viewer-body') ||
      document.querySelector('.lake-content') ||
      document.querySelector('.yuque-doc-content') ||
      document.body;

    const cleanText = (value) =>
      String(value ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const pickFirst = (values, fallback = '') => {
      for (const value of values) {
        const normalized = cleanText(value);
        if (normalized) {
          return normalized;
        }
      }
      return fallback;
    };

    const normalizeCodeText = (value) =>
      String(value ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/^\n+/g, '')
        .replace(/\n+$/g, '');

    const LANGUAGE_LABEL_RE =
      /^(?:plain\s*text|text|txt|bash|shell|sh|zsh|powershell|ps1|cmd|bat|javascript|js|typescript|ts|tsx|jsx|json|yaml|yml|xml|html|css|scss|less|sql|python|py|java|kotlin|kt|go|rust|rs|c|cpp|c\+\+|c#|cs|php|ruby|rb|swift|objective-c|objc|scala|lua|perl|r|matlab|dockerfile|makefile)$/i;
    const UI_ACTION_LABEL_RE = /^(?:复制(?:代码)?|copy(?:\s+code)?|换行|自动换行|wrap|下载|download|展开|收起|fold|unfold|全屏|fullscreen|运行|run)$/i;
    const IGNORE_TITLE_NODE_SELECTOR = 'pre, code, [role="textbox"], button, svg, img';

    const isLikelyCodeLanguageLabel = (value) => {
      const normalized = cleanText(value).replace(/\s+/g, ' ');
      return Boolean(normalized) && normalized.length <= 24 && LANGUAGE_LABEL_RE.test(normalized);
    };

    const isUiChromeLabel = (value) => UI_ACTION_LABEL_RE.test(cleanText(value).replace(/\s+/g, ' '));

    const isUsableCodeTitle = (value, codeText) => {
      const normalized = cleanText(value);
      if (!normalized) {
        return false;
      }
      if (normalized.length > 120) {
        return false;
      }
      if (normalizeCodeText(normalized) === normalizeCodeText(codeText)) {
        return false;
      }
      if (isLikelyCodeLanguageLabel(normalized) || isUiChromeLabel(normalized)) {
        return false;
      }
      return true;
    };

    const collectCandidateText = (node, codeText) => {
      if (!node) {
        return '';
      }
      if (node.matches?.(IGNORE_TITLE_NODE_SELECTOR) || node.querySelector?.(IGNORE_TITLE_NODE_SELECTOR)) {
        return '';
      }
      const text = cleanText(node.innerText || node.textContent || '');
      return isUsableCodeTitle(text, codeText) ? text : '';
    };

    const serializeInterestingAttributes = (node) => {
      const output = {};
      for (const name of node.getAttributeNames()) {
        if (/^(data-|aria-|role$|href$|src$|title$|id$|class$)/i.test(name)) {
          output[name] = node.getAttribute(name);
        }
      }
      return output;
    };

    const selectTopLevelContainers = (selectors) => {
      const matched = [];
      for (const selector of selectors) {
        for (const node of root.querySelectorAll(selector)) {
          matched.push(node);
        }
      }

      const unique = Array.from(new Set(matched));
      unique.sort((left, right) => {
        if (left === right) {
          return 0;
        }
        if (left.contains(right)) {
          return -1;
        }
        if (right.contains(left)) {
          return 1;
        }
        return 0;
      });

      const kept = [];
      for (const node of unique) {
        if (!kept.some((candidate) => candidate.contains(node))) {
          kept.push(node);
        }
      }
      return kept;
    };

    const createColumnDescriptor = (name, index) => {
      const normalizedName = cleanText(name) || `Column ${index + 1}`;
      return {
        key: `col_${index + 1}`,
        name: normalizedName,
        type: 'text',
        rawName: normalizedName,
        options: [],
      };
    };

    const normalizeCells = (cells, length) => {
      const output = [...cells];
      while (output.length < length) {
        output.push({
          text: '',
          html: '',
          kind: 'text',
          raw: {},
        });
      }
      return output.slice(0, length);
    };

    const buildStructuredRows = (rows, columns) =>
      rows
        .map((row, rowIndex) => {
          const normalizedCells = normalizeCells(row, columns.length);
          return {
            index: rowIndex,
            cells: normalizedCells.map((cell, cellIndex) => ({
              columnKey: columns[cellIndex]?.key ?? `col_${cellIndex + 1}`,
              columnName: columns[cellIndex]?.name ?? `Column ${cellIndex + 1}`,
              text: cleanText(cell?.text),
              html: String(cell?.html ?? ''),
              kind: cell?.kind || 'text',
              raw: cell?.raw ?? {},
            })),
          };
        })
        .filter((row) => row.cells.some((cell) => cell.text || cell.html));

    const extractHtmlTableVariant = (table) => {
      const rowElements = Array.from(table.querySelectorAll('tr'));
      if (rowElements.length === 0) {
        return null;
      }

      const rows = rowElements.map((row) =>
        Array.from(row.querySelectorAll('th,td')).map((cell) => ({
          text: cleanText(cell.innerText || cell.textContent || ''),
          html: cell.innerHTML || '',
          kind: 'html-table-cell',
          raw: {
            tagName: cell.tagName.toLowerCase(),
            colSpan: Number(cell.getAttribute('colspan') || 1),
            rowSpan: Number(cell.getAttribute('rowspan') || 1),
            attributes: serializeInterestingAttributes(cell),
          },
        })),
      );

      const headerRowElement = rowElements.find((row) => row.querySelector('th'));
      const headerIndex = headerRowElement ? rowElements.indexOf(headerRowElement) : -1;
      const headerCells = headerIndex >= 0 ? rows[headerIndex] : null;
      const bodyRows = rows.filter((_, index) => index !== headerIndex);
      const columnCount = Math.max(headerCells?.length || 0, ...bodyRows.map((row) => row.length), 0);
      if (columnCount === 0) {
        return null;
      }

      const columns = headerCells
        ? normalizeCells(headerCells, columnCount).map((cell, index) => createColumnDescriptor(cell.text, index))
        : Array.from({ length: columnCount }, (_, index) => createColumnDescriptor('', index));

      return {
        source: 'html-table',
        columns,
        rows: buildStructuredRows(bodyRows, columns),
      };
    };

    const extractAriaGridVariant = (container) => {
      const headerNodes = Array.from(container.querySelectorAll('[role="columnheader"]'));
      const rowNodes = Array.from(container.querySelectorAll('[role="row"]')).filter(
        (row) => !row.querySelector('[role="columnheader"]'),
      );
      if (headerNodes.length === 0 && rowNodes.length === 0) {
        return null;
      }

      const columns =
        headerNodes.length > 0
          ? headerNodes.map((node, index) => createColumnDescriptor(node.innerText || node.textContent || '', index))
          : Array.from(
              {
                length: Math.max(
                  ...rowNodes.map((row) => row.querySelectorAll('[role="gridcell"], [role="cell"], [role="rowheader"]').length),
                  0,
                ),
              },
              (_, index) => createColumnDescriptor('', index),
            );

      if (columns.length === 0) {
        return null;
      }

      const rows = rowNodes
        .map((row) =>
          Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"], [role="rowheader"]')).map((cell) => ({
            text: cleanText(cell.innerText || cell.textContent || ''),
            html: cell.innerHTML || '',
            kind: cell.getAttribute('role') || 'gridcell',
            raw: {
              role: cell.getAttribute('role') || '',
              attributes: serializeInterestingAttributes(cell),
            },
          })),
        )
        .filter((row) => row.length > 0);

      return {
        source: 'aria-grid',
        columns,
        rows: buildStructuredRows(rows, columns),
      };
    };

    const pickBestVariant = (variants) => {
      const scored = variants
        .filter(Boolean)
        .map((variant) => ({
          variant,
          score: (variant.columns?.length || 0) * 10 + (variant.rows?.length || 0) * 100,
        }))
        .sort((left, right) => right.score - left.score);
      return scored[0]?.variant ?? null;
    };

    const collectEmbeddedState = (container) => {
      const state = {
        containerAttributes: serializeInterestingAttributes(container),
        jsonScripts: [],
      };

      for (const script of Array.from(container.querySelectorAll('script[type="application/json"]')).slice(0, 2)) {
        const text = (script.textContent || '').trim();
        if (!text || text.length > 50000) {
          continue;
        }
        try {
          state.jsonScripts.push(JSON.parse(text));
        } catch {
          state.jsonScripts.push(text);
        }
      }

      return state;
    };

    const extractCodeBlockTitle = (container, codeNode, codeText) => {
      const explicitCandidates = [
        container.getAttribute?.('data-title'),
        container.getAttribute?.('data-name'),
        container.querySelector?.('[data-title]')?.getAttribute?.('data-title'),
      ];
      const explicit = pickFirst(explicitCandidates);
      if (isUsableCodeTitle(explicit, codeText)) {
        return explicit;
      }

      const titledDescendants = Array.from(
        container.querySelectorAll?.(
          '[data-testid*="title"], [class*="title"], [class*="header"], [class*="caption"], figcaption',
        ) || [],
      );
      for (const node of titledDescendants) {
        const text = collectCandidateText(node, codeText);
        if (text) {
          return text;
        }
      }

      for (const child of Array.from(container.children || [])) {
        if (child === codeNode || child.contains?.(codeNode)) {
          continue;
        }
        const text = collectCandidateText(child, codeText);
        if (text) {
          return text;
        }
      }

      return '';
    };

    const hasSelectorMatch = (selectors) => selectors.some((selector) => root.querySelector(selector));
    const datatableContainers = selectTopLevelContainers(selectorGroups.datatable || []);

    datatableContainers.forEach((node, index) => {
      node.setAttribute(datatableDomIdAttr, `datatable-${index + 1}`);
    });

    const tables = Array.from(root.querySelectorAll('table'))
      .filter((table) => !datatableContainers.some((container) => container.contains(table)))
      .map((table) =>
        Array.from(table.querySelectorAll('tr')).map((row) =>
          Array.from(row.querySelectorAll('th,td')).map((cell) => cleanText(cell.textContent)),
        ),
      );

    const encryptedBlocks = Array.from(root.querySelectorAll(encryptedSelectors.content))
      .map((node, index) => ({
        text: cleanText(node.innerText || node.textContent || ''),
        matchedPassword: String(node.getAttribute('data-codex-encrypted-password') || '').trim(),
        order:
          node.hasAttribute('data-codex-encrypted-order') &&
          Number.isFinite(Number(node.getAttribute('data-codex-encrypted-order')))
            ? Number(node.getAttribute('data-codex-encrypted-order'))
            : index,
      }))
      .filter((block) => block.text && block.text.length > 0)
      .sort((left, right) => left.order - right.order);

    const lockedEncryptedCount = root.querySelectorAll(encryptedSelectors.input).length;
    const artifactKinds = [];
    for (const [kind, selectors] of Object.entries(selectorGroups)) {
      if (kind === 'encrypted' || kind === 'datatable') {
        continue;
      }
      if (hasSelectorMatch(selectors)) {
        artifactKinds.push(kind);
      }
    }
    if (datatableContainers.length > 0) {
      artifactKinds.push('datatable');
    }

    const datatables = datatableContainers.map((container, index) => {
      const variants = [
        ...Array.from(container.querySelectorAll('table')).map((table) => extractHtmlTableVariant(table)),
        extractAriaGridVariant(container),
      ];
      const bestVariant = pickBestVariant(variants);
      const title = pickFirst(
        [
          container.getAttribute('data-title'),
          container.getAttribute('data-name'),
          container.getAttribute('aria-label'),
          container.querySelector('[role="heading"]')?.textContent,
          container.querySelector('caption')?.textContent,
          container.previousElementSibling?.textContent,
        ],
        `数据表 ${index + 1}`,
      );

      return {
        domId: container.getAttribute(datatableDomIdAttr),
        title,
        source: bestVariant?.source || 'html-only',
        partial: !bestVariant || (bestVariant.columns?.length || 0) === 0 || (bestVariant.rows?.length || 0) === 0,
        columns: bestVariant?.columns || [],
        rows: bestVariant?.rows || [],
        html: container.outerHTML || '',
        structuredState: collectEmbeddedState(container),
      };
    });

    const codeContainers = selectTopLevelContainers(codeBlockSelectors || []);
    const codeBlocks = codeContainers
      .map((container, index) => {
        const codeNode = container.matches?.('pre, code') ? container : container.querySelector?.('pre, code');
        if (!codeNode) {
          return null;
        }

        const codeText = normalizeCodeText(codeNode.innerText || codeNode.textContent || '');
        if (!codeText) {
          return null;
        }

        const scopedContainer =
          codeNode.closest?.('[data-card-name*="code"], [data-type*="code"], figure, [class*="code-block"], [class*="codeBlock"], [class*="codeblock"], [class*="CodeBlock"], [class*="code-view"], [class*="codeView"]') ||
          container;
        const title = extractCodeBlockTitle(scopedContainer, codeNode, codeText);

        return {
          index,
          title,
          codeText,
        };
      })
      .filter(Boolean);

    const renderedImages = Array.from(root.querySelectorAll('img')).map((img, index) => ({
      index,
      src: img.getAttribute('src') || '',
      currentSrc: img.currentSrc || '',
      dataSrc: img.getAttribute('data-src') || '',
      alt: img.getAttribute('alt') || '',
    }));

    return {
      tables,
      artifactKinds,
      datatables,
      codeBlocks,
      renderedImages,
      encryptedBlocks,
      lockedEncryptedCount,
    };
  }, COMPLEX_ARTIFACT_SELECTORS, ENCRYPTED_DOM_SELECTORS, DATATABLE_DOM_ID_ATTR, CODE_BLOCK_CONTAINER_SELECTORS);
  const extractedEncryptedBlocks = requestedTasks.captureEncryptedTexts ? await extractEncryptedBlocks(page) : [];
  const renderedImages = normalizeRenderedImageCatalog(pageData.renderedImages || []);
  docPlan.__renderedImageCatalog = renderedImages;
  docPlan.__renderedImageCatalogLoaded = true;

  const artifacts = {
    ...emptyArtifacts(),
    tables: pageData.tables.filter((table) => table.length > 0),
    codeBlocks: Array.isArray(pageData.codeBlocks) ? pageData.codeBlocks : [],
    renderedImages,
    encryptedBlocks: requestedTasks.captureEncryptedTexts
      ? normalizeEncryptedBlocks(
          extractedEncryptedBlocks.length > 0
            ? extractedEncryptedBlocks
            : encryptedState.unlockedBlocks?.length > 0
              ? encryptedState.unlockedBlocks
              : pageData.encryptedBlocks,
        )
      : [],
    encryptedState: {
      ...encryptedState,
      lockedEncryptedCount: pageData.lockedEncryptedCount,
    },
  };
  artifacts.datatables = requestedTasks.captureDatatables
    ? await persistStructuredDatatables(page, pageData.datatables || [], docPlan, bookPlan, options)
    : [];
  options.onArtifactsCheckpoint?.(artifacts, { stage: 'datatables-persisted' });
  artifacts.boards = precomputedBoards;
  if (requestedTasks.captureBoardPngs && artifacts.boards.length > 0) {
    artifacts.boards = await capturePreparedBoardPngs(page, artifacts.boards);
  }
  if (artifacts.boards.length > 0) {
    pageData.artifactKinds = dedupeTexts([
      ...(pageData.artifactKinds || []),
      'board',
      ...(artifacts.boards.some((board) => board.isPureMindmap) ? ['mindmap'] : []),
    ]);
  }
  Object.assign(
    artifacts,
    resolveArtifactFallback(
      {
        ...pageData,
        datatables: artifacts.datatables,
        boards: artifacts.boards,
      },
      artifacts.encryptedState,
      {
        ...options,
        structuredBoards: artifacts.boards,
      },
    ),
  );
  options.onArtifactsCheckpoint?.(artifacts, { stage: 'artifacts-resolved' });

  if (artifacts.requiresFallback) {
    if (!options.disableArtifactScreenshots) {
      const fileName = reserveAssetName(
        bookPlan,
        bookPlan.assets.blocks,
        sanitizeFileName(`${docPlan.node.name}-snapshot.png`),
      );
      const targetPath = path.join(bookPlan.assets.blocks, fileName);
      const container = await findFallbackCaptureTarget(page, artifacts, options);
      await captureElementScreenshot(page, container, targetPath);
      artifacts.blockImages.push(targetPath);
    }
  }

  options.onArtifactsCheckpoint?.(artifacts, { stage: 'completed' });
  return artifacts;
}

async function disposeHandleSafely(handle) {
  if (!handle) {
    return;
  }
  try {
    await handle.dispose();
  } catch {
    // Ignore disposal failures from detached or crashed handles.
  }
}

async function captureElementScreenshot(page, handle, targetPath) {
  if (!handle) {
    return captureSafePageScreenshot(page, targetPath);
  }

  try {
    await handle.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const bounds = await handle.boundingBox();

    if (
      bounds &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.width <= SAFE_SCREENSHOT_MAX_WIDTH &&
      bounds.height <= SAFE_SCREENSHOT_MAX_HEIGHT
    ) {
      await handle.screenshot({ path: targetPath });
      return targetPath;
    }

    return await captureSafePageScreenshot(page, targetPath, {
      clip: bounds,
    });
  } finally {
    await disposeHandleSafely(handle);
  }
}

async function captureSafePageScreenshot(page, targetPath, options = {}) {
  const dimensions = await page.evaluate(() => {
    const doc = document.documentElement || {};
    const body = document.body || {};
    return {
      width: Math.max(
        Number(doc.scrollWidth || 0),
        Number(doc.clientWidth || 0),
        Number(body.scrollWidth || 0),
        Number(body.clientWidth || 0),
      ),
      height: Math.max(
        Number(doc.scrollHeight || 0),
        Number(doc.clientHeight || 0),
        Number(body.scrollHeight || 0),
        Number(body.clientHeight || 0),
      ),
    };
  });

  const normalizedDimensions = {
    width: Math.max(SAFE_SCREENSHOT_VIEWPORT_WIDTH, Number(dimensions?.width || 0)),
    height: Math.max(SAFE_SCREENSHOT_VIEWPORT_HEIGHT, Number(dimensions?.height || 0)),
  };
  const clip = buildSafeScreenshotClip(options.clip, normalizedDimensions);
  const viewportWidth = Math.max(SAFE_SCREENSHOT_VIEWPORT_WIDTH, clip.width);
  const viewportHeight = Math.min(Math.max(SAFE_SCREENSHOT_VIEWPORT_HEIGHT, Math.min(clip.height, 2000)), 2000);

  try {
    await page.setViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: 1,
    });
  } catch {
    // Ignore viewport failures and continue with the browser default.
  }

  await page.screenshot({
    path: targetPath,
    clip,
    captureBeyondViewport: true,
  });
  return targetPath;
}

function buildSafeScreenshotClip(rawClip, dimensions) {
  const requestedX = Number(rawClip?.x ?? 0);
  const requestedY = Number(rawClip?.y ?? 0);
  const requestedWidth = Number(rawClip?.width ?? dimensions.width ?? SAFE_SCREENSHOT_VIEWPORT_WIDTH);
  const requestedHeight = Number(rawClip?.height ?? dimensions.height ?? SAFE_SCREENSHOT_VIEWPORT_HEIGHT);

  const x = Math.max(0, Math.floor(Number.isFinite(requestedX) ? requestedX : 0));
  const y = Math.max(0, Math.floor(Number.isFinite(requestedY) ? requestedY : 0));
  const availableWidth = Math.max(1, Math.ceil((dimensions.width || SAFE_SCREENSHOT_VIEWPORT_WIDTH) - x));
  const availableHeight = Math.max(1, Math.ceil((dimensions.height || SAFE_SCREENSHOT_VIEWPORT_HEIGHT) - y));
  const requestedSafeWidth = Math.max(1, Math.ceil(Number.isFinite(requestedWidth) ? requestedWidth : availableWidth));
  const requestedSafeHeight = Math.max(1, Math.ceil(Number.isFinite(requestedHeight) ? requestedHeight : availableHeight));

  return {
    x,
    y,
    width: Math.max(1, Math.min(requestedSafeWidth, availableWidth, SAFE_SCREENSHOT_MAX_WIDTH)),
    height: Math.max(1, Math.min(requestedSafeHeight, availableHeight, SAFE_SCREENSHOT_MAX_HEIGHT)),
  };
}

async function exportStandaloneTableDocument(client, page, docDetail, docPlan, bookPlan, options = {}, recordDocIssue) {
  const tableBody = parseTableDocumentBody(docDetail);
  const primarySheet = getPrimaryLaketableSheet(tableBody);
  if (!tableBody || !primarySheet?.id) {
    throw new Error('The Yuque standalone table metadata is missing a usable laketable sheet.');
  }

  let datatable = null;
  let rowCount = 0;
  let columnCount = 0;
  let viewTypes = [];
  let sourceType = 'standalone-table-document';
  let tableFormat = 'laketable';
  let structuredExport = true;
  let recordsApiError = null;

  try {
    const records = await fetchAllTableRecords(client, {
      docId: docDetail.id,
      docType: 'Doc',
      sheetId: primarySheet.id,
    });
    const normalized = normalizeStandaloneTableDocument(docDetail, records);
    datatable = buildStandaloneTableDatatable(normalized, {
      source: 'yuque-table-api',
      partial: false,
    });
    rowCount = normalized.rowCount;
    columnCount = normalized.columnCount;
    viewTypes = normalized.viewTypes;
    sourceType = normalized.sourceType;
    tableFormat = normalized.tableFormat;
  } catch (error) {
    recordsApiError = error;
    recordDocIssue?.({
      phase: 'fetch-table-records',
      error_type: 'StructuredTableApiFallback',
      error_message: `Structured Yuque table API export failed and fell back to table-view DOM parsing: ${errorToMessage(error)}`,
    });
    datatable = await exportStandaloneTableViaDomFallback(page, docDetail, docPlan, primarySheet.id);
    rowCount = Array.isArray(datatable?.rows) ? datatable.rows.length : 0;
    columnCount = Array.isArray(datatable?.columns) ? datatable.columns.length : 0;
    viewTypes = Array.isArray(datatable?.viewTypes) ? datatable.viewTypes : [];
    sourceType = datatable?.sourceType || sourceType;
    tableFormat = datatable?.tableFormat || tableFormat;
    structuredExport = Boolean(datatable);
  }

  if (!datatable) {
    throw recordsApiError || new Error('Failed to export the standalone Yuque table.');
  }

  const documentDir = ensureDir(path.join(bookPlan.assets.datatables, buildDatatableDocumentDirName(bookPlan, docPlan)));
  const folderName = reserveAssetName(
    bookPlan,
    documentDir,
    sanitizeFileName(datatable.title || docPlan.node.name || 'datatable', 'datatable'),
  );
  const tableDir = ensureDir(path.join(documentDir, folderName));
  const imageDownloadCount = await downloadStandaloneTableImages(
    client,
    datatable,
    tableDir,
    docPlan,
    recordDocIssue,
  );
  const files = writeDatatableSidecarFiles(datatable, tableDir);
  try {
    await captureStandaloneTableScreenshot(page, docPlan, files.pngPath);
  } catch (screenshotError) {
    removeIfExists(files.pngPath);
    recordDocIssue?.({
      phase: 'capture-artifacts',
      error_type: 'TableSnapshotSkipped',
      error_message: `Structured table export completed, but the PNG snapshot could not be captured: ${errorToMessage(screenshotError)}`,
    });
  }

  const obsidian = writeDatatableObsidianDatasetFiles(datatable, {
    docPlan,
    bookPlan,
    outputDir: options.contentOutputDir || options.outputDir || path.dirname(bookPlan.bookDir),
    datasetDirName: folderName,
    datasetIndex: 0,
    sidecarFiles: files,
    primaryBasePath: buildStandaloneTablePrimaryBasePath(docPlan),
    linkRoot: resolveDatatableLinkRoot(options),
  });

  datatable.files = files;
  datatable.obsidian = obsidian;
  datatable.imageDownloadCount = imageDownloadCount;
  datatable.structuredExport = structuredExport;
  datatable.structuredSuccessRate = datatable.partial ? 0.75 : 1;
  datatable.hasSnapshotFallback = fs.existsSync(files.pngPath);

  return {
    sourceType,
    tableFormat,
    docId: docDetail.id,
    sheetId: primarySheet.id,
    rowCount,
    columnCount,
    viewTypes,
    structuredExport,
    imageDownloadCount,
    files,
    obsidian,
    primaryOutputPath: obsidian.primaryBasePath || obsidian.basePath || '',
    datatable,
  };
}

function buildStandaloneTableDatatable(normalizedTable, overrides = {}) {
  return {
    title: normalizedTable.title,
    sourceType: overrides.sourceType || normalizedTable.sourceType || 'standalone-table-document',
    source: overrides.source || 'yuque-table-api',
    tableFormat: normalizedTable.tableFormat || 'laketable',
    docId: normalizedTable.docId || 0,
    sheetId: normalizedTable.sheetId || '',
    viewTypes: normalizedTable.viewTypes || [],
    defaultViewId: normalizedTable.defaultViewId || '',
    activeViewId: normalizedTable.activeViewId || '',
    defaultView: normalizedTable.defaultView || null,
    activeView: normalizedTable.activeView || null,
    tableView: normalizedTable.tableView || null,
    cardView: normalizedTable.cardView || null,
    views: Array.isArray(normalizedTable.views) ? normalizedTable.views : [],
    partial: Boolean(overrides.partial),
    columns: normalizedTable.columns.map((column) => ({
      key: column.key,
      id: column.id,
      name: column.name,
      type: column.type,
      rawName: column.rawName,
      options: column.options,
    })),
    rows: normalizedTable.rows,
    html: overrides.html || '',
    structuredState: {
      sourceType: overrides.sourceType || normalizedTable.sourceType || 'standalone-table-document',
      tableFormat: normalizedTable.tableFormat || 'laketable',
      docId: normalizedTable.docId || 0,
      sheetId: normalizedTable.sheetId || '',
      tableId: normalizedTable.tableId || '',
      viewTypes: normalizedTable.viewTypes || [],
      defaultViewId: normalizedTable.defaultViewId || '',
      activeViewId: normalizedTable.activeViewId || '',
      defaultView: normalizedTable.defaultView || null,
      activeView: normalizedTable.activeView || null,
      tableView: normalizedTable.tableView || null,
      cardView: normalizedTable.cardView || null,
      views: Array.isArray(normalizedTable.views) ? normalizedTable.views : [],
      rowCount: normalizedTable.rowCount || 0,
      columnCount: normalizedTable.columnCount || 0,
      recordsApi: 'TableRecordController/show',
      recordContentApi: 'TableRecordController/getContent',
      rawBody: normalizedTable.rawBody || null,
    },
  };
}

function exportStandaloneSpreadsheetDocument(docDetail, docPlan, bookPlan) {
  const workbook = normalizeStandaloneSheetDocument(docDetail);
  const documentDir = ensureDir(path.join(bookPlan.assets.spreadsheets, buildSpreadsheetDocumentDirName(bookPlan, docPlan)));
  const folderName = reserveAssetName(
    bookPlan,
    documentDir,
    sanitizeFileName(workbook.title || docPlan.node.name || 'spreadsheet', 'spreadsheet'),
  );
  const spreadsheetDir = ensureDir(path.join(documentDir, folderName));
  const sheetsDir = ensureDir(path.join(spreadsheetDir, 'sheets'));
  const files = {
    dir: spreadsheetDir,
    workbookJsonPath: path.join(spreadsheetDir, 'workbook.json'),
    workbookSourceJsonPath: path.join(spreadsheetDir, 'workbook.yuque.json'),
    workbookHtmlPath: path.join(spreadsheetDir, 'workbook.html'),
    sheets: [],
  };

  writeJson(files.workbookJsonPath, buildSpreadsheetWorkbookPayload(workbook));
  writeJson(files.workbookSourceJsonPath, workbook.rawBody || {});
  fs.writeFileSync(files.workbookHtmlPath, buildWorkbookHtmlDocument(workbook), 'utf8');

  for (const sheet of workbook.sheets || []) {
    const baseName = `${String((sheet.index ?? 0) + 1).padStart(2, '0')}-${sanitizeFileName(sheet.name || 'sheet', 'sheet')}`;
    const sheetFiles = {
      name: sheet.name,
      csvPath: path.join(sheetsDir, `${baseName}.csv`),
      jsonPath: path.join(sheetsDir, `${baseName}.json`),
      htmlPath: path.join(sheetsDir, `${baseName}.html`),
    };

    fs.writeFileSync(sheetFiles.csvPath, buildWorksheetCsv(sheet), 'utf8');
    writeJson(sheetFiles.jsonPath, sheet);
    fs.writeFileSync(sheetFiles.htmlPath, buildWorksheetHtmlDocument(workbook.title, sheet), 'utf8');
    files.sheets.push(sheetFiles);
  }

  return {
    title: workbook.title,
    sheetFormat: workbook.sheetFormat,
    version: workbook.version,
    docId: workbook.docId,
    sheetCount: workbook.sheetCount,
    sheets: (workbook.sheets || []).map((sheet, index) => ({
      index,
      name: sheet.name,
      usedRowCount: sheet.usedRowCount,
      usedColCount: sheet.usedColCount,
      mergeCellCount: sheet.mergeCellCount,
      files: files.sheets[index],
      previewRows: getSpreadsheetPreviewRows(sheet, 6),
    })),
    files,
  };
}

function buildSpreadsheetWorkbookPayload(workbook) {
  return {
    sourceType: workbook.sourceType,
    sheetFormat: workbook.sheetFormat,
    version: workbook.version,
    docId: workbook.docId,
    title: workbook.title,
    description: workbook.description,
    cover: workbook.cover,
    sheetCount: workbook.sheetCount,
    sheets: workbook.sheets,
  };
}

function buildStandaloneTablePrimaryBasePath(docPlan) {
  return docPlan.targetMdPath.replace(/\.md$/i, '.base');
}

function resolveDatatableLinkRoot(options = {}) {
  const vaultPath = String(options.obsidianVaultPath || '').trim();
  const exportLayout = String(options.vaultExportLayout || '').trim().toLowerCase();
  if (vaultPath && exportLayout === 'direct-to-vault') {
    return path.resolve(vaultPath);
  }
  return '';
}

async function exportStandaloneTableViaDomFallback(page, docDetail, docPlan, sheetId) {
  await page.goto(docPlan.absoluteDocUrl, {
    timeout: 120000,
    waitUntil: 'networkidle2',
  });
  await switchStandaloneTableToGridView(page);

  const result = await page.evaluate(() => {
    const cleanText = (value) =>
      String(value ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    const table = document.querySelector('table');
    if (!table) {
      return null;
    }

    const rowElements = Array.from(table.querySelectorAll('tr'));
    if (rowElements.length === 0) {
      return null;
    }

    const rows = rowElements.map((row) =>
      Array.from(row.querySelectorAll('th,td')).map((cell) => ({
        text: cleanText(cell.innerText || cell.textContent || ''),
        html: cell.innerHTML || '',
      })),
    );
    const headerRow = rows.find((row) => row.length > 0) || [];
    const bodyRows = rows.slice(1);

    return {
      title: cleanText(document.title || ''),
      columns: headerRow.map((cell, index) => ({
        key: `col_${index + 1}`,
        name: cell.text || `Column ${index + 1}`,
        type: 'text',
        rawName: cell.text || '',
        options: [],
      })),
      rows: bodyRows.map((row, rowIndex) => ({
        index: rowIndex,
        values: Object.fromEntries(
          row.map((cell, cellIndex) => [`col_${cellIndex + 1}`, cleanText(cell.text)]),
        ),
        cells: row.map((cell, cellIndex) => ({
          columnKey: `col_${cellIndex + 1}`,
          columnName: headerRow[cellIndex]?.text || `Column ${cellIndex + 1}`,
          text: cleanText(cell.text),
          html: cell.html || '',
          kind: 'html-table-cell',
          value: cleanText(cell.text),
          raw: {
            sourceValue: cleanText(cell.text),
            normalizedValue: cleanText(cell.text),
            columnType: 'text',
            imageAssets: [],
          },
        })),
      })),
      html: table.outerHTML || '',
    };
  });

  if (!result) {
    throw new Error('The standalone Yuque table could not be parsed from the table-view DOM fallback.');
  }

  return {
    ...result,
    sourceType: 'standalone-table-dom-fallback',
    source: 'table-view-dom',
    tableFormat: parseTableDocumentBody(docDetail)?.format || 'laketable',
    docId: docDetail?.id || 0,
    sheetId: sheetId || '',
    viewTypes: ['GRID'],
    partial: true,
    structuredState: {
      sourceType: 'standalone-table-dom-fallback',
      tableFormat: parseTableDocumentBody(docDetail)?.format || 'laketable',
      docId: docDetail?.id || 0,
      sheetId: sheetId || '',
      viewTypes: ['GRID'],
    },
  };
}

async function downloadStandaloneTableImages(client, datatable, tableDir, docPlan, recordDocIssue) {
  const imagesDir = ensureDir(path.join(tableDir, 'images'));
  const seenDownloads = new Map();
  const reservedNames = new Set();
  let downloadedCount = 0;

  for (const row of datatable.rows || []) {
    for (const cell of row.cells || []) {
      const assets = extractTableImageAssets(cell.value);
      if (assets.length === 0) {
        continue;
      }

      const nextAssets = [];
      for (const asset of assets) {
        const sourceUrl = String(asset?.sourceUrl || asset?.src || '').trim();
        let localPath = '';

        if (sourceUrl && seenDownloads.has(sourceUrl)) {
          localPath = seenDownloads.get(sourceUrl);
        } else if (sourceUrl) {
          try {
            const fileName = uniqueName(
              sanitizeTableImageFileName(asset?.name || `${docPlan.node.name}-image-${downloadedCount + 1}`),
              reservedNames,
            );
            localPath = path.join(imagesDir, fileName);
            const { response } = await downloadBinaryAsset(client, sourceUrl, { kind: 'image' });
            fs.writeFileSync(localPath, response.data);
            seenDownloads.set(sourceUrl, localPath);
            downloadedCount += 1;
          } catch (error) {
            localPath = '';
            recordDocIssue?.({
              phase: 'rewrite-markdown',
              error_type: 'TableImageDownloadSkipped',
              error_message: `Skipped downloading Yuque table image ${sourceUrl} because ${errorToMessage(error)}.`,
            });
          }
        }

        nextAssets.push({
          ...asset,
          localPath,
          localRelativePath: localPath ? toPosixPath(path.relative(tableDir, localPath)) : '',
        });
      }

      const nextValue = nextAssets.length === 1 ? nextAssets[0] : nextAssets;
      cell.value = nextValue;
      cell.text = nextAssets
        .map((asset) => asset.localRelativePath || asset.sourceUrl || asset.name)
        .filter(Boolean)
        .join('; ');
      cell.html = renderStandaloneTableImageHtml(nextValue);
      cell.raw = {
        ...(cell.raw || {}),
        imageAssets: nextAssets,
      };
      row.values[cell.columnKey] = nextValue;
    }
  }

  return downloadedCount;
}

function renderStandaloneTableImageHtml(value) {
  const assets = extractTableImageAssets(value);
  return assets
    .map((asset) => {
      const src = asset.localRelativePath || asset.sourceUrl;
      if (!src) {
        return '';
      }
      const alt = asset.name || path.basename(src);
      return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}" loading="lazy" />`;
    })
    .filter(Boolean)
    .join('');
}

async function captureStandaloneTableScreenshot(page, docPlan, targetPath) {
  await page.goto(docPlan.absoluteDocUrl, {
    timeout: 120000,
    waitUntil: 'networkidle2',
  });
  await switchStandaloneTableToGridView(page);

  const handle =
    (await page.$('table')) ||
    (await page.$('[role="grid"]')) ||
    (await page.$('article')) ||
    (await page.$('.ne-viewer-body'));
  return await captureElementScreenshot(page, handle, targetPath);
}

async function switchStandaloneTableToGridView(page) {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [class*="tab"]'));
    const target = candidates.find((node) => {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
      return text === '表格视图' || text.startsWith('表格视图');
    });
    if (!target) {
      return false;
    }
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  });

  if (clicked) {
    await page.waitForTimeout(1200);
  }
}

function buildStandaloneTableMarkdown(docPlan, standaloneTable) {
  const fileLinks = [
    `- [CSV 表格](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.files.csvPath)})`,
    `- [完整行 JSON](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.files.rowsJsonPath)})`,
    `- [表结构 JSON](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.files.schemaJsonPath)})`,
    `- [HTML 视图](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.files.htmlPath)})`,
  ];

  if (fs.existsSync(standaloneTable.files.pngPath)) {
    fileLinks.push(`- [PNG 快照](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.files.pngPath)})`);
  }
  if (standaloneTable.obsidian?.basePath) {
    fileLinks.push(`- [Obsidian Base](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.obsidian.basePath)})`);
  }
  if (standaloneTable.obsidian?.viewManifestPath) {
    fileLinks.push(`- [视图清单](${relativeMarkdownPath(docPlan.targetMdPath, standaloneTable.obsidian.viewManifestPath)})`);
  }

  const lines = [
    `# ${standaloneTable.datatable.title || docPlan.node.name}`,
    '',
    '> 当前语雀智能表已通过结构化接口导出，可直接用于 Obsidian Bases / CSV / HTML。',
    '',
    `- 源地址: ${docPlan.absoluteDocUrl}`,
    `- 表格类型: ${standaloneTable.tableFormat}`,
    `- 记录数: ${standaloneTable.rowCount}`,
    `- 字段数: ${standaloneTable.columnCount}`,
    `- 视图类型: ${(standaloneTable.viewTypes || []).join(', ') || 'GRID'}`,
    `- 图片资源下载数: ${standaloneTable.imageDownloadCount}`,
    '',
    '## 导出文件',
    '',
    ...fileLinks,
    '',
    '## 字段概览',
    '',
    '| 字段 | 类型 | 选项数 |',
    '| --- | --- | --- |',
  ];

  for (const column of summarizeTableColumns(standaloneTable.datatable)) {
    lines.push(`| ${column.name} | ${column.type} | ${column.optionCount} |`);
  }

  const previewRows = getTablePreviewRows(standaloneTable.datatable, DATATABLE_PREVIEW_ROWS);
  if (previewRows.length > 0) {
    const headers = standaloneTable.datatable.columns.map((column) => column.name);
    const bodyRows = previewRows.map((row) =>
      standaloneTable.datatable.columns.map((column, index) => getDatatableCellText(row, column, index)),
    );
    lines.push('', '## 数据预览', '', tableToMarkdown([headers, ...bodyRows]));
  }

  return `${lines.join('\n')}\n`;
}

function buildStandaloneSpreadsheetMarkdown(docPlan, standaloneSpreadsheet) {
  const lines = [
    `# ${standaloneSpreadsheet.title || docPlan.node.name}`,
    '',
    '> 当前语雀电子表格已按工作簿 / 工作表结构导出，可直接查看整份工作簿 HTML，也可逐个工作表查看 CSV / HTML / JSON。',
    '',
    `- 源地址: ${docPlan.absoluteDocUrl}`,
    `- 文档类型: ${standaloneSpreadsheet.sheetFormat || 'lakesheet'}`,
    `- 工作表数量: ${standaloneSpreadsheet.sheetCount || 0}`,
  ];

  if (standaloneSpreadsheet.version) {
    lines.push(`- 工作簿版本: ${standaloneSpreadsheet.version}`);
  }

  lines.push(
    '',
    '## 导出文件',
    '',
    `- [工作簿总览 HTML](${relativeMarkdownPath(docPlan.targetMdPath, standaloneSpreadsheet.files.workbookHtmlPath)})`,
    `- [工作簿结构 JSON](${relativeMarkdownPath(docPlan.targetMdPath, standaloneSpreadsheet.files.workbookJsonPath)})`,
    `- [语雀原始数据 JSON](${relativeMarkdownPath(docPlan.targetMdPath, standaloneSpreadsheet.files.workbookSourceJsonPath)})`,
    '',
    '## 工作表',
    '',
  );

  for (const sheet of standaloneSpreadsheet.sheets || []) {
    lines.push(`### ${sheet.name || `Sheet ${(sheet.index ?? 0) + 1}`}`);
    lines.push('');
    lines.push(`- 有效区域: ${sheet.usedRowCount} 行 × ${sheet.usedColCount} 列`);
    lines.push(`- 合并单元格: ${sheet.mergeCellCount || 0}`);
    lines.push(`- [CSV](${relativeMarkdownPath(docPlan.targetMdPath, sheet.files.csvPath)})`);
    lines.push(`- [HTML](${relativeMarkdownPath(docPlan.targetMdPath, sheet.files.htmlPath)})`);
    lines.push(`- [JSON](${relativeMarkdownPath(docPlan.targetMdPath, sheet.files.jsonPath)})`);

    if (Array.isArray(sheet.previewRows) && sheet.previewRows.length > 0) {
      lines.push('', '```text');
      for (const row of sheet.previewRows) {
        lines.push(row.join(' | '));
      }
      lines.push('```');
    }

    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function getSpreadsheetPreviewRows(sheet, limit = 6) {
  const grid = Array.isArray(sheet?.grid) ? sheet.grid : [];
  return grid
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    .slice(0, limit)
    .map((row) => row.map((cell) => String(cell ?? '').trim()));
}

function buildBoardDocumentMarkdown(docPlan, docDetail = {}) {
  const title = String(docDetail?.title || docPlan?.node?.name || 'Untitled').trim() || 'Untitled';
  return `# ${title}\n`;
}

function resolveStandaloneExcalidrawPrimary(docExportRoute, boards = []) {
  if (docExportRoute !== 'export-board' || !Array.isArray(boards) || boards.length !== 1) {
    return null;
  }
  const [board] = boards;
  if (
    String(board?.sourceType || '') !== 'board-document' ||
    String(board?.primaryFormat || '') !== 'excalidraw' ||
    !board?.excalidrawPath ||
    !fs.existsSync(board.excalidrawPath)
  ) {
    return null;
  }
  return board;
}

async function persistStructuredBoards(page, docDetail, docPlan, bookPlan, options = {}) {
  const boards = prepareStructuredBoards(docDetail, docPlan, bookPlan, options);
  if (!Array.isArray(boards) || boards.length === 0) {
    return [];
  }
  return await capturePreparedBoardPngs(page, boards);
}

function buildBoardDocumentDirName(bookPlan, docPlan) {
  const relativeDocPath = path.relative(bookPlan.bookDir, docPlan.targetMdPath);
  return sanitizeFileName(relativeDocPath.replace(/\.md$/i, '').replace(/[\\/]+/g, '__'));
}

function buildSpreadsheetDocumentDirName(bookPlan, docPlan) {
  const relativeDocPath = path.relative(bookPlan.bookDir, docPlan.targetMdPath);
  return sanitizeFileName(relativeDocPath.replace(/\.md$/i, '').replace(/[\\/]+/g, '__'));
}

function writeBoardSidecarFiles(diagramData, documentDir, index) {
  const baseName = `board-${index + 1}`;
  const jsonPath = path.join(documentDir, `${baseName}.yuque.json`);
  const canvasPath = path.join(documentDir, `${baseName}.canvas`);
  const pngPath = path.join(documentDir, `${baseName}.png`);
  const manifestPath = path.join(documentDir, `${baseName}.manifest.json`);
  writeJson(jsonPath, diagramData);
  return {
    dir: documentDir,
    jsonPath,
    canvasPath,
    pngPath,
    manifestPath,
  };
}

/**
 * 只覆盖“上一版由本程序生成且尚未被人工改动”的 Excalidraw 文件。
 * 任何无法确认归属的同名文件都视为人工成果，转而输出 yuque-update 版本。
 */
function persistBoardExcalidrawArtifact({ sourceBoard, renderPlan, files, docPlan, sourceHash, index }) {
  const targetPath = resolveBoardExcalidrawTargetPath(sourceBoard, files, docPlan, index);
  const previousManifest = readJsonIfExists(files.manifestPath);
  const existingHash = hashFileIfExists(targetPath);
  const previousGeneratedHash = String(previousManifest?.generatedHash || '');
  const sameSource = String(previousManifest?.sourceHash || '') === sourceHash;
  const wasGeneratedAndUnmodified = Boolean(existingHash && previousGeneratedHash && existingHash === previousGeneratedHash);
  const warnings = [];

  if (existingHash && sameSource && wasGeneratedAndUnmodified) {
    const scene = readExcalidrawScene(targetPath, { fromFile: true });
    const validation = validateExcalidrawScene(scene, {
      nodeCount: renderPlan.ir.nodes.length,
      edgeCount: renderPlan.ir.edges.length,
    });
    if (!validation.valid) {
      throw new Error(`已存在的 Excalidraw 文件未通过结构校验：${validation.errors.join('；')}`);
    }
    return { path: targetPath, generatedHash: existingHash, status: 'unchanged', warnings };
  }

  let writePath = targetPath;
  let allowOverwrite = false;
  let status = 'created';
  if (existingHash) {
    if (wasGeneratedAndUnmodified) {
      backupGeneratedExcalidraw(targetPath, files.dir);
      allowOverwrite = true;
      status = 'updated';
    } else {
      writePath = buildExcalidrawUpdatePath(targetPath);
      status = 'conflict-copy';
      warnings.push('检测到同名 Excalidraw 文件存在人工修改，已生成 yuque-update 副本，原文件未覆盖。');
    }
  }

  const result = writeExcalidrawDrawing(writePath, renderPlan.ir, { allowOverwrite });
  const generatedHash = hashFileIfExists(result.targetPath);
  return { path: result.targetPath, generatedHash, status, warnings };
}

function resolveBoardExcalidrawTargetPath(sourceBoard, files, docPlan, index) {
  if (String(sourceBoard?.sourceType || '') === 'board-document') {
    return docPlan.targetMdPath.replace(/\.md$/i, '.excalidraw.md');
  }
  return path.join(files.dir, `board-${Number(index) + 1}.excalidraw.md`);
}

function buildExcalidrawUpdatePath(targetPath) {
  const extension = '.excalidraw.md';
  const stem = targetPath.endsWith(extension) ? targetPath.slice(0, -extension.length) : targetPath;
  const initial = `${stem}.yuque-update${extension}`;
  if (!fs.existsSync(initial)) {
    return initial;
  }
  return `${stem}.yuque-update-${formatTimestamp()}${extension}`;
}

function backupGeneratedExcalidraw(targetPath, documentDir) {
  const historyDir = ensureDir(path.join(documentDir, 'history'));
  const baseName = path.basename(targetPath).replace(/\.excalidraw\.md$/i, '');
  const backupPath = path.join(historyDir, `${baseName}-${formatTimestamp()}.excalidraw.md`);
  fs.copyFileSync(targetPath, backupPath);
  return backupPath;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function hashFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 将截图工作线程后产生的 PNG 状态同步回画板清单。
 * 清单采用追加式文件记录：不因一次截图失败而删除历史快照记录。
 */
export function refreshBoardManifestAfterPngCapture(board = {}) {
  const manifestPath = String(board?.files?.manifestPath || '').trim();
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return null;
  }

  const manifest = readJsonIfExists(manifestPath);
  if (!manifest) {
    return null;
  }

  const generatedFiles = new Set(
    (Array.isArray(manifest.generatedFiles) ? manifest.generatedFiles : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  const pngPath = String(board?.files?.pngPath || '').trim();
  if (pngPath && fs.existsSync(pngPath)) {
    generatedFiles.add(pngPath);
  }

  manifest.generatedFiles = [...generatedFiles];
  manifest.png = {
    requested: Boolean(board?.pngRequested),
    captured: Boolean(board?.pngCaptured),
    stale: Boolean(board?.pngStale),
    error: String(board?.pngCaptureError || ''),
  };
  writeJson(manifestPath, manifest);
  return manifest;
}

async function captureBoardPng(page, boardIndex, targetPath) {
  try {
    const dataUrl = await page.evaluate(async (targetIndex) => {
      const containers = Array.from(document.querySelectorAll('.lake-board-content'));
      const target = containers[targetIndex] || containers[0];
      if (!target) {
        throw new Error('Board container not found.');
      }

      const findReactEntry = (node) =>
        Object.getOwnPropertyNames(node).find(
          (key) => key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance'),
        );

      const collectNextValues = (value) => {
        const next = [];
        for (const key of ['return', 'child', 'sibling', 'stateNode', 'memoizedProps', 'memoizedState']) {
          if (value?.[key]) {
            next.push(value[key]);
          }
        }
        for (const key of Object.getOwnPropertyNames(value || {}).slice(0, 20)) {
          if (/^(return|child|sibling|stateNode|memoizedProps|memoizedState)$/.test(key)) {
            continue;
          }
          const candidate = value[key];
          if (candidate && (typeof candidate === 'object' || typeof candidate === 'function')) {
            next.push(candidate);
          }
        }
        return next;
      };

      const reactKey = findReactEntry(target);
      const queue = reactKey ? [target[reactKey]] : [];
      const seen = new Set();

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || (typeof current !== 'object' && typeof current !== 'function')) {
          continue;
        }
        if (seen.has(current)) {
          continue;
        }
        seen.add(current);

        if (typeof current.canvas === 'function') {
          const canvas = await current.canvas({});
          if (!canvas) {
            throw new Error('Board engine returned an empty canvas.');
          }
          const data = canvas.toDataURL('image/png');
          if (!data || data.length < 32) {
            throw new Error('Board engine returned an empty image.');
          }
          return data;
        }

        for (const next of collectNextValues(current)) {
          queue.push(next);
        }
      }

      throw new Error('Board engine not found.');
    }, boardIndex);

    writeDataUrlToFile(dataUrl, targetPath);
    return targetPath;
  } catch {
    const selector = '.lake-board-content';
    const handles = await page.$$(selector);
    const handle = handles[boardIndex] || handles[0] || null;
    try {
      return await captureElementScreenshot(page, handle, targetPath);
    } finally {
      await Promise.all(handles.map((entry) => (entry === handle ? Promise.resolve() : disposeHandleSafely(entry))));
    }
  }
}

function writeDataUrlToFile(dataUrl, targetPath) {
  const match = String(dataUrl ?? '').match(/^data:image\/png;base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid PNG data URL returned by Yuque board engine.');
  }
  fs.writeFileSync(targetPath, Buffer.from(match[1], 'base64'));
}

async function unlockEncryptedBlocks(page, passwords) {
  await clearEncryptedBlockSkipMarkers(page);
  const unlockedBlocks = await initializeEncryptedContentMetadata(page);
  const detectedCount = await countLockedEncryptedInputs(page);
  if (!detectedCount) {
    return {
      attempted: false,
      detectedCount: 0,
      unlockedCount: 0,
      remainingLockedCount: 0,
      attemptedPasswordCount: 0,
      matchedPassword: '',
      unlockedBlocks,
    };
  }

  const candidates = normalizePasswordCandidates(passwords);
  if (candidates.length === 0) {
    return {
      attempted: false,
      detectedCount,
      unlockedCount: 0,
      remainingLockedCount: detectedCount,
      attemptedPasswordCount: 0,
      matchedPassword: '',
      unlockedBlocks,
    };
  }

  const matchedPasswords = [];
  let attempted = false;

  while ((await countPendingLockedEncryptedBlocks(page)) > 0) {
    const result = await unlockNextEncryptedBlock(page, candidates, matchedPasswords, unlockedBlocks.length);
    attempted = attempted || result.attempted;
    if (result.status === 'unlocked' && result.password && !matchedPasswords.includes(result.password)) {
      matchedPasswords.push(result.password);
    }
    if (result.status === 'unlocked' && result.block) {
      unlockedBlocks.push(result.block);
    }
  }

  const remainingLockedCount = await countLockedEncryptedInputs(page);
  await clearEncryptedBlockSkipMarkers(page);

  return {
    attempted,
    detectedCount,
    unlockedCount: Math.max(detectedCount - remainingLockedCount, 0),
    remainingLockedCount,
    attemptedPasswordCount: candidates.length,
    matchedPassword: matchedPasswords.join(', '),
    unlockedBlocks,
  };
}

async function countLockedEncryptedInputs(page) {
  return await page.evaluate((selectors) => document.querySelectorAll(selectors.input).length, ENCRYPTED_DOM_SELECTORS);
}

async function countPendingLockedEncryptedBlocks(page) {
  return await page.evaluate(
    ({ lockedContainer, skipAttr }) =>
      Array.from(document.querySelectorAll(lockedContainer)).filter((node) => !node.hasAttribute(skipAttr)).length,
    {
      lockedContainer: ENCRYPTED_DOM_SELECTORS.lockedContainer,
      skipAttr: ENCRYPTED_SKIP_ATTR,
    },
  );
}

async function clearEncryptedBlockSkipMarkers(page) {
  await page.evaluate((skipAttr) => {
    for (const node of document.querySelectorAll(`[${skipAttr}]`)) {
      node.removeAttribute(skipAttr);
    }
  }, ENCRYPTED_SKIP_ATTR);
}

async function unlockNextEncryptedBlock(page, passwords, matchedPasswords = [], nextOrder = 0) {
  const orderedPasswords = [...matchedPasswords, ...passwords.filter((password) => !matchedPasswords.includes(password))];
  const beforeCount = await countLockedEncryptedInputs(page);
  if (beforeCount === 0) {
    return { attempted: false, status: 'none', password: '', block: null };
  }

  for (const password of orderedPasswords) {
    const prepared = await fillFirstPendingEncryptedBlockPassword(page, password);
    if (!prepared) {
      return { attempted: false, status: 'none', password: '', block: null };
    }

    const submitted = await submitFirstPendingEncryptedBlock(page);
    if (!submitted) {
      await page.keyboard.press('Enter');
    }

    try {
      await page.waitForFunction(
        (selectors, previousCount) => document.querySelectorAll(selectors.input).length < previousCount,
        { timeout: 2500 },
        ENCRYPTED_DOM_SELECTORS,
        beforeCount,
      );
      const block = await captureNextUnlockedEncryptedBlock(page, password, nextOrder);
      return { attempted: true, status: 'unlocked', password, block };
    } catch {
      await sleep(500);
    }
  }

  await markFirstPendingEncryptedBlockSkipped(page);
  return {
    attempted: orderedPasswords.length > 0,
    status: 'skipped',
    password: '',
    block: null,
  };
}

async function initializeEncryptedContentMetadata(page) {
  return await page.evaluate(
    ({ contentSelector, orderAttr, passwordAttr }) => {
      const cleanText = (value) =>
        String(value ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      return Array.from(document.querySelectorAll(contentSelector))
        .map((node, index) => {
          const text = cleanText(node.innerText || node.textContent || '');
          if (!text) {
            node.removeAttribute(orderAttr);
            node.removeAttribute(passwordAttr);
            return null;
          }
          node.setAttribute(orderAttr, String(index));
          node.removeAttribute(passwordAttr);
          return {
            text,
            matchedPassword: '',
            order: index,
          };
        })
        .filter(Boolean);
    },
    {
      contentSelector: ENCRYPTED_DOM_SELECTORS.content,
      orderAttr: ENCRYPTED_ORDER_ATTR,
      passwordAttr: ENCRYPTED_PASSWORD_ATTR,
    },
  );
}

async function captureNextUnlockedEncryptedBlock(page, password, order) {
  return await page.evaluate(
    ({ contentSelector, orderAttr, passwordAttr, passwordValue, nextOrder }) => {
      const cleanText = (value) =>
        String(value ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      const target = Array.from(document.querySelectorAll(contentSelector)).find((node) => !node.hasAttribute(orderAttr));
      if (!target) {
        return null;
      }

      const text = cleanText(target.innerText || target.textContent || '');
      target.setAttribute(orderAttr, String(nextOrder));
      if (passwordValue) {
        target.setAttribute(passwordAttr, passwordValue);
      } else {
        target.removeAttribute(passwordAttr);
      }

      return text
        ? {
            text,
            matchedPassword: String(passwordValue || '').trim(),
            order: nextOrder,
          }
        : null;
    },
    {
      contentSelector: ENCRYPTED_DOM_SELECTORS.content,
      orderAttr: ENCRYPTED_ORDER_ATTR,
      passwordAttr: ENCRYPTED_PASSWORD_ATTR,
      passwordValue: password,
      nextOrder: order,
    },
  );
}

async function fillFirstPendingEncryptedBlockPassword(page, password) {
  const container = await page.$(`${ENCRYPTED_DOM_SELECTORS.lockedContainer}:not([${ENCRYPTED_SKIP_ATTR}])`);
  if (!container) {
    return false;
  }

  const input = await container.$(ENCRYPTED_DOM_SELECTORS.input);
  if (!input) {
    return false;
  }

  await input.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await input.click({ clickCount: 1 });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await input.type(password, { delay: 40 });
  await input.evaluate((node, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (descriptor?.set) {
      descriptor.set.call(node, value);
    } else {
      node.value = value;
    }
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  }, password);
  return true;
}

async function submitFirstPendingEncryptedBlock(page) {
  const container = await page.$(`${ENCRYPTED_DOM_SELECTORS.lockedContainer}:not([${ENCRYPTED_SKIP_ATTR}])`);
  if (!container) {
    return false;
  }

  const button = await container.$(ENCRYPTED_DOM_SELECTORS.submitButton);
  if (button) {
    await button.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await button.click();
    return true;
  }

  const input = await container.$(ENCRYPTED_DOM_SELECTORS.input);
  if (input) {
    await input.press('Enter');
    return true;
  }

  return false;
}

async function markFirstPendingEncryptedBlockSkipped(page) {
  await page.evaluate(
    ({ lockedContainer, skipAttr }) => {
      const target = Array.from(document.querySelectorAll(lockedContainer)).find((node) => !node.hasAttribute(skipAttr));
      if (target) {
        target.setAttribute(skipAttr, '1');
      }
    },
    {
      lockedContainer: ENCRYPTED_DOM_SELECTORS.lockedContainer,
      skipAttr: ENCRYPTED_SKIP_ATTR,
    },
  );
}

async function extractEncryptedBlocks(page) {
  return await page.evaluate(
    ({ contentSelector, orderAttr, passwordAttr }) => {
      const cleanText = (value) =>
        String(value ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      return Array.from(document.querySelectorAll(contentSelector))
        .map((node, index) => ({
          text: cleanText(node.innerText || node.textContent || ''),
          matchedPassword: String(node.getAttribute(passwordAttr) || '').trim(),
          order: node.hasAttribute(orderAttr) && Number.isFinite(Number(node.getAttribute(orderAttr)))
            ? Number(node.getAttribute(orderAttr))
            : index,
        }))
        .filter((block) => block.text.length > 0)
        .sort((left, right) => left.order - right.order);
    },
    {
      contentSelector: ENCRYPTED_DOM_SELECTORS.content,
      orderAttr: ENCRYPTED_ORDER_ATTR,
      passwordAttr: ENCRYPTED_PASSWORD_ATTR,
    },
  );
}

async function safeExtractArtifacts(page, docPlan, bookPlan, options = {}) {
  try {
    return await extractComplexArtifacts(page, docPlan, bookPlan, options);
  } catch {
    return emptyArtifacts(options.forceFallbackSnapshot ? 'export-failure' : '');
  }
}

async function persistStructuredDatatables(page, datatables, docPlan, bookPlan, options = {}) {
  if ((options.datatableExportMode || 'structured-first') !== 'structured-first') {
    return [];
  }
  if (!Array.isArray(datatables) || datatables.length === 0) {
    return [];
  }

  const documentDir = ensureDir(path.join(bookPlan.assets.datatables, buildDatatableDocumentDirName(bookPlan, docPlan)));
  const exported = [];

  for (const [index, datatable] of datatables.entries()) {
    const folderName = reserveAssetName(
      bookPlan,
      documentDir,
      sanitizeFileName(datatable.title || `datatable-${index + 1}`, `datatable-${index + 1}`),
    );
    const tableDir = ensureDir(path.join(documentDir, folderName));
    const files = writeDatatableSidecarFiles(datatable, tableDir);
    let hasSnapshotFallback = false;
    let snapshotCaptureError = '';
    if (!options.disableArtifactScreenshots) {
      try {
        await captureDatatableScreenshot(page, datatable.domId, files.pngPath);
        hasSnapshotFallback = fs.existsSync(files.pngPath);
      } catch (error) {
        removeIfExists(files.pngPath);
        snapshotCaptureError = errorToMessage(error);
      }
    }
    const obsidian = writeDatatableObsidianDatasetFiles(datatable, {
      docPlan,
      bookPlan,
      outputDir: options.contentOutputDir || options.outputDir || path.dirname(bookPlan.bookDir),
      datasetDirName: folderName,
      datasetIndex: index,
      sidecarFiles: files,
    });

    exported.push({
      ...datatable,
      title: datatable.title || `数据表 ${index + 1}`,
      files,
      obsidian,
      structuredSuccessRate: calculateDatatableStructuredSuccessRate(datatable),
      hasSnapshotFallback,
      snapshotCaptureError,
    });
  }

  return exported;
}

function buildDatatableDocumentDirName(bookPlan, docPlan) {
  const relativeDocPath = path.relative(bookPlan.bookDir, docPlan.targetMdPath);
  return sanitizeFileName(relativeDocPath.replace(/\.md$/i, '').replace(/[\\/]+/g, '__'));
}

async function captureDatatableScreenshot(page, domId, targetPath) {
  const selector = domId ? `[${DATATABLE_DOM_ID_ATTR}="${domId}"]` : '';
  const handle = selector ? await page.$(selector) : null;
  return await captureElementScreenshot(page, handle, targetPath);
}

export function writeDatatableSidecarFiles(datatable, tableDir) {
  ensureDir(tableDir);
  const files = {
    dir: tableDir,
    csvPath: path.join(tableDir, 'table.csv'),
    rowsJsonPath: path.join(tableDir, 'table.rows.json'),
    schemaJsonPath: path.join(tableDir, 'table.schema.json'),
    htmlPath: path.join(tableDir, 'table.html'),
    pngPath: path.join(tableDir, 'table.png'),
    imagesDir: ensureDir(path.join(tableDir, 'images')),
  };

  fs.writeFileSync(files.csvPath, datatableToCsv(datatable), 'utf8');
  writeJson(files.rowsJsonPath, buildDatatableRowsPayload(datatable));
  writeJson(files.schemaJsonPath, buildDatatableSchemaPayload(datatable));
  fs.writeFileSync(files.htmlPath, buildDatatableHtmlDocument(datatable), 'utf8');
  return files;
}

export function writeDatatableObsidianDatasetFiles(datatable, context) {
  const {
    docPlan,
    bookPlan,
    outputDir,
    datasetDirName,
    datasetIndex = 0,
    sidecarFiles,
    primaryBasePath = '',
    linkRoot = '',
  } = context;
  const datasetRoot = ensureDir(
    path.join(
      path.dirname(docPlan.targetMdPath),
      '_datasets',
      sanitizeFileName(path.basename(docPlan.targetMdPath, '.md')),
      datasetDirName,
    ),
  );
  const recordsDir = path.join(datasetRoot, 'records');
  const tempRecordsDir = ensureDir(buildUniqueDatatableRecordsDirPath(datasetRoot, '.records-writing-'));
  const datasetId = buildDatatableDatasetId(bookPlan, docPlan, datasetDirName, datasetIndex);
  const mappings = detectDatatableFieldMappings(datatable);
  let records = [];
  try {
    records = buildDatatableRecordEntries(datatable, mappings, {
      datasetId,
      datasetTitle: datatable.title || `数据表 ${datasetIndex + 1}`,
      sourceSystem: 'yuque',
      sourceUrl: docPlan.absoluteDocUrl,
      outputDir,
      datasetRoot,
      recordsDir: tempRecordsDir,
      linkRoot,
      coverFallbackPath: sidecarFiles?.pngPath || '',
    });

    for (const record of records) {
      fs.writeFileSync(record.mdPath, record.markdown, 'utf8');
      writeJson(record.dataJsonPath, record.data);
    }

    const expectedRecordCount = Array.isArray(datatable.rows) ? datatable.rows.length : 0;
    if (records.length !== expectedRecordCount) {
      throw new Error(
        `Datatable record count mismatch: expected ${expectedRecordCount}, generated ${records.length}.`,
      );
    }

    promoteDatatableRecordsDir(tempRecordsDir, recordsDir);
    records = records.map((record) => remapDatatableRecordPaths(record, tempRecordsDir, recordsDir));
  } catch (error) {
    throw error;
  }

  const datasetSchema = buildObsidianDatasetSchema(datatable, mappings, {
    datasetId,
    sourceSystem: 'yuque',
    sourceUrl: docPlan.absoluteDocUrl,
    sourceTable: datatable.title || '',
  });
  const viewManifest = buildDatatableViewManifest(datatable, mappings, {
    datasetId,
    sourceSystem: 'yuque',
    sourceUrl: docPlan.absoluteDocUrl,
    datasetRoot,
  });
  const datasetBase = buildObsidianBaseFile({
    datasetId,
    title: datatable.title || `数据表 ${datasetIndex + 1}`,
    properties: viewManifest.properties,
    views: viewManifest.views,
    recordsFolderExpression: 'this.file.folder + "/records"',
  });

  const files = {
    rootDir: datasetRoot,
    recordsDir,
    basePath: path.join(datasetRoot, 'dataset.base'),
    primaryBasePath: primaryBasePath ? path.resolve(primaryBasePath) : '',
    schemaPath: path.join(datasetRoot, 'schema.json'),
    viewManifestPath: path.join(datasetRoot, 'view-manifest.json'),
    recordCount: records.length,
    records: records.map((record) => ({
      id: record.id,
      title: record.title,
      mdPath: record.mdPath,
      dataJsonPath: record.dataJsonPath,
    })),
  };
  writeJson(files.schemaPath, datasetSchema);
  writeJson(files.viewManifestPath, viewManifest);
  fs.writeFileSync(files.basePath, datasetBase, 'utf8');
  if (files.primaryBasePath && files.primaryBasePath !== files.basePath) {
    const primaryBase = buildObsidianBaseFile({
      datasetId,
      title: datatable.title || `数据表 ${datasetIndex + 1}`,
      properties: viewManifest.properties,
      views: viewManifest.views,
      recordsFolderExpression: buildBaseRecordsFolderExpression(files.primaryBasePath, recordsDir),
    });
    fs.writeFileSync(files.primaryBasePath, primaryBase, 'utf8');
  }

  return files;
}

function buildDatatableSchemaPayload(datatable) {
  const columns = getDatatableColumns(datatable);
  return {
    title: datatable.title || '',
    source: datatable.source || '',
    partial: Boolean(datatable.partial),
    structuredSuccessRate: calculateDatatableStructuredSuccessRate(datatable),
    columnCount: columns.length,
    rowCount: Array.isArray(datatable.rows) ? datatable.rows.length : 0,
    columns: columns.map((column, index) => ({
      key: column.key || `col_${index + 1}`,
      name: column.name || `Column ${index + 1}`,
      type: column.type || 'text',
      rawName: column.rawName || column.name || '',
      options: Array.isArray(column.options) ? column.options : [],
    })),
    structuredState: datatable.structuredState || {},
  };
}

function buildDatatableRowsPayload(datatable) {
  const columns = getDatatableColumns(datatable);
  const rows = Array.isArray(datatable.rows) ? datatable.rows : [];
  return {
    title: datatable.title || '',
    source: datatable.source || '',
    partial: Boolean(datatable.partial),
    columns,
    rows: rows.map((row, rowIndex) => ({
      index: row.index ?? rowIndex,
      values: Object.fromEntries(
        columns.map((column, columnIndex) => [column.key, serializeDatatableValue(getDatatableCellRawValue(row, column, columnIndex))]),
      ),
      cells: Array.isArray(row.cells)
        ? row.cells.map((cell, cellIndex) => ({
            columnKey: cell.columnKey || columns[cellIndex]?.key || `col_${cellIndex + 1}`,
            columnName: cell.columnName || columns[cellIndex]?.name || `Column ${cellIndex + 1}`,
            text: normalizeDatatableScalar(cell.text),
            html: String(cell.html ?? ''),
            kind: cell.kind || 'text',
            value: serializeDatatableValue(cell.value ?? cell.text ?? ''),
            raw: serializeDatatableValue(cell.raw ?? {}),
          }))
        : [],
    })),
  };
}

function buildDatatableDatasetId(bookPlan, docPlan, datasetDirName, datasetIndex) {
  const bookSlug = sanitizeFileName(bookPlan.book.slug || bookPlan.book.name || 'book');
  const docSlug = sanitizeFileName(path.basename(docPlan.targetMdPath, '.md') || docPlan.node.name || 'doc');
  const tableSlug = sanitizeFileName(datasetDirName || `datatable-${datasetIndex + 1}`);
  return `${bookSlug}__${docSlug}__${tableSlug}`.toLowerCase();
}

function detectDatatableFieldMappings(datatable) {
  const columns = getDatatableColumns(datatable);
  const rows = Array.isArray(datatable.rows) ? datatable.rows : [];
  const canonicalKeys = new Set();
  const propertyKeys = new Set([
    'dataset',
    'record_id',
    'source_system',
    'source_table',
    'source_url',
  ]);

  return columns.map((column, index) => {
    const inferred = inferCanonicalPropertyKey(column, index, rows);
    const canonicalKey = inferred && !canonicalKeys.has(inferred) ? inferred : '';
    if (canonicalKey) {
      canonicalKeys.add(canonicalKey);
    }
    return {
      ...column,
      index,
      displayName: column.name || `Column ${index + 1}`,
      propertyKey: allocateDatatablePropertyKey(column, index, canonicalKey, propertyKeys),
      canonicalKey: canonicalKey || '',
    };
  });
}

function allocateDatatablePropertyKey(column, index, canonicalKey, seen) {
  const baseKey =
    String(column?.name || '').trim() ||
    String(column?.rawName || '').trim() ||
    defaultCanonicalPropertyLabel(canonicalKey) ||
    `字段${index + 1}`;
  let nextKey = baseKey;
  let suffix = 2;
  while (seen.has(nextKey)) {
    nextKey = `${baseKey}_${suffix}`;
    suffix += 1;
  }
  seen.add(nextKey);
  return nextKey;
}

function defaultCanonicalPropertyLabel(canonicalKey) {
  const labels = {
    title: '标题',
    summary: '摘要',
    cover: '封面',
    stage: '阶段',
    status: '状态',
    tags: '标签',
    assignees: '成员',
    start: '开始',
    end: '结束',
    due: '截止',
    progress: '进度',
    sort: '排序',
    archived: '归档',
  };
  return labels[canonicalKey] || '';
}

function inferCanonicalPropertyKey(column, index, rows) {
  const normalizedName = String(column?.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

  const keywordMap = [
    ['title', ['title', 'name', '标题', '名称', '主题', '事项', '任务', '项目名称']],
    ['summary', ['summary', 'description', 'desc', '备注', '说明', '简介', '摘要', '内容']],
    ['status', ['status', '状态']],
    ['stage', ['stage', '阶段', '列', '泳道', '看板']],
    ['tags', ['tags', 'tag', '标签', '分类']],
    ['assignees', ['assignee', 'assignees', 'owner', 'owners', '负责人', '成员', '执行人', 'ownername']],
    ['cover', ['cover', 'image', 'images', 'photo', 'thumbnail', '封面', '图片', '图像', '画册']],
    ['start', ['start', 'startdate', '开始', '开始日期']],
    ['end', ['end', 'enddate', '结束', '结束日期']],
    ['due', ['due', 'duedate', '截止', '截止日期', '到期']],
    ['progress', ['progress', 'percent', '完成度', '进度']],
    ['sort', ['sort', 'order', '序号', '排序', '顺序']],
    ['archived', ['archived', 'archive', '归档', '已归档']],
  ];

  for (const [key, keywords] of keywordMap) {
    if (keywords.some((keyword) => normalizedName.includes(String(keyword).toLowerCase().replace(/\s+/g, '')))) {
      return key;
    }
  }

  if (index === 0) {
    return 'title';
  }

  const sampleValues = rows
    .slice(0, 5)
    .map((row) => getDatatableCellRawValue(row, column, index))
    .filter((value) => value != null && value !== '');
  const sampleHtml = rows
    .slice(0, 3)
    .map((row) => String(getDatatableCellHtml(row, column, index) || ''))
    .join(' ');
  if (sampleHtml && /<img[\s>]/i.test(sampleHtml)) {
    return 'cover';
  }
  if (sampleValues.some((value) => looksLikeImageReference(value))) {
    return 'cover';
  }

  return '';
}

function buildDatatableRecordEntries(datatable, mappings, context) {
  const rows = Array.isArray(datatable.rows) ? datatable.rows : [];
  const seenNames = new Set();
  return rows.map((row, index) =>
    buildDatatableRecordEntry(datatable, row, mappings, context, index, seenNames),
  );
}

function buildDatatableRecordEntry(datatable, row, mappings, context, rowIndex, seenNames) {
  const recordId = `${context.datasetId}-r${String(rowIndex + 1).padStart(4, '0')}`;
  const canonical = {};
  const originalValues = {};
  let coverSource = null;

  for (const mapping of mappings) {
    const rawValue = getDatatableCellRawValue(row, mapping, mapping.index);
    const htmlValue = getDatatableCellHtml(row, mapping, mapping.index);
    const frontmatterValue = toFrontmatterValue(rawValue, htmlValue, mapping);
    if (mapping.canonicalKey === 'cover' && coverSource == null) {
      coverSource = rawValue ?? htmlValue ?? frontmatterValue;
    }
    originalValues[mapping.propertyKey] = frontmatterValue;
    if (mapping.canonicalKey && canonical[mapping.canonicalKey] == null) {
      canonical[mapping.canonicalKey] = frontmatterValue;
    }
  }

  const title = selectRecordTitle(canonical, originalValues, rowIndex);
  const safeName = buildDatatableRecordFileName(title, rowIndex, seenNames);
  const recordDir = ensureDir(context.recordsDir || path.join(context.datasetRoot, 'records'));
  const finalMdPath = path.join(recordDir, safeName);
  const dataJsonPath = finalMdPath.replace(/\.md$/i, '.data.json');

  const coverLink = resolveRecordCoverLink(coverSource ?? canonical.cover, {
    fromPath: finalMdPath,
    linkRoot: context.linkRoot,
    fallbackPath: context.coverFallbackPath,
  });
  const noteFrontmatter = {
    dataset: context.datasetId,
    record_id: recordId,
    source_system: context.sourceSystem,
    source_table: context.datasetTitle,
    title,
    source_url: context.sourceUrl,
    cover: coverLink,
    summary: canonical.summary || '',
    status: canonical.status || '',
    stage: canonical.stage || canonical.status || '',
    tags: normalizePropertyList(canonical.tags),
    assignees: normalizePropertyList(canonical.assignees),
    start: normalizePropertyScalar(canonical.start, 'date'),
    end: normalizePropertyScalar(canonical.end, 'date'),
    due: normalizePropertyScalar(canonical.due, 'date'),
    progress: normalizePropertyScalar(canonical.progress, 'number'),
    sort: normalizePropertyScalar(canonical.sort, 'number'),
    archived: normalizePropertyScalar(canonical.archived, 'boolean'),
  };

  for (const mapping of mappings) {
    noteFrontmatter[mapping.propertyKey] = toStoredDatatableNotePropertyValue(originalValues[mapping.propertyKey], mapping, {
      fromPath: finalMdPath,
      linkRoot: context.linkRoot,
      fallbackPath: context.coverFallbackPath,
    });
  }

  const markdown = buildDatatableRecordMarkdown({
    title,
    frontmatter: noteFrontmatter,
    sourceUrl: context.sourceUrl,
    datasetTitle: context.datasetTitle,
    rowIndex,
    dataJsonPath,
    recordMdPath: finalMdPath,
    linkRoot: context.linkRoot,
    mappings,
    originalValues,
  });

  return {
    id: recordId,
    title,
    mdPath: finalMdPath,
    dataJsonPath,
    markdown,
    data: {
      version: DATATABLE_DATASET_VERSION,
      dataset: context.datasetId,
      record_id: recordId,
      rowIndex,
      title,
      source_system: context.sourceSystem,
      source_table: context.datasetTitle,
      source_url: context.sourceUrl,
      canonical,
      values: originalValues,
      row,
    },
  };
}

function buildDatatableRecordMarkdown({
  title,
  frontmatter,
  sourceUrl,
  datasetTitle,
  rowIndex,
  dataJsonPath,
  recordMdPath,
  linkRoot,
  mappings,
  originalValues,
}) {
  const fields = mappings
    .map((mapping) => {
      const value = originalValues[mapping.propertyKey];
      const rendered = renderValueForMarkdown(value, {
        fromPath: recordMdPath,
        linkRoot,
      });
      return rendered ? `- ${mapping.displayName}: ${rendered}` : '';
    })
    .filter(Boolean)
    .join('\n');

  let output = `${buildFrontmatter(frontmatter)}\n`;
  output += `# ${title}\n\n`;
  output += `- 数据集: ${datasetTitle}\n`;
  output += `- 原始行号: ${rowIndex + 1}\n`;
  output += `- 源地址: ${sourceUrl}\n`;
  output += `- 数据 JSON: [查看完整记录](${relativeMarkdownPath(recordMdPath, dataJsonPath)})\n`;
  if (fields) {
    output += `\n## 字段\n\n${fields}\n`;
  }
  return output.trimEnd() + '\n';
}

function buildFrontmatter(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    lines.push(...serializeFrontmatterEntry(key, value));
  }
  lines.push('---');
  return lines.join('\n');
}

function serializeFrontmatterEntry(key, value) {
  const renderedKey = serializeYamlKey(key);
  if (Array.isArray(value)) {
    return [`${renderedKey}:`, ...value.map((item) => `  - ${serializeYamlScalar(item)}`)];
  }
  return [`${renderedKey}: ${serializeYamlScalar(value)}`];
}

function serializeYamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function serializeYamlKey(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderValueForMarkdown(value, context = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => renderValueForMarkdown(item, context)).filter(Boolean).join('，');
  }
  if (value == null || value === '') {
    return '';
  }

  const assetReference = resolveRecordAssetReference(value, context);
  if (assetReference) {
    return assetReference.kind === 'local'
      ? `[[${assetReference.value}]]`
      : `[${assetReference.value}](${assetReference.value})`;
  }

  if (value && typeof value === 'object') {
    return normalizeDatatableScalar(value);
  }

  const text = String(value);
  if (/^https?:\/\//i.test(text)) {
    return `[${text}](${text})`;
  }
  return text;
}

function resolveRecordCoverLink(value, context) {
  const directReference = resolveRecordAssetReference(value, context);
  if (directReference) {
    return directReference.kind === 'local'
      ? `[[${directReference.value}]]`
      : directReference.value;
  }

  const fallbackReference = resolveRecordAssetReference(context.fallbackPath, context);
  if (!fallbackReference) {
    return '';
  }
  return fallbackReference.kind === 'local'
    ? `[[${fallbackReference.value}]]`
    : fallbackReference.value;
}

function toStoredDatatableNotePropertyValue(value, mapping, context = {}) {
  if (mapping?.type === 'image' || mapping?.canonicalKey === 'cover') {
    const values = Array.isArray(value) ? value : [value];
    const references = values
      .map((item) => resolveRecordCoverLink(item, context))
      .filter(Boolean);
    if (references.length === 0) {
      return '';
    }
    return references.length === 1 ? references[0] : references;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeDatatableScalar(item)).filter(Boolean);
  }

  if (value && typeof value === 'object') {
    const assetReference = resolveRecordAssetReference(value, context);
    if (assetReference) {
      return assetReference.kind === 'local'
        ? `[[${assetReference.value}]]`
        : assetReference.value;
    }
    return normalizeDatatableScalar(value);
  }

  return value;
}

function normalizePropertyList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDatatableScalar(item)).filter(Boolean);
  }
  if (value == null || value === '') {
    return [];
  }
  return String(value)
    .split(/[;,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePropertyScalar(value, kind) {
  if (value == null || value === '') {
    return kind === 'boolean' ? false : '';
  }
  if (kind === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    const text = String(value).trim().toLowerCase();
    return ['true', '1', 'yes', 'y', '已归档', '归档', 'done'].includes(text);
  }
  if (kind === 'number') {
    if (typeof value === 'number') {
      return value;
    }
    const match = String(value).match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : '';
  }
  if (kind === 'date') {
    const text = String(value).trim();
    return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text) ? text.replace(/\//g, '-') : text;
  }
  return value;
}

function selectRecordTitle(canonical, originalValues, rowIndex) {
  const candidates = [
    canonical.title,
    ...Object.values(originalValues),
  ];
  for (const candidate of candidates) {
    const rendered = renderValueForMarkdown(candidate);
    if (rendered) {
      return rendered;
    }
  }
  return `记录 ${rowIndex + 1}`;
}

function buildDatatableRecordFileName(title, rowIndex, seenNames) {
  const prefix = String(rowIndex + 1).padStart(3, '0');
  const sanitizedTitle = sanitizeFileName(title, `record-${rowIndex + 1}`);
  const truncatedTitle = truncateDatatableRecordFileStem(sanitizedTitle, 80);
  return uniqueName(`${prefix}-${truncatedTitle}.md`, seenNames);
}

function truncateDatatableRecordFileStem(value, maxLength = 80) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return 'record';
  }
  return normalized.length > maxLength ? normalized.slice(0, maxLength).trim() || normalized.slice(0, maxLength) : normalized;
}

function toFrontmatterValue(rawValue, htmlValue, mapping) {
  if (mapping.canonicalKey === 'cover') {
    return resolveImageReferenceCandidate(rawValue) || extractImageReference(rawValue, htmlValue) || normalizeDatatableScalar(rawValue);
  }
  if (mapping.canonicalKey === 'tags' || mapping.canonicalKey === 'assignees') {
    const list = normalizePropertyList(rawValue);
    return list.length > 0 ? list : normalizeDatatableScalar(rawValue);
  }
  if (Array.isArray(rawValue)) {
    return rawValue.map((item) => normalizeDatatableScalar(item)).filter(Boolean);
  }
  return normalizeDatatableScalar(rawValue);
}

function getDatatableCellRawValue(row, column, index) {
  if (row?.values && column?.key in row.values) {
    return row.values[column.key];
  }
  const cell =
    row?.cells?.find?.((item) => item?.columnKey === column?.key) ||
    row?.cells?.[index];
  return cell?.value ?? cell?.text ?? '';
}

function getDatatableCellHtml(row, column, index) {
  const cell =
    row?.cells?.find?.((item) => item?.columnKey === column?.key) ||
    row?.cells?.[index];
  return cell?.html ?? '';
}

function looksLikeImageReference(value) {
  return Boolean(resolveRecordAssetReference(value));
}

function extractImageReference(rawValue, htmlValue) {
  const candidate = resolveImageReferenceCandidate(rawValue);
  if (candidate) {
    return normalizeDatatableScalar(candidate);
  }
  const html = String(htmlValue || '');
  const imageMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imageMatch?.[1] || '';
}

function resolveRecordAssetReference(value, context = {}) {
  const candidate = resolveImageReferenceCandidate(value);
  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    if (/^https?:\/\//i.test(candidate)) {
      return { kind: 'url', value: candidate };
    }
    const localReference = resolveLocalAssetReferencePath(candidate, context);
    if (localReference) {
      return {
        kind: 'local',
        value: localReference,
      };
    }
    return null;
  }

  const localReference = resolveLocalAssetReferencePath(candidate.localPath, context);
  if (localReference) {
    return {
      kind: 'local',
      value: localReference,
    };
  }

  const sourceUrl = String(candidate.sourceUrl || candidate.src || candidate.url || '').trim();
  if (/^https?:\/\//i.test(sourceUrl)) {
    return { kind: 'url', value: sourceUrl };
  }

  return null;
}

function resolveLocalAssetReferencePath(candidatePath, context = {}) {
  const absolutePath = String(candidatePath || '').trim();
  if (!absolutePath || !path.isAbsolute(absolutePath)) {
    return '';
  }

  const linkRoot = String(context.linkRoot || '').trim();
  if (linkRoot) {
    const relativeToRoot = toPosixPath(path.relative(path.resolve(linkRoot), absolutePath));
    if (relativeToRoot && relativeToRoot !== '.' && !relativeToRoot.startsWith('../')) {
      return relativeToRoot;
    }
  }

  if (!context.fromPath) {
    return '';
  }

  return toPosixPath(path.relative(path.dirname(context.fromPath), absolutePath));
}

function resolveImageReferenceCandidate(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = resolveImageReferenceCandidate(item);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return isImageLikePath(trimmed) ? trimmed : null;
  }

  if (typeof value === 'object') {
    if (value.localPath || value.localRelativePath || value.sourceUrl || value.src || value.url) {
      return value;
    }
  }

  return null;
}

function isImageLikePath(value) {
  const text = String(value || '').trim();
  return /^(?:https?:\/\/[^?#]+\.(?:png|jpg|jpeg|gif|webp|svg)|[A-Za-z]:[\\/].+\.(?:png|jpg|jpeg|gif|webp|svg)|\.{0,2}[\\/].+\.(?:png|jpg|jpeg|gif|webp|svg)|[^?#]+\.(?:png|jpg|jpeg|gif|webp|svg))(?:[?#].*)?$/i.test(text);
}

function buildObsidianDatasetSchema(datatable, mappings, context) {
  return {
    version: DATATABLE_DATASET_VERSION,
    datasetId: context.datasetId,
    sourceSystem: context.sourceSystem,
    sourceTable: context.sourceTable,
    sourceUrl: context.sourceUrl,
    titleProperty: 'title',
    coverProperty: 'cover',
    boardProperty: 'stage',
    boardFallbackProperty: 'status',
    columns: mappings.map((mapping) => ({
      key: mapping.propertyKey,
      displayName: mapping.displayName,
      canonicalKey: mapping.canonicalKey || '',
      sourceColumnKey: mapping.key,
      sourceColumnType: mapping.type || 'text',
    })),
    rowCount: Array.isArray(datatable.rows) ? datatable.rows.length : 0,
    partial: Boolean(datatable.partial),
    structuredSuccessRate: calculateDatatableStructuredSuccessRate(datatable),
  };
}

function buildDatatableViewManifest(datatable, mappings, context) {
  const properties = buildDatasetPropertyDescriptors(mappings);
  const propertyKeys = new Set(properties.map((property) => property.key));
  const tableOrder = resolveDatatableViewOrder(
    datatable?.tableView?.orderedColumnIds,
    mappings,
    propertyKeys,
    mappings.map((mapping) => mapping.propertyKey),
  );
  const titleProperty = resolveCanonicalMappingPropertyKey(mappings, 'title') || 'title';
  const statusProperty = resolveCanonicalMappingPropertyKey(mappings, 'status') || 'status';
  const stageProperty = resolveCanonicalMappingPropertyKey(mappings, 'stage') || 'stage';
  const summaryProperty = resolveCanonicalMappingPropertyKey(mappings, 'summary') || 'summary';
  const tagsProperty = resolveCanonicalMappingPropertyKey(mappings, 'tags') || 'tags';
  const assigneesProperty = resolveCanonicalMappingPropertyKey(mappings, 'assignees') || 'assignees';
  const dueProperty = resolveCanonicalMappingPropertyKey(mappings, 'due') || 'due';
  const coverProperty = resolveDatatableCoverProperty(datatable, mappings) || 'cover';
  const explicitCardOrder = resolveDatatableViewOrder(datatable?.cardView?.visibleColumnIds, mappings, propertyKeys);
  const fallbackCardOrder = [
    titleProperty,
    summaryProperty,
    stageProperty,
    statusProperty,
    tagsProperty,
    assigneesProperty,
    dueProperty,
  ].filter((propertyKey, index, items) => propertyKeys.has(propertyKey) && items.indexOf(propertyKey) === index);
  const cardSourceOrder = explicitCardOrder.length > 0
    ? explicitCardOrder
    : tableOrder.length > 0
      ? tableOrder
      : fallbackCardOrder;
  const cardOrder = prependMissingPropertyKeys(
    stripCardImageProperty(cardSourceOrder, coverProperty, explicitCardOrder),
    [titleProperty],
    propertyKeys,
  );
  const listOrder = prependMissingPropertyKeys(
    tableOrder.length > 0
      ? tableOrder
      : explicitCardOrder.length > 0
        ? explicitCardOrder
        : fallbackCardOrder,
    [titleProperty],
    propertyKeys,
  );
  const orderedViews = orderDatatableBaseViews(
    [
      {
        type: 'table',
        name: datatable?.tableView?.name || '表格视图',
        order: tableOrder,
      },
      {
        type: 'cards',
        name: datatable?.cardView?.name || '卡片视图',
        order: cardOrder,
        image: coverProperty,
        imageFit: resolveDatatableCardImageFit(datatable?.cardView),
        imageAspectRatio: resolveDatatableCardImageAspectRatio(datatable?.cardView),
        cardSize: resolveDatatableCardSize(datatable?.cardView),
      },
      {
        type: 'list',
        name: '列表视图',
        order: listOrder,
      },
    ],
    datatable,
  );

  return {
    version: DATATABLE_DATASET_VERSION,
    datasetId: context.datasetId,
    sourceSystem: context.sourceSystem,
    sourceTable: datatable.title || '',
    sourceUrl: context.sourceUrl,
    titleProperty,
    coverProperty,
    boardProperty: stageProperty,
    boardFallbackProperty: statusProperty,
    recommendedPlugins: [
      { id: 'core:bases', required: true, purpose: 'table,cards,list' },
      { id: 'base-board', required: false, purpose: 'board' },
    ],
    defaultViews: orderedViews.map((view) => view.name),
    properties,
    views: orderedViews,
    sourceViews: Array.isArray(datatable?.views) ? datatable.views : [],
    activeViewId: datatable?.activeViewId || '',
    defaultViewId: datatable?.defaultViewId || '',
  };
}

function buildDatasetPropertyDescriptors(mappings) {
  const canonicalOrder = ['title', 'summary', 'cover', 'stage', 'status', 'tags', 'assignees', 'start', 'end', 'due', 'progress', 'sort', 'archived'];
  const canonicalDisplayNames = new Map([
    ['title', '标题'],
    ['summary', '摘要'],
    ['cover', '封面'],
    ['stage', '阶段'],
    ['status', '状态'],
    ['tags', '标签'],
    ['assignees', '成员'],
    ['start', '开始'],
    ['end', '结束'],
    ['due', '截止'],
    ['progress', '进度'],
    ['sort', '排序'],
    ['archived', '归档'],
  ]);
  const mappedDisplayNames = new Map(
    mappings
      .filter((mapping) => mapping.canonicalKey)
      .map((mapping) => [mapping.canonicalKey, mapping.displayName]),
  );
  const items = [
    { key: 'title', displayName: mappedDisplayNames.get('title') || canonicalDisplayNames.get('title'), type: 'text', canonical: true },
    { key: 'summary', displayName: mappedDisplayNames.get('summary') || canonicalDisplayNames.get('summary'), type: 'text', canonical: true },
    { key: 'cover', displayName: mappedDisplayNames.get('cover') || canonicalDisplayNames.get('cover'), type: 'text', canonical: true },
    { key: 'stage', displayName: mappedDisplayNames.get('stage') || canonicalDisplayNames.get('stage'), type: 'text', canonical: true },
    { key: 'status', displayName: mappedDisplayNames.get('status') || canonicalDisplayNames.get('status'), type: 'text', canonical: true },
    { key: 'tags', displayName: mappedDisplayNames.get('tags') || canonicalDisplayNames.get('tags'), type: 'list', canonical: true },
    { key: 'assignees', displayName: mappedDisplayNames.get('assignees') || canonicalDisplayNames.get('assignees'), type: 'list', canonical: true },
    { key: 'start', displayName: mappedDisplayNames.get('start') || canonicalDisplayNames.get('start'), type: 'date', canonical: true },
    { key: 'end', displayName: mappedDisplayNames.get('end') || canonicalDisplayNames.get('end'), type: 'date', canonical: true },
    { key: 'due', displayName: mappedDisplayNames.get('due') || canonicalDisplayNames.get('due'), type: 'date', canonical: true },
    { key: 'progress', displayName: mappedDisplayNames.get('progress') || canonicalDisplayNames.get('progress'), type: 'number', canonical: true },
    { key: 'sort', displayName: mappedDisplayNames.get('sort') || canonicalDisplayNames.get('sort'), type: 'number', canonical: true },
    { key: 'archived', displayName: mappedDisplayNames.get('archived') || canonicalDisplayNames.get('archived'), type: 'boolean', canonical: true },
  ];
  const seen = new Set(items.map((item) => item.key));

  for (const mapping of mappings) {
    if (seen.has(mapping.propertyKey)) {
      continue;
    }
    items.push({
      key: mapping.propertyKey,
      displayName: mapping.displayName,
      type: resolveDatatablePropertyType(mapping),
      canonical: false,
    });
    seen.add(mapping.propertyKey);
  }

  items.sort((left, right) => {
    const leftIndex = canonicalOrder.indexOf(left.key);
    const rightIndex = canonicalOrder.indexOf(right.key);
    if (leftIndex === -1 && rightIndex === -1) {
      return left.displayName.localeCompare(right.displayName);
    }
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  });

  return items;
}

function buildObsidianBaseFile({ datasetId, title, properties, views = [], recordsFolderExpression = 'this.file.folder + "/records"' }) {
  const propertyOrder = properties.map((property) => property.key);
  const normalizedViews = Array.isArray(views) && views.length > 0
    ? views
    : [
        { type: 'table', name: '表格视图', order: propertyOrder },
        { type: 'cards', name: '卡片视图', order: propertyOrder.filter((key) => ['title', 'summary', 'stage', 'status', 'tags', 'assignees', 'due'].includes(key)), image: 'cover', imageFit: 'cover', imageAspectRatio: '1.5', cardSize: 260 },
        { type: 'list', name: '列表视图', order: propertyOrder.filter((key) => ['title', 'summary', 'stage', 'status', 'tags'].includes(key)) },
      ];
  const displayNames = Object.fromEntries(properties.map((property) => [property.key, property.displayName]));
  const lines = [
    `filters:`,
    `  and:`,
    `    - file.ext == "md"`,
    `    - file.inFolder(${recordsFolderExpression})`,
    `    - dataset == "${datasetId}"`,
    `properties:`,
  ];

  for (const property of properties) {
    lines.push(`  ${serializeYamlKey(property.key)}:`);
    lines.push(`    displayName: "${escapeBaseString(displayNames[property.key])}"`);
  }

  lines.push(`views:`);
  for (const view of normalizedViews) {
    const order = Array.isArray(view.order) && view.order.length > 0 ? view.order : propertyOrder;
    lines.push(`  - type: ${view.type}`);
    lines.push(`    name: "${escapeBaseString(view.name || view.type)}"`);
    lines.push(`    order:`);
    for (const key of order) {
      lines.push(`      - ${serializeYamlScalar(key)}`);
    }
    if (view.image) {
      lines.push(`    image: ${serializeYamlScalar(view.image)}`);
    }
    if (view.imageFit) {
      lines.push(`    imageFit: ${view.imageFit}`);
    }
    if (view.imageAspectRatio) {
      lines.push(`    imageAspectRatio: "${escapeBaseString(view.imageAspectRatio)}"`);
    }
    if (view.cardSize != null) {
      lines.push(`    cardSize: ${Number(view.cardSize)}`);
    }
  }
  return lines.join('\n') + '\n';
}

function resolveDatatablePropertyType(mapping = {}) {
  if (mapping.canonicalKey === 'tags' || mapping.canonicalKey === 'assignees') {
    return 'list';
  }

  switch (String(mapping.type || '').trim().toLowerCase()) {
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'checkbox':
    case 'boolean':
      return 'boolean';
    default:
      return 'text';
  }
}

function resolveCanonicalMappingPropertyKey(mappings, canonicalKey) {
  return mappings.find((mapping) => mapping.canonicalKey === canonicalKey)?.propertyKey || '';
}

function resolveDatatableCoverProperty(datatable, mappings) {
  const cardCoverId = String(datatable?.cardView?.coverColumnId || '').trim();
  if (cardCoverId) {
    const mapped = mappings.find((mapping) => mapping.id === cardCoverId);
    if (mapped?.propertyKey) {
      return mapped.propertyKey;
    }
  }

  return resolveCanonicalMappingPropertyKey(mappings, 'cover') || '';
}

function resolveDatatableViewOrder(columnIds, mappings, propertyKeys, fallbackOrder = []) {
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  const ordered = [];

  for (const columnId of columnIds || []) {
    const propertyKey = mappingById.get(columnId)?.propertyKey;
    if (propertyKey && propertyKeys.has(propertyKey) && !ordered.includes(propertyKey)) {
      ordered.push(propertyKey);
    }
  }

  for (const propertyKey of fallbackOrder || []) {
    if (propertyKey && propertyKeys.has(propertyKey) && !ordered.includes(propertyKey)) {
      ordered.push(propertyKey);
    }
  }

  return ordered;
}

function prependMissingPropertyKeys(order, preferredKeys, propertyKeys) {
  const normalized = Array.isArray(order) ? [...order] : [];
  const prefix = [];

  for (const propertyKey of preferredKeys || []) {
    if (!propertyKey || !propertyKeys.has(propertyKey) || normalized.includes(propertyKey)) {
      continue;
    }
    prefix.push(propertyKey);
  }

  return [...prefix, ...normalized];
}

function stripCardImageProperty(order, coverProperty, explicitCardOrder = []) {
  if (!coverProperty) {
    return Array.isArray(order) ? [...order] : [];
  }

  if (Array.isArray(explicitCardOrder) && explicitCardOrder.includes(coverProperty)) {
    return Array.isArray(order) ? [...order] : [];
  }

  return (order || []).filter((propertyKey) => propertyKey !== coverProperty);
}

function orderDatatableBaseViews(views, datatable) {
  const preferredType = String(datatable?.activeView?.type || datatable?.defaultView?.type || 'GRID')
    .trim()
    .toUpperCase();
  const preferredViewType = preferredType === 'CARD' ? 'cards' : 'table';
  const orderedTypes = [preferredViewType, 'table', 'cards', 'list'];
  const orderedViews = [];
  const seen = new Set();

  for (const type of orderedTypes) {
    const view = views.find((item) => item.type === type);
    if (!view || seen.has(type)) {
      continue;
    }
    orderedViews.push(view);
    seen.add(type);
  }

  for (const view of views) {
    if (seen.has(view.type)) {
      continue;
    }
    orderedViews.push(view);
    seen.add(view.type);
  }

  return orderedViews;
}

function resolveDatatableCardImageFit(cardView = {}) {
  return String(cardView?.coverDisplay || '').trim().toLowerCase() === 'fit' ? 'contain' : 'cover';
}

function resolveDatatableCardImageAspectRatio(cardView = {}) {
  return '1.5';
}

function resolveDatatableCardSize(cardView = {}) {
  return 260;
}

function buildBaseRecordsFolderExpression(basePath, recordsDir) {
  const relativePath = toPosixPath(path.relative(path.dirname(basePath), recordsDir));
  if (!relativePath || relativePath === '.') {
    return 'this.file.folder';
  }
  return `this.file.folder + "/${escapeBaseString(relativePath)}"`;
}

function escapeBaseString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildDatatableHtmlDocument(datatable) {
  const title = escapeHtml(datatable.title || '语雀数据表导出');
  const body = datatable.html || buildStructuredDatatableHtmlFragment(datatable);
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${title}</title>`,
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <style>',
    '    body { font-family: "Segoe UI", "PingFang SC", sans-serif; margin: 24px; color: #1f2937; background: #ffffff; }',
    '    main { max-width: 1280px; margin: 0 auto; }',
    '    h1 { font-size: 20px; margin-bottom: 16px; }',
    '    table { border-collapse: collapse; width: 100%; }',
    '    th, td { border: 1px solid #d1d5db; padding: 8px 10px; vertical-align: top; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    `    <h1>${title}</h1>`,
    `    ${body}`,
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function buildStructuredDatatableHtmlFragment(datatable) {
  const columns = getDatatableColumns(datatable);
  const rows = Array.isArray(datatable.rows) ? datatable.rows : [];
  if (columns.length === 0) {
    return '<p>未能提取到可用的 HTML 结构。</p>';
  }

  const header = `<tr>${columns.map((column) => `<th>${escapeHtml(column.name)}</th>`).join('')}</tr>`;
  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((column, index) => `<td>${getDatatableCellHtml(row, column, index) || escapeHtml(getDatatableCellText(row, column, index))}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<table>${header}${bodyRows}</table>`;
}

export function datatableToCsv(datatable) {
  const columns = getDatatableColumns(datatable);
  const rows = Array.isArray(datatable.rows) ? datatable.rows : [];
  const lines = [
    columns.map((column) => escapeCsv(column.name || column.key || '')).join(','),
    ...rows.map((row) =>
      columns
        .map((column, index) => escapeCsv(getDatatableCellText(row, column, index)))
        .join(','),
    ),
  ];
  return `\ufeff${lines.join('\n')}\n`;
}

function calculateDatatableStructuredSuccessRate(datatable) {
  const columnCount = getDatatableColumns(datatable).length;
  const rowCount = Array.isArray(datatable.rows) ? datatable.rows.length : 0;
  if (columnCount > 0 && rowCount > 0) {
    return datatable.partial ? 0.75 : 1;
  }
  if (columnCount > 0 || rowCount > 0) {
    return 0.5;
  }
  return 0;
}

function getDatatableColumns(datatable) {
  const columns = Array.isArray(datatable.columns) ? datatable.columns.filter(Boolean) : [];
  if (columns.length > 0) {
    return columns.map((column, index) => ({
      key: column.key || `col_${index + 1}`,
      name: column.name || `Column ${index + 1}`,
      type: column.type || 'text',
      rawName: column.rawName || column.name || '',
      options: Array.isArray(column.options) ? column.options : [],
    }));
  }

  const rowLength = Math.max(
    0,
    ...(Array.isArray(datatable.rows) ? datatable.rows : []).map((row) => (Array.isArray(row.cells) ? row.cells.length : 0)),
  );
  return Array.from({ length: rowLength }, (_, index) => ({
    key: `col_${index + 1}`,
    name: `Column ${index + 1}`,
    type: 'text',
    rawName: '',
    options: [],
  }));
}

function getDatatableCellText(row, column, index) {
  if (row?.values && column?.key in row.values) {
    return normalizeDatatableScalar(row.values[column.key]);
  }

  const cell =
    row?.cells?.find?.((item) => item?.columnKey === column?.key) ||
    row?.cells?.[index] || {
      text: '',
    };
  return normalizeDatatableScalar(cell?.text ?? '');
}

function normalizeDatatableScalar(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDatatableScalar(item)).filter(Boolean).join('; ');
  }
  if (value && typeof value === 'object') {
    if ('localRelativePath' in value && value.localRelativePath) {
      return String(value.localRelativePath);
    }
    if ('localPath' in value && value.localPath) {
      return String(value.localPath);
    }
    if ('sourceUrl' in value && value.sourceUrl) {
      return String(value.sourceUrl);
    }
    if ('url' in value && value.url) {
      return String(value.url);
    }
    if ('src' in value && value.src) {
      return String(value.src);
    }
    if ('name' in value && value.name) {
      return String(value.name);
    }
    if ('text' in value && value.text) {
      return String(value.text);
    }
    return JSON.stringify(value);
  }
  return stripHtml(String(value ?? '')).replace(/\r/g, '').replace(/\n+/g, ' ').trim();
}

function serializeDatatableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => serializeDatatableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, serializeDatatableValue(nestedValue)]),
    );
  }
  return value;
}

function injectDatatablesIntoMarkdown(markdown, datatables, targetMdPath) {
  if (!markdown || !Array.isArray(datatables) || datatables.length === 0) {
    return { markdown, insertedCount: 0, insertedDatatableIndexes: [] };
  }

  return injectDatatablesIntoMarkdownBySlots(markdown, datatables, targetMdPath, []);
}

function injectDatatablesIntoMarkdownBySlots(markdown, datatables, targetMdPath, cardSlots = []) {
  if (!markdown || !Array.isArray(datatables) || datatables.length === 0) {
    return { markdown, insertedCount: 0, insertedDatatableIndexes: [] };
  }

  const normalizedSlots = normalizeCardSlots(cardSlots);
  if (normalizedSlots.length > 0) {
    let placeholderIndex = 0;
    let insertedCount = 0;
    const insertedDatatableIndexes = [];
    return {
      markdown: markdown.replace(GENERIC_CARD_PLACEHOLDER_RE, (match) => {
        const slot = normalizedSlots[placeholderIndex];
        placeholderIndex += 1;
        if (!slot || slot.kind !== 'datatable' || slot.datatableIndex < 0) {
          return match;
        }
        const datatable = datatables[slot.datatableIndex];
        if (!datatable) {
          return match;
        }
        insertedCount += 1;
        insertedDatatableIndexes.push(slot.datatableIndex);
        return renderDatatableMarkdownSection(datatable, targetMdPath, { index: slot.datatableIndex, inline: true });
      }),
      insertedCount,
      insertedDatatableIndexes,
    };
  }

  const matches = [...markdown.matchAll(GENERIC_CARD_PLACEHOLDER_RE)];
  if (matches.length === 0 || matches.length !== datatables.length) {
    return { markdown, insertedCount: 0, insertedDatatableIndexes: [] };
  }

  let insertedCount = 0;
  return {
    markdown: markdown.replace(GENERIC_CARD_PLACEHOLDER_RE, () => {
      const datatable = datatables[insertedCount];
      insertedCount += 1;
      return renderDatatableMarkdownSection(datatable, targetMdPath, { index: insertedCount - 1, inline: true });
    }),
    insertedCount,
    insertedDatatableIndexes: Array.from({ length: insertedCount }, (_, index) => index),
  };
}

function renderDatatableMarkdownSection(datatable, targetMdPath, options = {}) {
  if (options.inline !== false) {
    return renderInlineDatatableMarkdown(datatable, targetMdPath, options);
  }

  const headingLevel = options.headingLevel ?? 3;
  const title = datatable.title || `数据表 ${options.index != null ? options.index + 1 : 1}`;
  const inlineBody = renderInlineDatatableMarkdown(datatable, targetMdPath, {
    ...options,
    inline: true,
    includeTitle: false,
  });
  let output = `${'#'.repeat(headingLevel)} ${title}\n`;
  if (inlineBody) {
    output += `\n${inlineBody}\n`;
  }
  return output.trimEnd();
}

function renderInlineDatatableMarkdown(datatable, targetMdPath, options = {}) {
  const title = String(datatable?.title || `数据表 ${options.index != null ? options.index + 1 : 1}`).trim();
  const includeTitle = options.includeTitle === true || (!isGenericDatatableTitle(title) && options.inline !== false);
  const tableMarkdown = buildDatatableBodyMarkdown(datatable);
  const hasTableBody = Boolean(tableMarkdown);
  const hasPng = Boolean(datatable?.files?.pngPath);
  const shouldRenderSnapshot = hasPng && !hasTableBody;
  const linksSentence = buildDatatableLinkSentence(datatable, targetMdPath);
  const lines = [];

  if (includeTitle) {
    lines.push(`**${title}**`);
    lines.push('');
  }

  if (shouldRenderSnapshot) {
    lines.push(`![数据表快照](${relativeMarkdownPath(targetMdPath, datatable.files.pngPath)})`);
    lines.push('');
  } else if (hasTableBody) {
    lines.push(tableMarkdown);
    lines.push('');
  }

  if (datatable?.partial) {
    lines.push(`> 该数据表未完整结构化导出；完整内容请查看 ${linksSentence}。`);
  } else if (shouldRenderSnapshot) {
    lines.push(`> 该数据表当前以快照保留；完整内容请查看 ${linksSentence}。`);
  } else if (!hasTableBody && linksSentence) {
    lines.push(`> 该数据表已保留为附件文件；完整内容请查看 ${linksSentence}。`);
  }

  return lines.join('\n').trimEnd();
}

function buildDatatableBodyMarkdown(datatable) {
  const columns = getDatatableColumns(datatable);
  const rows = Array.isArray(datatable.rows) ? datatable.rows : [];
  if (columns.length === 0 || rows.length === 0) {
    return '';
  }

  const bodyRows = rows.map((row) => columns.map((column, index) => getDatatableCellText(row, column, index)));
  return tableToMarkdown([columns.map((column) => column.name), ...bodyRows]);
}

function isGenericDatatableTitle(title) {
  return /^(?:数据表|datatable)\s*\d+$/iu.test(String(title || '').trim());
}

function buildDatatableLinkSentence(datatable, targetMdPath) {
  const links = [];
  if (datatable?.files?.csvPath) {
    links.push(`[CSV](${relativeMarkdownPath(targetMdPath, datatable.files.csvPath)})`);
  }
  if (datatable?.files?.rowsJsonPath) {
    links.push(`[JSON](${relativeMarkdownPath(targetMdPath, datatable.files.rowsJsonPath)})`);
  }
  if (datatable?.files?.htmlPath) {
    links.push(`[HTML](${relativeMarkdownPath(targetMdPath, datatable.files.htmlPath)})`);
  }
  if (datatable?.files?.pngPath) {
    links.push(`[PNG](${relativeMarkdownPath(targetMdPath, datatable.files.pngPath)})`);
  }
  if (datatable?.obsidian?.basePath) {
    links.push(`[Base](${relativeMarkdownPath(targetMdPath, datatable.obsidian.basePath)})`);
  }
  return links.join(' / ');
}

function injectBoardsIntoMarkdownBySlots(markdown, boards, targetMdPath, cardSlots = [], options = {}) {
  if (!markdown || !Array.isArray(boards) || boards.length === 0) {
    return { markdown, insertedCount: 0, insertedBoardIndexes: [] };
  }

  const normalizedSlots = normalizeCardSlots(cardSlots);
  if (normalizedSlots.length === 0) {
    return { markdown, insertedCount: 0, insertedBoardIndexes: [] };
  }

  let placeholderIndex = 0;
  let insertedCount = 0;
  const insertedBoardIndexes = [];
  return {
    markdown: markdown.replace(GENERIC_CARD_PLACEHOLDER_RE, (match) => {
      const slot = normalizedSlots[placeholderIndex];
      placeholderIndex += 1;
      if (!slot || slot.kind !== 'board' || slot.boardIndex < 0) {
        return match;
      }
      const board = boards[slot.boardIndex];
      if (!board) {
        return match;
      }
      insertedCount += 1;
      insertedBoardIndexes.push(slot.boardIndex);
      return renderBoardMarkdownSection(board, targetMdPath, {
        inline: true,
        sourceDocUrl: options.sourceDocUrl || '',
      });
    }),
    insertedCount,
    insertedBoardIndexes,
  };
}

export function mergeMarkdownWithArtifacts(markdown, artifacts, targetMdPath, sourceDocUrl = '', options = {}) {
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const encryptedBlockRenderPlan = options.encryptedBlockRenderPlan || buildPlainEncryptedBlockRenderPlan(normalizedArtifacts);
  let output = markdown.trimEnd();
  let positionedEncryptedInsertCount = 0;

  if (artifacts.tables.length > 0) {
    output += '\n\n## 导出的表格\n';
    for (const table of artifacts.tables) {
      output += `\n${tableToMarkdown(table)}\n`;
    }
  }

  if (encryptedBlockRenderPlan.blocks.length > 0) {
    const positioned = injectEncryptedBlocksIntoMarkdown(output, encryptedBlockRenderPlan.blocks);
    output = positioned.markdown;
    positionedEncryptedInsertCount = positioned.insertedCount;
  }

  let insertedDatatableCount = 0;
  let insertedDatatableIndexes = [];
  if (normalizedArtifacts.datatables.length > 0) {
    const positioned = injectDatatablesIntoMarkdownBySlots(
      output,
      normalizedArtifacts.datatables,
      targetMdPath,
      normalizedArtifacts.cardSlots,
    );
    output = positioned.markdown;
    insertedDatatableCount = positioned.insertedCount;
    insertedDatatableIndexes = positioned.insertedDatatableIndexes || [];
  }

  let insertedBoardCount = 0;
  let insertedBoardIndexes = [];
  if (normalizedArtifacts.boards.length > 0) {
    const positionedBoards = injectBoardsIntoMarkdownBySlots(
      output,
      normalizedArtifacts.boards,
      targetMdPath,
      normalizedArtifacts.cardSlots,
      { sourceDocUrl },
    );
    output = positionedBoards.markdown;
    insertedBoardCount = positionedBoards.insertedCount;
    insertedBoardIndexes = positionedBoards.insertedBoardIndexes || [];
  }

  if (normalizedArtifacts.codeBlocks.length > 0) {
    output = injectCodeBlockTitlesIntoMarkdown(output, normalizedArtifacts.codeBlocks);
  }

  if (encryptedBlockRenderPlan.blocks.length > positionedEncryptedInsertCount) {
    output += '\n\n## 加密文本块导出\n';
    for (const renderedBlock of encryptedBlockRenderPlan.blocks.slice(positionedEncryptedInsertCount)) {
      output += `\n${renderedBlock}\n`;
    }
  } else if (encryptedBlockRenderPlan.blocks.length === 0 && normalizedArtifacts.encryptedState.detectedCount > 0) {
    output += '\n\n## 加密文本块导出\n';
    if (normalizedArtifacts.encryptedState.attempted && normalizedArtifacts.encryptedState.remainingLockedCount === 0) {
      output += '\n> 已检测到加密文本块，但未能提取到稳定文本内容，已在下方保留页面快照。\n';
    } else if (normalizedArtifacts.encryptedState.attemptedPasswordCount > 0) {
      output += `\n> 检测到加密文本块，已依次尝试 ${normalizedArtifacts.encryptedState.attemptedPasswordCount} 个预设密码，但均未解锁，已跳过加密内容并保留页面快照。\n`;
    } else {
      output += '\n> 检测到加密文本块，但当前未配置可用密码，已跳过加密内容并保留页面快照。\n';
    }
  }

  if (normalizedArtifacts.datatables.length > insertedDatatableCount) {
    output += '\n\n## 语雀数据表导出\n';
    const insertedIndexSet = new Set(insertedDatatableIndexes);
    const remainingDatatables = normalizedArtifacts.datatables.filter((_, index) => !insertedIndexSet.has(index));
    for (const [index, datatable] of remainingDatatables.entries()) {
      output += `\n${renderDatatableMarkdownSection(datatable, targetMdPath, { headingLevel: 3, index, inline: false })}\n`;
    }
  }

  const insertedBoardIndexSet = new Set(insertedBoardIndexes);
  const remainingBoards = normalizedArtifacts.boards.filter((_, index) => !insertedBoardIndexSet.has(index));
  const inlineOnlyEmbeddedBoards = remainingBoards.filter((board) => isInlineOnlyEmbeddedFallbackBoard(board));
  const sectionBoards = remainingBoards.filter((board) => !isInlineOnlyEmbeddedFallbackBoard(board));
  if (inlineOnlyEmbeddedBoards.length > 0 && sourceDocUrl) {
    output = annotateEmbeddedBoardImagesWithSourceNote(output, inlineOnlyEmbeddedBoards.length, sourceDocUrl);
  }
  if (sectionBoards.length > 0) {
    let boardSection = `${resolveBoardSectionHeading(sectionBoards)}\n`;
    for (const [index, board] of sectionBoards.entries()) {
      boardSection += `\n${renderBoardMarkdownSection(board, targetMdPath, {
        index,
        multiple: sectionBoards.length > 1,
        sourceDocUrl,
      })}\n`;
    }
    output = insertSectionAfterLeadHeading(output, boardSection.trimEnd());
  }

  const fallbackNotice = buildFallbackNotice(normalizedArtifacts.fallbackReason);
  if (shouldAppendFallbackSection(normalizedArtifacts)) {
    output += '\n\n## 语雀扩展内容\n';
    if (fallbackNotice) {
      output += `\n> ${fallbackNotice}\n`;
    }
    for (const blockImage of normalizedArtifacts.blockImages) {
      output += `\n![复杂内容快照](${relativeMarkdownPath(targetMdPath, blockImage)})\n`;
    }
  }

  if (shouldAppendBoardSourceLinkSection(normalizedArtifacts, sectionBoards) && sourceDocUrl) {
    output += '\n\n## 原文链接\n';
    output += `\n[查看语雀原文](${sourceDocUrl})\n`;
  }

  return output.trimEnd() + '\n';
}

function isInlineOnlyEmbeddedFallbackBoard(board = {}) {
  return (
    String(board?.sourceType || '').trim() === 'embedded-card' &&
    !Boolean(board?.structuredExport) &&
    !Boolean(board?.markdown) &&
    !Boolean(board?.mermaid)
  );
}

function annotateEmbeddedBoardImagesWithSourceNote(markdown, boardCount, sourceDocUrl) {
  if (!boardCount || !sourceDocUrl) {
    return markdown;
  }

  const lines = String(markdown ?? '').split('\n');
  const output = [];
  let remainingNotes = Number(boardCount) || 0;

  for (const line of lines) {
    output.push(line);
    if (remainingNotes <= 0) {
      continue;
    }
    if (!/^!\[[^\]]*(?:画板|board)[^\]]*\]\([^)]+\)\s*$/iu.test(String(line).trim())) {
      continue;
    }
    output.push('');
    output.push(`> 该处原为语雀画板卡片，当前仅保留原位置内容；如需查看原始画板，请查看[语雀原文](${sourceDocUrl})。`);
    remainingNotes -= 1;
  }

  return output.join('\n');
}

function shouldAppendBoardSourceLinkSection(artifacts = {}, sectionBoards = []) {
  if (!Array.isArray(artifacts?.artifactKinds) || !artifacts.artifactKinds.includes('board')) {
    return false;
  }

  const normalizedSectionBoards = Array.isArray(sectionBoards) ? sectionBoards : [];
  const normalizedBoards = Array.isArray(artifacts?.boards) ? artifacts.boards : [];
  if (normalizedSectionBoards.length > 0) {
    return true;
  }

  return normalizedBoards.length === 0;
}

function renderBoardMarkdownSection(board, targetMdPath, options = {}) {
  const title =
    board.title ||
    buildDefaultBoardTitle(String(board?.detectedKind || '').trim() || 'board', options.index ?? 0);
  let output = '';
  const sourceDocUrl = String(options.sourceDocUrl || '').trim();
  const inline = options.inline === true;

  if (options.multiple && !inline) {
    output += `### ${title}\n\n`;
  }

  const hasPng = Boolean(board.files?.pngPath && fs.existsSync(board.files.pngPath));
  if (inline) {
    output += renderInlineBoardMarkdown(board, targetMdPath, sourceDocUrl, hasPng);
    return output.trimEnd();
  }

  if (board.structuredExport) {
    output += `${renderStructuredBoardBody(board, { inline: false, targetMdPath, hasPng })}\n`;
  } else if (hasPng) {
    output += `![画板导出预览](${relativeMarkdownPath(targetMdPath, board.files.pngPath)})\n`;
  } else {
    output += '> 当前画板未能生成可用的结构化内容或截图。\n';
  }

  if (sourceDocUrl) {
    output += `\n${buildBoardSourceNote(board, sourceDocUrl)}\n`;
  }

  return output.trimEnd();
}

function renderStructuredBoardBody(board, options = {}) {
  if (board?.primaryFormat === 'excalidraw' && board?.excalidrawPath) {
    const parts = [];
    if (options.hasPng && options.targetMdPath) {
      parts.push(`![流程图预览](${relativeMarkdownPath(options.targetMdPath, board.files.pngPath)})`);
    }
    if (options.targetMdPath) {
      parts.push(`[打开可编辑流程图](${relativeMarkdownPath(options.targetMdPath, board.excalidrawPath)})`);
    } else {
      parts.push('> 已生成可编辑 Excalidraw 流程图。');
    }
    return parts.join('\n\n');
  }
  if (board?.detectedKind === 'flowchart' && board?.mermaid) {
    if (options.inline) {
      return `\`\`\`mermaid\n${board.mermaid}\n\`\`\``;
    }
    const description = board?.partialStructured
      ? '> 已尽量提取可识别的流程主干。'
      : '> 已结构化导出为 Mermaid 流程图。';
    return `${description}\n\n\`\`\`mermaid\n${board.mermaid}\n\`\`\``;
  }
  if (board?.markdown) {
    return board.markdown;
  }
  return '';
}

function renderInlineBoardMarkdown(board, targetMdPath, sourceDocUrl, hasPng) {
  const sections = [];
  const structuredBody = renderStructuredBoardBody(board, { inline: true, targetMdPath, hasPng });
  if (structuredBody) {
    sections.push(structuredBody);
  } else if (hasPng) {
    sections.push(`![画板](${relativeMarkdownPath(targetMdPath, board.files.pngPath)})`);
  } else {
    sections.push('> 该处原为语雀画板卡片，当前未能生成可用截图，请查看语雀原文。');
  }

  if (sourceDocUrl) {
    sections.push(buildBoardSourceNote(board, sourceDocUrl));
  }

  return sections.join('\n\n');
}

function buildBoardSourceNote(board, sourceDocUrl) {
  const detectedKind = String(board?.detectedKind || '').trim();
  if (detectedKind === 'flowchart') {
    return board?.partialStructured
      ? `> 该处原为语雀流程图卡片，当前已尽量结构化导出；如需对照原始布局，请查看[语雀原文](${sourceDocUrl})。`
      : `> 该处原为语雀流程图卡片；如需查看原始画板，请查看[语雀原文](${sourceDocUrl})。`;
  }
  if (detectedKind === 'mindmap' || board?.markdown) {
    return `> 该处原为语雀思维导图卡片；如需查看原始画板，请查看[语雀原文](${sourceDocUrl})。`;
  }
  return `> 该处原为语雀画板卡片，当前仅保留原位置内容；如需查看原始画板，请查看[语雀原文](${sourceDocUrl})。`;
}

function resolveBoardSectionHeading(boards = []) {
  const allMindmap =
    Array.isArray(boards) &&
    boards.length > 0 &&
    boards.every((board) => {
      const detectedKind = String(board?.detectedKind || '').trim();
      if (detectedKind) {
        return detectedKind === 'mindmap';
      }
      return Boolean(board?.markdown) && !Boolean(board?.mermaid);
    });
  return allMindmap ? '## \u601d\u7ef4\u5bfc\u56fe\u7ed3\u6784' : '## \u8bed\u96c0\u753b\u677f\u7ed3\u6784';
}

function buildDefaultBoardTitle(kind, index) {
  const number = Number(index) + 1;
  if (kind === 'mindmap') {
    return `\u601d\u7ef4\u5bfc\u56fe ${number}`;
  }
  if (kind === 'flowchart') {
    return `\u6d41\u7a0b\u56fe ${number}`;
  }
  return `\u753b\u677f ${number}`;
}

function resolveStructuredBoardTitle(sourceBoard, kind, index) {
  const sourceType = String(sourceBoard?.sourceType || '').trim();
  const title = String(sourceBoard?.title || '').trim();
  if (sourceType === 'board-document' && title) {
    return title;
  }
  if (title && !/^\u601d\u7ef4\u5bfc\u56fe(?:\s+\d+)?$/.test(title)) {
    return title;
  }
  return buildDefaultBoardTitle(kind, index);
}

function insertSectionAfterLeadHeading(markdown, section) {
  const source = String(markdown || '').trimEnd();
  const injectedSection = String(section || '').trim();
  if (!injectedSection) {
    return source;
  }

  const headingMatch = source.match(/^(# .+?)(\r?\n+|$)/);
  if (!headingMatch) {
    return `${injectedSection}\n\n${source}`.trimEnd();
  }

  const insertIndex = headingMatch[0].length;
  const before = source.slice(0, insertIndex).trimEnd();
  const after = source.slice(insertIndex).trimStart();
  return after
    ? `${before}\n\n${injectedSection}\n\n${after}`.trimEnd()
    : `${before}\n\n${injectedSection}`.trimEnd();
}

function buildFailureWarningEntry(failure = {}) {
  const localized = localizeFailureRecord({
    phase: failure.phase || '文档导出',
    error_type: failure.error_type || 'Error',
    error_message: failure.error_message || '导出失败。',
  });
  return {
    phase: failure.phase || '文档导出',
    errorType: failure.error_type || 'Error',
    errorMessage: failure.error_message || '导出失败。',
    localizedPhase: localized.phase,
    localizedErrorType: localized.error_type,
    localizedErrorMessage: localized.error_message,
  };
}

export function buildPlaceholderMarkdown(docPlan, failure, artifacts, options = {}) {
  const baseMarkdown = String(options.baseMarkdown || '').trim();

  if (baseMarkdown) {
    return mergeMarkdownWithArtifacts(
      baseMarkdown,
      artifacts,
      docPlan.targetMdPath,
      docPlan.absoluteDocUrl,
      options,
    );
  }

  let output = `# ${docPlan.node.name}\n\n`;
  output += '此文档未能直接导出为标准 Markdown，已保留失败信息和可用快照。\n\n';
  output += `- 语雀地址: ${docPlan.absoluteDocUrl}\n`;
  output += `- 导出目标: ${docPlan.targetMdPath}\n`;
  output += `- 失败阶段: ${failure.phase}\n`;
  output += `- 失败原因: ${failure.error_message}\n`;
  return mergeMarkdownWithArtifacts(output, artifacts, docPlan.targetMdPath, docPlan.absoluteDocUrl, options);
}

function summarizeDatatablesForReport(datatables, docPlan, bookPlan) {
  if (!Array.isArray(datatables) || datatables.length === 0) {
    return [];
  }

  return datatables.map((datatable, index) => ({
    index: index + 1,
    title: datatable.title || `数据表 ${index + 1}`,
    bookName: bookPlan.book.name,
    docName: docPlan.node.name,
    sourceDocUrl: docPlan.absoluteDocUrl,
    sourceMarkdownPath: docPlan.targetMdPath,
    sourceType: datatable.sourceType || '',
    tableFormat: datatable.tableFormat || '',
    docId: datatable.docId || 0,
    sheetId: datatable.sheetId || '',
    viewTypes: Array.isArray(datatable.viewTypes) ? datatable.viewTypes : [],
    tableDir: datatable.files.dir,
    csvPath: datatable.files.csvPath,
    rowsJsonPath: datatable.files.rowsJsonPath,
    schemaJsonPath: datatable.files.schemaJsonPath,
    htmlPath: datatable.files.htmlPath,
    pngPath: datatable.files.pngPath,
    imagesDir: datatable.files.imagesDir || '',
    datasetDir: datatable.obsidian?.rootDir || '',
    datasetBasePath: datatable.obsidian?.primaryBasePath || datatable.obsidian?.basePath || '',
    datasetSchemaPath: datatable.obsidian?.schemaPath || '',
    viewManifestPath: datatable.obsidian?.viewManifestPath || '',
    recordCount: datatable.obsidian?.recordCount || 0,
    imageDownloadCount: datatable.imageDownloadCount || 0,
    partial: Boolean(datatable.partial),
    structuredExport: datatable.structuredExport !== false,
    hasSnapshotFallback: Boolean(datatable.hasSnapshotFallback),
    structuredSuccessRate: datatable.structuredSuccessRate ?? calculateDatatableStructuredSuccessRate(datatable),
  }));
}

function finalizeObsidianSetup(config, report, emit = () => {}) {
  const summary = buildObsidianConfigSummary(config, report.contentOutputDir);
  const shouldWriteSetupArtifacts =
    Boolean(summary.vaultPath) ||
    summary.setupMode !== 'none' ||
    summary.vaultExportLayout === 'direct-to-vault';

  const result = {
    ...summary,
    attempted: false,
    enabled: [],
    failed: [],
    notePath: '',
    jsonPath: '',
    vaultName: '',
    cliPath: '',
  };

  if (!shouldWriteSetupArtifacts) {
    return result;
  }

  emit({
    type: 'progress',
    phase: 'obsidian-setup',
    status: 'running',
    message: '正在完成 Obsidian 配置...',
    percent: 100,
    bookPercent: 100,
  });

  try {
    const execution = executeObsidianSetup({
      vaultPath: summary.vaultPath,
      setupMode: summary.setupMode,
    });
    Object.assign(result, execution);

    const context = {
      ...result,
      contentOutputDir: report.contentOutputDir,
      failures: result.failed,
      totals: report.totals,
      datatables: report.datatables.length,
    };
    try {
      result.notePath = writeObsidianSetupNote(report.outputDir, context);
    } catch (error) {
      result.failed.push({
        kind: 'write-setup-note',
        message: errorToMessage(error),
      });
    }
    try {
      result.jsonPath = writeObsidianSetupJson(report.outputDir, context);
    } catch (error) {
      result.failed.push({
        kind: 'write-setup-json',
        message: errorToMessage(error),
      });
    }

    if (result.failed.length > 0) {
      emit({
        type: 'progress',
        phase: 'obsidian-setup',
        status: 'warning',
        message: `Obsidian 配置完成，但有 ${result.failed.length} 条警告。`,
        percent: 100,
        bookPercent: 100,
      });
    }
  } catch (error) {
    result.failed.push({
      kind: 'obsidian-setup',
      message: errorToMessage(error),
    });
    try {
      result.notePath = writeObsidianSetupNote(report.outputDir, {
        ...result,
        contentOutputDir: report.contentOutputDir,
        failures: result.failed,
      });
    } catch {}
    try {
      result.jsonPath = writeObsidianSetupJson(report.outputDir, {
        ...result,
        contentOutputDir: report.contentOutputDir,
        failures: result.failed,
      });
    } catch {}
    emit({
      type: 'progress',
      phase: 'obsidian-setup',
      status: 'warning',
      message: `已跳过 Obsidian 配置：${errorToMessage(error)}`,
      percent: 100,
      bookPercent: 100,
    });
  }

  return result;
}

function finalizeInterruptedExport({ action, report, exportState, failureLogger, emit, completed, totalDocuments, bookContext }) {
  const paused = action === 'pause';
  report.finishedAt = new Date().toISOString();
  report.status = paused ? 'paused' : 'cancelled';
  exportState.saveMeta({
    status: report.status,
    lastRunFinishedAt: report.finishedAt,
  });
  emit({
    type: 'progress',
    phase: paused ? 'paused' : 'cancelled',
    status: paused ? 'paused' : 'cancelled',
    book: bookContext?.bookPlan?.book?.name ?? '',
    message: paused
      ? 'Pause requested. The current progress has been saved and can be resumed later.'
      : 'Stop requested. The current progress has been saved.',
    percent: percent(completed, totalDocuments),
    completedDocuments: completed,
    totalDocuments,
    completedBooks: Math.max((bookContext?.index ?? 1) - 1, 0),
    totalBooks: bookContext?.bookCount ?? 0,
    currentBookIndex: bookContext?.index ?? 1,
    bookPercent: percent(bookContext?.completed ?? 0, bookContext?.total ?? 0),
    bookCompleted: bookContext?.completed ?? 0,
    bookTotal: bookContext?.total ?? 0,
  });
  return finalizeExport(report, failureLogger, emit);
}

function finalizeExport(report, failureLogger, emit) {
  report.manifestPath = path.join(report.outputDir, `export-manifest-${formatTimestamp()}.json`);
  report.reportPath = path.join(report.outputDir, 'export-report.json');
  writeJson(report.manifestPath, report);
  writeJson(report.reportPath, report);

  const result = {
    type: 'result',
    status: report.status,
    outputDir: report.outputDir,
    contentOutputDir: report.contentOutputDir,
    manifestPath: report.manifestPath,
    reportPath: report.reportPath,
    statePath: report.statePath,
    failureCsv: failureLogger.filePath,
    obsidian: report.obsidian,
    encryptedBlockReencryption: report.encryptedBlockReencryption,
    totals: report.totals,
  };
  emit(result);
  return report;
}

export function emptyArtifacts(fallbackReason = '') {
  return {
    tables: [],
    datatables: [],
    cardSlots: [],
    standaloneTables: [],
    boards: [],
    codeBlocks: [],
    renderedImages: [],
    blockImages: [],
    encryptedBlocks: [],
    artifactKinds: [],
    requiresFallback: Boolean(fallbackReason),
    fallbackReason,
    encryptedState: {
      attempted: false,
      detectedCount: 0,
      unlockedCount: 0,
      remainingLockedCount: 0,
      lockedEncryptedCount: 0,
    },
    needsWorker: false,
    requestedTasks: {},
    workerStatus: 'skipped-unneeded',
    retryCount: 0,
    crashExitCode: '',
    degradedReason: '',
  };
}

export function resolveArtifactFallback(pageData, encryptedState, options = {}) {
  const artifactKinds = dedupeTexts(pageData?.artifactKinds ?? []);
  const exportedDatatables = Array.isArray(pageData?.datatables) ? pageData.datatables.length : 0;
  const hasStructuredBoards = Array.isArray(options?.structuredBoards) && options.structuredBoards.length > 0;
  const encryptedBlockCount = Array.isArray(pageData?.encryptedBlocks)
    ? pageData.encryptedBlocks.length
    : Array.isArray(pageData?.encryptedTexts)
      ? pageData.encryptedTexts.length
      : 0;
  const fallbackArtifactKinds = artifactKinds.filter((kind) => {
    if (kind === 'datatable' && exportedDatatables > 0) {
      return false;
    }
    if ((kind === 'board' || kind === 'mindmap') && hasStructuredBoards) {
      return false;
    }
    if (kind === 'board') {
      return false;
    }
    return true;
  });
  if (options.forceFallbackSnapshot) {
    return {
      artifactKinds,
      requiresFallback: true,
      fallbackReason: options.fallbackReason || 'export-failure',
    };
  }

  if (fallbackArtifactKinds.length > 0) {
    return {
      artifactKinds,
      requiresFallback: true,
      fallbackReason: fallbackArtifactKinds[0],
    };
  }

  const hasLockedEncrypted =
    (encryptedState?.detectedCount ?? 0) > 0 &&
    ((encryptedState?.remainingLockedCount ?? 0) > 0 || encryptedBlockCount === 0);

  if (hasLockedEncrypted) {
    return {
      artifactKinds: ['encrypted'],
      requiresFallback: true,
      fallbackReason: 'encrypted-fallback',
    };
  }

  return {
    artifactKinds,
    requiresFallback: false,
    fallbackReason: '',
  };
}

function shouldAppendFallbackSection(artifacts) {
  if (artifacts.fallbackReason === 'datatable' && artifacts.datatables.length > 0) {
    return false;
  }
  return artifacts.blockImages.length > 0 && FALLBACK_ARTIFACT_REASONS.has(artifacts.fallbackReason);
}

function buildFallbackNotice(fallbackReason) {
  const notices = {
    board: '\u5df2\u68c0\u6d4b\u5230\u771f\u5b9e\u753b\u677f\u5185\u5bb9\uff0c\u5df2\u4fdd\u7559 PNG \u5feb\u7167\u3002',
    mindmap: '\u5df2\u68c0\u6d4b\u5230\u771f\u5b9e\u601d\u7ef4\u5bfc\u56fe\u5185\u5bb9\uff0c\u5df2\u4fdd\u7559 PNG \u5feb\u7167\u3002',
    datatable: '\u5df2\u68c0\u6d4b\u5230\u6570\u636e\u8868\u7b49\u590d\u6742\u5185\u5bb9\uff0c\u5df2\u4fdd\u7559 PNG \u5feb\u7167\u3002',
    'encrypted-fallback':
      '\u52a0\u5bc6\u5757\u672a\u80fd\u5b8c\u6574\u89e3\u9501\uff0c\u5df2\u4fdd\u7559\u5c40\u90e8\u5feb\u7167\u4f5c\u4e3a\u515c\u5e95\u8bb0\u5f55\u3002',
    'export-failure': '\u6b63\u6587\u5bfc\u51fa\u5931\u8d25\uff0c\u5df2\u4fdd\u7559\u53ef\u7528\u5feb\u7167\u4f5c\u4e3a\u515c\u5e95\u8bb0\u5f55\u3002',
  };
  return notices[fallbackReason] || '';
}

async function findFallbackCaptureTarget(page, artifacts, options = {}) {
  if (options.forceFallbackSnapshot) {
    return (
      (await page.$('article')) ||
      (await page.$('.ne-viewer-body')) ||
      (await page.$('.lake-content')) ||
      (await page.$('.yuque-doc-content'))
    );
  }

  for (const selector of buildCaptureTargetSelectors(artifacts)) {
    const handle = await page.$(selector);
    if (handle) {
      return handle;
    }
  }

  return (
    (await page.$('article')) ||
    (await page.$('.ne-viewer-body')) ||
    (await page.$('.lake-content')) ||
    (await page.$('.yuque-doc-content'))
  );
}

export function buildCaptureTargetSelectors(artifacts) {
  const selectors = [];
  const kinds = Array.isArray(artifacts?.artifactKinds) ? artifacts.artifactKinds : [];

  for (const kind of kinds) {
    const candidates = COMPLEX_ARTIFACT_SELECTORS[kind];
    if (!candidates) {
      continue;
    }
    for (const selector of candidates) {
      if (!selectors.includes(selector)) {
        selectors.push(selector);
      }
    }
  }

  if (artifacts?.fallbackReason === 'encrypted-fallback') {
    for (const selector of COMPLEX_ARTIFACT_SELECTORS.encrypted) {
      if (!selectors.includes(selector)) {
        selectors.push(selector);
      }
    }
  }

  return selectors;
}

function tableToMarkdown(table) {
  if (!table || table.length === 0) {
    return '';
  }

  const normalized = table.map((row) => row.map((cell) => stripHtml(cell).replace(/\|/g, '\\|')));
  const columnCount = Math.max(...normalized.map((row) => row.length));
  const rows = normalized.map((row) => {
    const values = [...row];
    while (values.length < columnCount) {
      values.push('');
    }
    return values;
  });

  const header = rows[0];
  const divider = header.map(() => '---');
  const body = rows.slice(1);

  return [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function createAllocator() {
  const dirMap = new Map();
  const fileMap = new Map();

  return {
    uniqueDir(parentDir, name) {
      const key = `${parentDir}::dir`;
      const seen = dirMap.get(key) ?? new Set();
      dirMap.set(key, seen);
      return uniqueName(name, seen);
    },
    uniqueFile(parentDir, name) {
      const key = `${parentDir}::file`;
      const seen = fileMap.get(key) ?? new Set();
      fileMap.set(key, seen);
      return uniqueName(name, seen);
    },
  };
}

function percent(done, total) {
  return Math.round((done / Math.max(total, 1)) * 100);
}

function buildBookEvent(bookContext, completed, totalDocuments, message) {
  return {
    type: 'progress',
    phase: 'book',
    status: 'running',
    book: bookContext.bookPlan.book.name,
    message,
    percent: percent(completed, totalDocuments),
    completedDocuments: completed,
    totalDocuments,
    completedBooks: Math.max((bookContext.index ?? 1) - 1, 0),
    totalBooks: bookContext.bookCount ?? 0,
    currentBookIndex: bookContext.index ?? 1,
    bookPercent: percent(bookContext.completed, bookContext.total),
    bookCompleted: bookContext.completed,
    bookTotal: bookContext.total,
  };
}

function injectCodeBlockTitlesIntoMarkdown(markdown, codeBlocks) {
  if (!markdown || !Array.isArray(codeBlocks) || codeBlocks.length === 0) {
    return markdown;
  }

  const fences = parseFencedCodeBlocks(markdown);
  if (fences.length === 0) {
    return markdown;
  }

  const assignments = buildCodeBlockTitleAssignments(fences, codeBlocks);
  if (assignments.length === 0) {
    return markdown;
  }

  let output = markdown;
  for (const assignment of assignments.sort((left, right) => right.fence.start - left.fence.start)) {
    const title = renderPlainCodeBlockTitle(assignment.codeBlock.title);
    if (!title || hasMatchingTitleImmediatelyBefore(output, assignment.fence.start, title, assignment.codeBlock.title)) {
      continue;
    }

    const before = output.slice(0, assignment.fence.start);
    const leadingGap =
      before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const insert = `${leadingGap}${title}\n\n`;
    output = `${before}${insert}${output.slice(assignment.fence.start)}`;
  }

  return output;
}

function buildCodeBlockTitleAssignments(fences, codeBlocks) {
  const titledBlocks = codeBlocks.filter((block) => block?.title && block?.codeText);
  if (titledBlocks.length === 0) {
    return [];
  }

  if (fences.length === codeBlocks.length) {
    const directMatch = codeBlocks.every((block, index) => normalizeCodeBlockText(block?.codeText) === fences[index].normalizedCode);
    if (directMatch) {
      return titledBlocks.map((block) => ({
        codeBlock: block,
        fence: fences[block.index],
      }));
    }
  }

  const assignments = [];
  let nextFenceIndex = 0;
  for (const block of titledBlocks) {
    const normalizedCode = normalizeCodeBlockText(block.codeText);
    if (!normalizedCode) {
      continue;
    }

    let matchedFence = null;
    for (let index = nextFenceIndex; index < fences.length; index += 1) {
      if (fences[index].normalizedCode !== normalizedCode) {
        continue;
      }
      matchedFence = fences[index];
      nextFenceIndex = index + 1;
      break;
    }

    if (matchedFence) {
      assignments.push({ codeBlock: block, fence: matchedFence });
    }
  }

  return assignments;
}

function parseFencedCodeBlocks(markdown) {
  const matches = Array.from(
    String(markdown ?? '').matchAll(/(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g),
  );

  return matches.map((match) => {
    const prefix = match[1] ?? '';
    const full = match[0];
    const blockStart = match.index + prefix.length;
    return {
      start: blockStart,
      end: blockStart + full.length - prefix.length,
      normalizedCode: normalizeCodeBlockText(match[4] ?? ''),
    };
  });
}

function normalizeCodeBlockText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+/g, '')
    .replace(/\n+$/g, '');
}

function renderPlainCodeBlockTitle(title) {
  const normalized = String(title ?? '').replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  return normalized
    .replace(/^(\s*)([#>*+\-])/, '$1\\$2')
    .replace(/^(\s*)(\d+)\.(\s+)/, '$1$2\\.$3');
}

function hasMatchingTitleImmediatelyBefore(markdown, blockStart, renderedTitle, rawTitle) {
  const before = String(markdown ?? '').slice(0, blockStart).replace(/\n+$/g, '');
  if (!before) {
    return false;
  }

  const previousLine = before.split('\n').at(-1)?.trim();
  if (!previousLine) {
    return false;
  }

  return previousLine === renderedTitle.trim() || previousLine === String(rawTitle ?? '').trim();
}

function buildDocEvent({ bookPlan, docPlan, completed, totalDocuments, bookCompleted, bookTotal, message, status = 'running', error = '' }) {
  return {
    type: 'progress',
    phase: 'document',
    status,
    book: bookPlan.book.name,
    doc: docPlan.node.name,
    targetMdPath: docPlan.targetMdPath,
    message: `${bookPlan.book.name} / ${docPlan.node.name}: ${message}`,
    error,
    percent: percent(completed, totalDocuments),
    completedDocuments: completed,
    totalDocuments,
    completedBooks: Math.max((bookPlan.exportIndex ?? 1) - 1, 0),
    totalBooks: bookPlan.exportCount ?? 0,
    currentBookIndex: bookPlan.exportIndex ?? 1,
    bookPercent: percent(bookCompleted, bookTotal),
    bookCompleted,
    bookTotal,
  };
}

function createDocumentIssueTracker(failureLogger, bookPlan, docPlan) {
  const warnings = [];
  const seen = new Set();

  return {
    warnings,
    record(issue = {}) {
      const record = {
        timestamp: new Date().toISOString(),
        book_name: bookPlan.book.name,
        doc_name: docPlan.node.name,
        yuque_path: docPlan.absoluteDocUrl,
        target_md_path: docPlan.targetMdPath,
        phase: issue.phase || 'document-export',
        error_type: issue.error_type || 'PartialDocumentExport',
        error_message: issue.error_message || 'Partial document export issue detected.',
        retry_count: Number.isFinite(Number(issue.retry_count)) ? Number(issue.retry_count) : 0,
      };
      const dedupeKey = `${record.phase}::${record.error_type}::${record.error_message}`;
      if (seen.has(dedupeKey)) {
        return record;
      }

      seen.add(dedupeKey);
      failureLogger.append(record);
      const localized = localizeFailureRecord(record);
      warnings.push({
        phase: record.phase,
        errorType: record.error_type,
        errorMessage: record.error_message,
        localizedPhase: localized.phase,
        localizedErrorType: localized.error_type,
        localizedErrorMessage: localized.error_message,
      });
      return record;
    },
  };
}

export function recordArtifactExportWarnings(artifacts, recordDocIssue) {
  if (!artifacts || !recordDocIssue) {
    return;
  }

  if (artifacts.workerStatus === 'retried-success' && (artifacts.retryCount ?? 0) > 0) {
    recordDocIssue({
      phase: 'capture-artifacts',
      error_type: 'ArtifactCaptureRetried',
      error_message: `Complex block capture succeeded after ${artifacts.retryCount} retry attempt(s).`,
      retry_count: artifacts.retryCount,
    });
  }

  if (artifacts.workerStatus === 'degraded') {
    recordDocIssue({
      phase: 'capture-artifacts',
      error_type: artifacts.crashExitCode ? 'ArtifactCaptureCrashed' : 'ArtifactCaptureDegraded',
      error_message: buildArtifactDegradedWarningMessage(artifacts),
      retry_count: artifacts.retryCount || 0,
    });
  }

  if (
    artifacts.requiresFallback &&
    artifacts.fallbackReason &&
    artifacts.fallbackReason !== 'export-failure' &&
    artifacts.fallbackReason !== 'encrypted-fallback'
  ) {
    recordDocIssue({
      phase: 'capture-artifacts',
      error_type: 'ArtifactFallbackUsed',
      error_message: buildArtifactFallbackWarningMessage(artifacts),
    });
  }

  const boards = Array.isArray(artifacts.boards) ? artifacts.boards : [];
  const hasStructuredBoardExport =
    boards.some((board) => board?.structuredExport || board?.markdown || board?.canvasDocument);
  if (
    Array.isArray(artifacts.artifactKinds) &&
    artifacts.artifactKinds.includes('board') &&
    !hasStructuredBoardExport &&
    !shouldSuppressEmbeddedBoardSidecarWarning(boards)
  ) {
    recordDocIssue({
      phase: 'capture-artifacts',
      error_type: 'BoardExportSidecarOnly',
      error_message: buildBoardExportWarningMessage(artifacts.boards),
    });
  }
}

function shouldSuppressEmbeddedBoardSidecarWarning(boards = []) {
  return (
    Array.isArray(boards) &&
    boards.length > 0 &&
    boards.every((board) => String(board?.sourceType || '').trim() === 'embedded-card')
  );
}

function buildArtifactDegradedWarningMessage(artifacts = {}) {
  if (artifacts.crashExitCode) {
    const datatableCount = Array.isArray(artifacts.datatables) ? artifacts.datatables.length : 0;
    const preservedSummary =
      datatableCount > 0
        ? ` Partial complex artifact results were preserved, including ${datatableCount} datatable(s).`
        : '';
    const duplicateCrashMessage = `Complex artifact worker crashed with exit code ${artifacts.crashExitCode}.`;
    const degradedReason = String(artifacts.degradedReason || '').trim();
    const normalizedReason = degradedReason && degradedReason !== duplicateCrashMessage ? ` ${degradedReason}` : '';
    return `Complex block worker crashed with exit code ${artifacts.crashExitCode}.${preservedSummary}${normalizedReason}`.trim();
  }
  return `Complex block capture degraded for this document: ${artifacts.degradedReason}`.trim();
}

function buildArtifactFallbackWarningMessage(artifacts) {
  const fallbackReason = String(artifacts?.fallbackReason || '').trim() || 'complex';
  const snapshotCount = Array.isArray(artifacts?.blockImages) ? artifacts.blockImages.length : 0;
  return `Used fallback snapshot export for ${fallbackReason} content. Snapshot files kept: ${snapshotCount}.`;
}

function buildBoardExportWarningMessage(boards = []) {
  const reasons = dedupeTexts(
    (Array.isArray(boards) ? boards : [])
      .map((board) => String(board?.failureReason || '').trim())
      .filter(Boolean),
  );
  const sourceTypes = dedupeTexts(
    (Array.isArray(boards) ? boards : [])
      .map((board) => String(board?.sourceType || '').trim())
      .filter(Boolean),
  );
  const hasEmbeddedBoards = sourceTypes.includes('embedded-card');
  const hasStandaloneBoardDoc = sourceTypes.includes('board-document');

  if (hasEmbeddedBoards && !hasStandaloneBoardDoc) {
    if (reasons.length > 0) {
      return `Detected embedded Yuque board card content inside a regular document. The main markdown/text content was exported normally, and the embedded board content was kept as Yuque JSON/PNG sidecar files instead of a markdown outline. Reasons: ${reasons.join(', ')}.`;
    }
    return 'Detected embedded Yuque board card content inside a regular document. The main markdown/text content was exported normally, and the embedded board content was kept as Yuque JSON/PNG sidecar files instead of a markdown outline.';
  }

  if (reasons.length > 0) {
    return `Detected a standalone Yuque board document that could not be linearized into a markdown outline. The export kept Yuque JSON/PNG sidecar files instead. Reasons: ${reasons.join(', ')}.`;
  }
  return 'Detected a standalone Yuque board document that could not be linearized into a markdown outline. The export kept Yuque JSON/PNG sidecar files instead.';
}

function recordDatatableExportWarnings(datatables, recordDocIssue) {
  if (!Array.isArray(datatables) || !recordDocIssue) {
    return;
  }

  for (const [index, datatable] of datatables.entries()) {
    const successRate =
      datatable?.structuredSuccessRate != null ? Math.round(Number(datatable.structuredSuccessRate) * 100) : null;
    const snapshotIsSupplementalOnly =
      Boolean(datatable?.hasSnapshotFallback) &&
      !Boolean(datatable?.partial) &&
      (successRate == null || successRate >= 100);

    if (!datatable?.partial && !datatable?.snapshotCaptureError && (!datatable?.hasSnapshotFallback || snapshotIsSupplementalOnly)) {
      continue;
    }

    const title = datatable.title || `Datatable ${index + 1}`;
    const issues = [];
    if (datatable.partial) {
      issues.push('structured rows/columns were only partially extracted');
    }
    if (datatable.hasSnapshotFallback) {
      issues.push('a PNG snapshot fallback was kept');
    } else if (datatable?.snapshotCaptureError) {
      issues.push(`PNG snapshot capture was skipped (${datatable.snapshotCaptureError})`);
    }

    recordDocIssue({
      phase: 'capture-artifacts',
      error_type: 'PartialDatatableExport',
      error_message: `Datatable "${title}" exported with warnings: ${issues.join('; ')}${
        successRate != null ? `. Structured success rate: ${successRate}%` : ''
      }.`,
    });
  }
}

export function findMissingExportedAssetReferences(markdown, targetMdPath) {
  const text = String(markdown ?? '');
  if (!text.trim()) {
    return [];
  }

  const findings = [];
  const seen = new Set();
  const patterns = [
    { kind: 'image', regex: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g },
    { kind: 'file', regex: /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g },
  ];

  for (const { kind, regex } of patterns) {
    let occurrence = 0;
    for (const match of text.matchAll(regex)) {
      const rawUrl = String(match[kind === 'image' ? 2 : 1] ?? '').trim();
      const assetAlt = kind === 'image' ? String(match[1] ?? '').trim() : '';
      if (!isExportedLocalAssetReference(rawUrl, kind)) {
        if (kind === 'image') {
          occurrence += 1;
        }
        continue;
      }

      const resolvedPath = resolveMarkdownLocalPath(targetMdPath, rawUrl);
      if (!resolvedPath || fs.existsSync(resolvedPath)) {
        if (kind === 'image') {
          occurrence += 1;
        }
        continue;
      }

      const imageOccurrence = kind === 'image' ? occurrence : -1;
      const key = `${kind}::${rawUrl}::${resolvedPath}::${imageOccurrence}`;
      if (seen.has(key)) {
        if (kind === 'image') {
          occurrence += 1;
        }
        continue;
      }
      seen.add(key);
      const slotKey =
        kind === 'image'
          ? buildDocumentImageSlotIdentity({
              rawUrl,
              imageOccurrence,
              assetAlt,
            }).slotKey
          : '';
      findings.push({
        kind,
        rawUrl,
        resolvedPath,
        imageOccurrence,
        assetAlt,
        slotKey,
      });
      if (kind === 'image') {
        occurrence += 1;
      }
    }
  }

  return findings;
}

export async function repairMarkdownAssetReferences(markdown, context = {}) {
  const source = String(markdown ?? '');
  if (!source.trim()) {
    return { markdown: source, issues: [] };
  }

  const targetMdPath = String(context.targetMdPath || '').trim();
  const findings = findMissingExportedAssetReferences(source, targetMdPath);
  if (findings.length === 0) {
    return { markdown: source, issues: [] };
  }

  let renderedImages = Array.isArray(context.renderedImages) ? context.renderedImages : [];
  if (renderedImages.length === 0 && typeof context.getRenderedImages === 'function') {
    renderedImages = await context.getRenderedImages();
  }
  if (!Array.isArray(renderedImages) || renderedImages.length === 0) {
    return { markdown: source, issues: [] };
  }

  let output = source;
  const issues = [];
  const resolvedReplacements = new Map();

  for (const finding of findings) {
    const replacementKey = String(finding?.slotKey || `${finding.kind}::${finding.rawUrl}::${finding.imageOccurrence}`).trim();
    let repaired = resolvedReplacements.get(replacementKey);
    if (!repaired) {
      repaired = await recoverMissingMarkdownAssetReference(finding, renderedImages, context);
      resolvedReplacements.set(replacementKey, repaired || null);
    }
    if (!repaired?.replacement || repaired.replacement === finding.rawUrl) {
      continue;
    }

    output = replaceMarkdownAssetReference(output, finding, repaired.replacement);
    if (repaired.issue) {
      issues.push(repaired.issue);
    }
  }

  return {
    markdown: output,
    issues,
  };
}

function recordMissingExportedAssetWarnings(markdown, targetMdPath, recordDocIssue) {
  if (!recordDocIssue) {
    return;
  }

  for (const finding of findMissingExportedAssetReferences(markdown, targetMdPath)) {
    recordDocIssue({
      phase: 'write-markdown',
      error_type: 'MissingExportedAsset',
      error_message: `Markdown references missing exported ${finding.kind} asset ${finding.rawUrl} (resolved path: ${finding.resolvedPath}).`,
    });
  }
}

function isExportedLocalAssetReference(rawUrl, kind) {
  if (!rawUrl || /^(?:[a-z]+:)?\/\//i.test(rawUrl) || rawUrl.startsWith('#') || rawUrl.startsWith('mailto:')) {
    return false;
  }

  const withoutFragment = rawUrl.split('#')[0];
  const withoutQuery = withoutFragment.split('?')[0];
  const normalized = withoutQuery.replace(/\\/g, '/');
  if (!normalized.includes('/_assets/') && !normalized.startsWith('_assets/') && !normalized.startsWith('../_assets/')) {
    return false;
  }

  if (kind === 'file' && /\.md(?:own)?$/i.test(normalized)) {
    return false;
  }

  return true;
}

function resolveMarkdownLocalPath(targetMdPath, rawUrl) {
  const withoutFragment = String(rawUrl ?? '').split('#')[0];
  const withoutQuery = withoutFragment.split('?')[0];
  if (!withoutQuery) {
    return '';
  }

  try {
    return path.resolve(path.dirname(targetMdPath), decodeURIComponent(withoutQuery));
  } catch {
    return path.resolve(path.dirname(targetMdPath), withoutQuery);
  }
}

async function recoverMissingMarkdownAssetReference(finding, renderedImages, context = {}) {
  const candidate = findRenderedImageForAssetReference(renderedImages, finding.rawUrl, {
    imageOccurrence: finding.imageOccurrence,
    assetAlt: finding.assetAlt,
  });
  if (!candidate?.downloadUrl) {
    return null;
  }

  const assetKind = inferRecoveredAssetKind(finding);
  const fileNameHint =
    extractAssetBasename(finding.rawUrl) ||
    inferAssetFileName(candidate.originalUrl || candidate.downloadUrl, assetKind);
  let localPath = '';
  if (candidate.isLoaded !== false && typeof context.downloadAsset === 'function') {
    localPath = await context.downloadAsset(candidate.downloadUrl, assetKind, {
      fileNameHint,
      rawUrl: finding.rawUrl,
      originalUrl: candidate.originalUrl,
      basenameCandidates: candidate.basenameCandidates,
      imageOccurrence: finding.imageOccurrence,
      assetAlt: String(finding.assetAlt || '').trim(),
      cacheAliases: [candidate.originalUrl, candidate.downloadUrl].filter(Boolean),
      skipRenderedAssetFallback: true,
    });
  }
  if (!localPath && assetKind === 'image' && typeof context.captureRenderedImageFallback === 'function') {
    localPath = await context.captureRenderedImageFallback(
      {
        ...candidate,
        imageOccurrence: finding.imageOccurrence,
        assetAlt: String(finding.assetAlt || '').trim(),
      },
      {
        finding,
        fileNameHint,
      },
    );
  }

  if (localPath) {
    return {
      replacement: relativeMarkdownPath(context.targetMdPath, localPath),
      sourceType: 'yuque-rendered-proxy',
      issue: null,
    };
  }

  const remoteUrl = candidate.originalUrl || candidate.downloadUrl;
  if (!remoteUrl) {
    return null;
  }

  return {
    replacement: remoteUrl,
    sourceType: 'kept-remote',
    issue: {
      phase: 'rewrite-markdown',
      error_type: 'AssetRetainedRemote',
      error_message: `Kept remote ${assetKind} asset ${remoteUrl} because the broken local export reference ${finding.rawUrl} could not be recovered as a local file.`,
    },
  };
}

function inferRecoveredAssetKind(finding) {
  const normalized = String(finding?.rawUrl || '').split('#')[0].split('?')[0].toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(normalized) || normalized.includes('/images/')) {
    return 'image';
  }
  return finding?.kind === 'file' ? 'file' : 'image';
}

function inferAssetDownloadWarningType(kind, error) {
  if (String(kind || '').toLowerCase() !== 'image') {
    return 'AssetDownloadSkipped';
  }

  const message = errorToMessage(error);
  if (/matching Yuque-rendered image fallback was rejected because/i.test(message)) {
    return 'ImageFallbackRejected';
  }
  if (
    /Received an HTML document instead of image bytes while downloading image asset/i.test(message) ||
    /Received a non-image response while downloading image asset/i.test(message) ||
    /Downloaded image asset .+ was empty\./i.test(message)
  ) {
    return 'ImageResponseNotRenderable';
  }
  return 'AssetDownloadSkipped';
}

function buildRenderedImageFallbackRejectedError(assetUrl, originalError, fallback) {
  const originalReason = errorToMessage(originalError);
  const fallbackReason = buildRenderedImageRecoveryFailureDescription(fallback);
  return new Error(
    `The original image download failed (${originalReason}), and the matching Yuque-rendered image fallback was rejected because ${fallbackReason}.`,
  );
}

function toBinaryBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  return Buffer.alloc(0);
}

function extractResponseHeaderValue(response, headerName) {
  const headers = response?.headers;
  if (!headers) {
    return '';
  }

  if (typeof headers.get === 'function') {
    return String(headers.get(headerName) || headers.get(String(headerName).toLowerCase()) || '').trim();
  }

  const direct = headers[headerName] ?? headers[String(headerName).toLowerCase()];
  if (Array.isArray(direct)) {
    return String(direct[0] || '').trim();
  }
  return String(direct || '').trim();
}

function looksLikeHtmlResponseBuffer(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').replace(/^\ufeff/, '').trimStart();
  return /^<!doctype html\b/i.test(text) || /^<html[\s>]/i.test(text) || /^<head[\s>]/i.test(text);
}

function looksLikeSvgResponseBuffer(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').replace(/^\ufeff/, '').trimStart();
  return /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text);
}

function detectImageMimeTypeFromBuffer(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'image/gif';
    }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && (buffer[2] === 0x01 || buffer[2] === 0x02) && buffer[3] === 0x00) {
    return 'image/x-icon';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp' &&
    /^avif|avis$/i.test(buffer.subarray(8, 12).toString('ascii'))
  ) {
    return 'image/avif';
  }
  if (buffer.length >= 4) {
    const littleEndianTiff = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
    const bigEndianTiff = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
    if (littleEndianTiff || bigEndianTiff) {
      return 'image/tiff';
    }
  }
  return '';
}

function replaceMarkdownAssetReference(markdown, finding, replacement) {
  const source = String(markdown ?? '');
  const rawUrl =
    typeof finding === 'string'
      ? String(finding || '').trim()
      : String(finding?.rawUrl ?? '').trim();
  if (!rawUrl) {
    return source;
  }
  if (String(finding?.kind || '').trim() === 'image' && normalizeImageOccurrence(finding?.imageOccurrence) >= 0) {
    let occurrence = 0;
    return source.replace(/!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?\))/g, (match, alt, url, suffix) => {
      const currentOccurrence = occurrence;
      occurrence += 1;
      if (currentOccurrence !== normalizeImageOccurrence(finding?.imageOccurrence) || String(url || '').trim() !== rawUrl) {
        return match;
      }
      return `![${alt}](${replacement}${suffix}`;
    });
  }
  const escapedUrl = escapeRegExp(rawUrl);
  return source
    .replace(
      new RegExp(`(!\\[[^\\]]*\\]\\()${escapedUrl}((?:\\s+"[^"]*")?\\))`, 'g'),
      `$1${replacement}$2`,
    )
    .replace(
      new RegExp(`((?<!\\!)\\[[^\\]]+\\]\\()${escapedUrl}((?:\\s+"[^"]*")?\\))`, 'g'),
      `$1${replacement}$2`,
    );
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function appendExportWarningsSection(markdown, warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return markdown;
  }

  let output = String(markdown ?? '').trimEnd();
  output += '\n\n## 导出警告\n';
  for (const warning of warnings) {
    const phase = warning.localizedPhase || warning.phase || '文档导出';
    const message = warning.localizedErrorMessage || warning.errorMessage || '检测到部分导出异常。';
    output += `\n- [${phase}] ${message}\n`;
  }
  return output.trimEnd() + '\n';
}

function toBlockQuote(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line || ' '}`)
    .join('\n');
}

function normalizeEncryptedBlock(block, index = 0) {
  if (typeof block === 'string') {
    const text = String(block).trim();
    return text
      ? {
          text,
          matchedPassword: '',
          order: index,
        }
      : null;
  }

  if (!block || typeof block !== 'object') {
    return null;
  }

  const text = String(block.text ?? '').trim();
  if (!text) {
    return null;
  }

  const order = Number.isFinite(Number(block.order)) ? Number(block.order) : index;
  return {
    text,
    matchedPassword: String(block.matchedPassword ?? block.password ?? '').trim(),
    order,
  };
}

function normalizeEncryptedBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [];
  }

  return blocks
    .map((block, index) => {
      const normalized = normalizeEncryptedBlock(block, index);
      return normalized
        ? {
            ...normalized,
            __index: index,
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.__index - right.__index;
    })
    .map(({ __index, ...block }) => block);
}

function normalizeArtifacts(artifacts = {}) {
  const sourceBlocks =
    Array.isArray(artifacts?.encryptedBlocks) && artifacts.encryptedBlocks.length > 0
      ? artifacts.encryptedBlocks
      : artifacts?.encryptedTexts;
  const assignedDatatables = assignDatatableSlots(artifacts?.cardSlots, artifacts?.datatables);
  const assignedBoards = assignBoardSlots(assignedDatatables.cardSlots, artifacts?.boards);
  return {
    ...artifacts,
    tables: Array.isArray(artifacts?.tables) ? artifacts.tables : [],
    datatables: assignedDatatables.datatables,
    cardSlots: assignedBoards.cardSlots,
    standaloneTables: Array.isArray(artifacts?.standaloneTables) ? artifacts.standaloneTables : [],
    boards: assignedBoards.boards,
    codeBlocks: Array.isArray(artifacts?.codeBlocks) ? artifacts.codeBlocks : [],
    renderedImages: Array.isArray(artifacts?.renderedImages) ? artifacts.renderedImages : [],
    blockImages: Array.isArray(artifacts?.blockImages) ? artifacts.blockImages : [],
    encryptedBlocks: normalizeEncryptedBlocks(sourceBlocks),
    artifactKinds: Array.isArray(artifacts?.artifactKinds) ? artifacts.artifactKinds : [],
  };
}

function buildPlainEncryptedBlockRenderPlan(artifacts = {}) {
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  return {
    mode: 'off',
    blocks: normalizedArtifacts.encryptedBlocks.map((block) => toBlockQuote(block.text)),
    warnings: [],
    summary: {
      mode: 'off',
      totalBlocks: normalizedArtifacts.encryptedBlocks.length,
      encryptedBlockCount: 0,
      plainFallbackBlockCount: normalizedArtifacts.encryptedBlocks.length,
      missingPasswordBlockOrders: [],
      failedBlockOrders: [],
      globalPasswordConfigured: false,
    },
  };
}

export async function buildEncryptedBlockRenderPlan(artifacts = {}, options = {}) {
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const mode = normalizeReencryptMode(options.reencryptEncryptedBlocksMode || options.mode);
  const globalPassword = String(options.reencryptGlobalPassword || '').trim();
  const blocks = [];
  const missingPasswordBlockOrders = [];
  const failedBlocks = [];
  let encryptedBlockCount = 0;

  for (const block of normalizedArtifacts.encryptedBlocks) {
    const orderNumber = Number(block.order) + 1;
    const plaintextBlock = toBlockQuote(block.text);

    if (mode === 'off') {
      blocks.push(plaintextBlock);
      continue;
    }

    const targetPassword = mode === 'global' ? globalPassword : String(block.matchedPassword || '').trim();
    if (!targetPassword) {
      missingPasswordBlockOrders.push(orderNumber);
      blocks.push(plaintextBlock);
      continue;
    }

    try {
      blocks.push(
        await encryptMeldBlock(block.text, targetPassword, {
          showInReadingView: true,
        }),
      );
      encryptedBlockCount += 1;
    } catch (error) {
      failedBlocks.push({
        order: orderNumber,
        reason: errorToMessage(error),
      });
      blocks.push(plaintextBlock);
    }
  }

  const warnings = [];
  if (mode === 'global' && normalizedArtifacts.encryptedBlocks.length > 0 && !globalPassword) {
    warnings.push({
      phase: 'write-markdown',
      errorType: 'EncryptedBlockReencryptionSkipped',
      errorMessage: `Encrypted block re-encryption mode "global" could not run because no global password was configured. Falling back to plaintext for ${normalizedArtifacts.encryptedBlocks.length} block(s).`,
    });
  }

  if (mode === 'matched-block' && missingPasswordBlockOrders.length > 0) {
    warnings.push({
      phase: 'write-markdown',
      errorType: 'EncryptedBlockReencryptionSkipped',
      errorMessage: `Encrypted block re-encryption mode "matched-block" could not find matched passwords for ${missingPasswordBlockOrders.length} block(s): ${missingPasswordBlockOrders
        .map((order) => `#${order}`)
        .join(', ')}. Those blocks were kept as plaintext.`,
    });
  }

  if (failedBlocks.length > 0) {
    warnings.push({
      phase: 'write-markdown',
      errorType: 'EncryptedBlockReencryptionFailed',
      errorMessage: `Encrypted block re-encryption mode "${mode}" failed for ${failedBlocks.length} block(s): ${failedBlocks
        .map((block) => `#${block.order}`)
        .join(', ')}. Those blocks were kept as plaintext. First error: ${failedBlocks[0].reason}`,
    });
  }

  return {
    mode,
    blocks,
    warnings,
    summary: {
      mode,
      totalBlocks: normalizedArtifacts.encryptedBlocks.length,
      encryptedBlockCount,
      plainFallbackBlockCount: blocks.length - encryptedBlockCount,
      missingPasswordBlockOrders,
      failedBlockOrders: failedBlocks.map((block) => block.order),
      globalPasswordConfigured: Boolean(globalPassword),
    },
  };
}

function recordEncryptedBlockRenderWarnings(renderPlan, recordDocIssue) {
  if (!recordDocIssue || !renderPlan || !Array.isArray(renderPlan.warnings)) {
    return;
  }

  for (const warning of renderPlan.warnings) {
    recordDocIssue({
      phase: warning.phase || 'write-markdown',
      error_type: warning.errorType || 'EncryptedBlockReencryptionSkipped',
      error_message: warning.errorMessage || 'Encrypted block re-encryption encountered a warning.',
    });
  }
}

function injectEncryptedBlocksIntoMarkdown(markdown, renderedBlocks) {
  if (!markdown || !Array.isArray(renderedBlocks) || renderedBlocks.length === 0) {
    return { markdown, insertedCount: 0 };
  }

  let insertedCount = 0;
  const replaced = markdown.replace(
    /\[(此处为语雀卡片，点击链接查看)\]\((https?:\/\/(?:www\.)?yuque\.com\/docs\/\d+(?:#[^)]+)?)\)/g,
    (match) => {
      const renderedBlock = renderedBlocks[insertedCount];
      if (!renderedBlock) {
        return match;
      }
      insertedCount += 1;
      return renderedBlock;
    },
  );

  return {
    markdown: replaced,
    insertedCount,
  };
}

function dedupeTexts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function isEffectivelyEmptyDocDetail(docDetail) {
  if (!docDetail || typeof docDetail !== 'object') {
    return false;
  }

  if (isBoardDocument(docDetail) || isTableDocument(docDetail) || isSheetDocument(docDetail)) {
    return false;
  }

  const content = typeof docDetail.content === 'string' ? docDetail.content : '';
  const body = typeof docDetail.body === 'string' ? docDetail.body : '';
  const normalizedContent = normalizeDocDetailTextContent(content);
  const normalizedBody = normalizeDocDetailTextContent(body);
  return normalizedContent === '' && normalizedBody === '';
}

export function classifyDocExportRoute(docDetail) {
  if (isBoardDocument(docDetail)) {
    return 'export-board';
  }
  if (isSheetDocument(docDetail)) {
    return 'export-sheet';
  }
  if (isTableDocument(docDetail)) {
    return 'export-table';
  }
  if (isEffectivelyEmptyDocDetail(docDetail)) {
    return 'skip-empty';
  }
  return 'export-markdown';
}

function isTitleOnlyMarkdown(markdown, docName) {
  const lines = String(markdown ?? '')
    .replace(/^\ufeff/, '')
    .split(/\r?\n/);
  const nonEmptyLines = lines.map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length === 0) {
    return true;
  }

  const firstLine = nonEmptyLines[0];
  const normalizedDocName = String(docName ?? '').trim();
  const isHeadingOnly =
    /^#\s+/.test(firstLine) &&
    normalizeComparableText(firstLine.replace(/^#\s+/, '')) === normalizeComparableText(normalizedDocName) &&
    nonEmptyLines.slice(1).join('').trim() === '';

  return isHeadingOnly;
}

function normalizeComparableText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function removeIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function removeDirectoryIfExists(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function cleanupDatatableTempRecordDirs(datasetRoot) {
  if (!datasetRoot || !fs.existsSync(datasetRoot)) {
    return;
  }

  for (const entry of fs.readdirSync(datasetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.records-writing-')) {
      continue;
    }
    try {
      withFileSystemRetries(() => removeDirectoryIfExists(path.join(datasetRoot, entry.name)), 5, 250);
    } catch {
      // A stale temp directory should not fail the finished export.
    }
  }
}

function replaceDatatableRecordsDir(sourceDir, targetDir) {
  withFileSystemRetries(() => clearDirectoryContents(targetDir));
  withFileSystemRetries(() => copyDirectoryContents(sourceDir, targetDir));
  try {
    withFileSystemRetries(() => removeDirectoryIfExists(sourceDir), 5, 250);
  } catch {
    // Temporary cleanup should not fail the finished dataset export.
  }
}

function buildUniqueDatatableRecordsDirPath(parentDir, prefix) {
  const uniqueToken = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let candidatePath = path.join(parentDir, `${prefix}${uniqueToken}`);
  let counter = 2;
  while (fs.existsSync(candidatePath)) {
    candidatePath = path.join(parentDir, `${prefix}${uniqueToken}-${counter}`);
    counter += 1;
  }
  return candidatePath;
}

function promoteDatatableRecordsDir(sourceDir, targetDir) {
  if (!sourceDir || !targetDir || sourceDir === targetDir) {
    return;
  }

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Datatable temp records directory does not exist: ${sourceDir}`);
  }

  if (!fs.existsSync(targetDir)) {
    withFileSystemRetries(() => fs.renameSync(sourceDir, targetDir), 5, 250);
    return;
  }

  const backupDir = buildUniqueDatatableRecordsDirPath(path.dirname(targetDir), '.records-prev-');
  withFileSystemRetries(() => fs.renameSync(targetDir, backupDir), 5, 250);

  try {
    withFileSystemRetries(() => fs.renameSync(sourceDir, targetDir), 5, 250);
  } catch (error) {
    if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      try {
        withFileSystemRetries(() => fs.renameSync(backupDir, targetDir), 5, 250);
      } catch (rollbackError) {
        error.message = `${error.message} Rollback failed: ${errorToMessage(rollbackError)}`;
      }
    }
    throw error;
  }
}

function normalizeDocDetailTextContent(value) {
  const source = String(value ?? '').trim();
  if (!source) {
    return '';
  }

  const withoutLakeDoctype = source.replace(/<!doctype\s+lake>/gi, '');
  return stripHtml(withoutLakeDoctype)
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function remapDatatableRecordPaths(record, fromDir, toDir) {
  return {
    ...record,
    mdPath: remapDatatablePath(record.mdPath, fromDir, toDir),
    dataJsonPath: remapDatatablePath(record.dataJsonPath, fromDir, toDir),
  };
}

function remapDatatablePath(filePath, fromDir, toDir) {
  if (!filePath) {
    return filePath;
  }
  const relativePath = path.relative(fromDir, filePath);
  return path.join(toDir, relativePath);
}

function clearDirectoryContents(dirPath) {
  if (!dirPath) {
    return;
  }
  ensureDir(dirPath);
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const targetPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
  }
}

function copyDirectoryContents(sourceDir, targetDir) {
  ensureDir(targetDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const fromPath = path.join(sourceDir, entry.name);
    const toPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(toPath, { recursive: true, force: true });
      fs.cpSync(fromPath, toPath, { recursive: true, force: true });
      continue;
    }

    ensureDir(path.dirname(toPath));
    fs.copyFileSync(fromPath, toPath);
  }
}

function withFileSystemRetries(action, attempts = 3, delayMs = 120) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return action();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw error;
      }
      sleepSync(delayMs * attempt);
    }
  }
  if (lastError) {
    throw lastError;
  }
}

function sleepSync(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }

  const shared = new SharedArrayBuffer(4);
  const array = new Int32Array(shared);
  Atomics.wait(array, 0, 0, delayMs);
}

function normalizePasswordCandidates(passwords) {
  if (Array.isArray(passwords)) {
    return passwords.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(passwords ?? '')
    .split(/\r?\n|[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvPasswordList(listValue, fallbackPassword) {
  const candidates = normalizePasswordCandidates(listValue);
  if (candidates.length > 0) {
    return candidates;
  }
  return fallbackPassword ? [fallbackPassword] : [];
}

function buildEncryptedLockMessage(encryptedState) {
  if ((encryptedState?.attemptedPasswordCount ?? 0) > 0) {
    return `Tried ${encryptedState.attemptedPasswordCount} preset passwords, but none could unlock the encrypted block.`;
  }
  return 'Encrypted block detected, but no preset password was configured.';
}

async function replaceAsync(text, regex, replacer) {
  const source = String(text ?? '');
  const matches = [...source.matchAll(regex)];
  if (matches.length === 0) {
    return source;
  }

  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let output = '';
  let cursor = 0;

  matches.forEach((match, index) => {
    output += source.slice(cursor, match.index);
    output += replacements[index];
    cursor = match.index + match[0].length;
  });

  output += source.slice(cursor);
  return output;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeBrowserSafely(browser, timeoutMs = 5000) {
  if (!browser) {
    return;
  }

  try {
    await withTimeout(browser.close(), timeoutMs, 'Timed out while closing browser.');
  } catch {
    const proc = typeof browser.process === 'function' ? browser.process() : null;
    if (proc && !proc.killed) {
      try {
        proc.kill();
      } catch {
        // Ignore forced shutdown failures during teardown.
      }
    }
  }
}
