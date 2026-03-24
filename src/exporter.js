import fs from 'fs';
import path from 'path';
import { type } from './const.js';
import { ExportControl, ExportStateStore } from './export-state.js';
import { FailureCsvLogger } from './failure-log.js';
import { processMarkdown } from './markdown.js';
import { filterBooks, getAllBooks, serializeBooks } from './toc.js';
import { createHttpClient, fetchMarkdown, launchBrowser, openAuthenticatedPage } from './yuque.js';
import {
  ensureDir,
  errorToMessage,
  formatTimestamp,
  relativeMarkdownPath,
  sanitizeFileName,
  sleep,
  stripHtml,
  uniqueName,
  writeJson,
} from './utils.js';

const MARKDOWN_TIMEOUT_MS = 180000;
const ARTIFACT_TIMEOUT_MS = 180000;
const ENCRYPTED_DOM_SELECTORS = Object.freeze({
  lockedContainer: 'div.ne-card-locked-text-unlock-container[data-testid="ne-card-locked-text-unlock-status"]',
  input: 'input[data-testid="ne-card-locked-text-unlock-input"]',
  submitButton: 'div.ne-card-locked-text-unlock-submit-button[data-testid="ne-card-locked-text-unlock-button"]',
  content: 'div.ne-card-locked-text-read-container[data-testid="ne-card-locked-text-viewer-content"]',
});
const ENCRYPTED_SKIP_ATTR = 'data-codex-encrypted-skip';
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
const FALLBACK_ARTIFACT_REASONS = new Set(['board', 'mindmap', 'datatable', 'encrypted-fallback', 'export-failure']);

export async function scanBooks(config) {
  const client = createHttpClient(config.cookiePath);
  const books = await getAllBooks(client);
  return serializeBooks(books);
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
  const failureLogger = new FailureCsvLogger(outputDir);
  const exportState = new ExportStateStore(outputDir);
  const control = new ExportControl(config.jobControlPath);
  control.clear();

  const exportPlan = buildExportPlan(books, outputDir, createSelectionMatcher(config));
  const docLinkMap = new Map(exportPlan.documents.map((doc) => [doc.absoluteDocUrl, doc.targetMdPath]));

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
    statePath: exportState.filePath,
    failureCsv: failureLogger.filePath,
    totals: {
      books: books.length,
      documents: exportPlan.documents.length,
      exported: 0,
      failed: 0,
      skipped: 0,
    },
    books: [],
  };

  emit({
    type: 'progress',
    phase: 'prepare',
    status: 'running',
    message: `Loaded ${books.length} books and ${exportPlan.documents.length} documents.`,
    percent: 0,
    bookPercent: 0,
  });

  const browser = await launchBrowser({
    browserPath: config.browserPath,
    headless: true,
  });

  let activeDocPlan = null;
  let lastBookContext = null;

  try {
    const page = await openAuthenticatedPage(browser, config.cookiePath);
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
        if (config.incrementalExport !== false && exportState.shouldSkip(docPlan)) {
          completed += 1;
          bookContext.completed += 1;
          report.totals.skipped += 1;
          bookReport.summary.skipped += 1;
          exportState.markSkipped(docPlan);
          bookReport.documents.push({
            name: docPlan.node.name,
            path: docPlan.targetMdPath,
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

        let currentPhase = 'fetch-markdown';
        try {
          let rewrittenMarkdown = '';
          let artifacts = emptyArtifacts();

          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message: 'Fetching markdown...',
          }));
          const markdown = await withTimeout(
            fetchMarkdown(client, docPlan.docUrl),
            MARKDOWN_TIMEOUT_MS,
            `Timed out while fetching markdown for ${docPlan.node.name}.`,
          );

          if (isTitleOnlyMarkdown(markdown, docPlan.node.name)) {
            completed += 1;
            bookContext.completed += 1;
            report.totals.skipped += 1;
            bookReport.summary.skipped += 1;

            const emptyRecord = {
              timestamp: new Date().toISOString(),
              book_name: bookPlan.book.name,
              doc_name: docPlan.node.name,
              yuque_path: docPlan.absoluteDocUrl,
              target_md_path: docPlan.targetMdPath,
              phase: 'empty-document',
              error_type: 'EmptyDocument',
              error_message: `Document "${docPlan.node.name}" only contains the title and has no body content.`,
              retry_count: 0,
            };

            failureLogger.append(emptyRecord);
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
            options: config,
            downloadAsset: (url, kind) =>
              downloadAsset(client, bookPlan, docPlan, url, kind, emit, completed, exportPlan.documents.length, bookContext),
          });

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
          try {
            artifacts = await withTimeout(
              extractComplexArtifacts(page, docPlan, bookPlan, config),
              ARTIFACT_TIMEOUT_MS,
              `Timed out while capturing complex blocks for ${docPlan.node.name}.`,
            );
            if (artifacts.encryptedState.detectedCount > 0 && artifacts.encryptedState.remainingLockedCount > 0) {
              const encryptedRecord = {
                timestamp: new Date().toISOString(),
                book_name: bookPlan.book.name,
                doc_name: docPlan.node.name,
                yuque_path: docPlan.absoluteDocUrl,
                target_md_path: docPlan.targetMdPath,
                phase: 'encrypted-block-password-mismatch',
                error_type: 'EncryptedBlockLocked',
                error_message: buildEncryptedLockMessage(artifacts.encryptedState),
                retry_count: 0,
              };
              failureLogger.append(encryptedRecord);
            }
          } catch (artifactError) {
            artifacts = emptyArtifacts();
            emit({
              type: 'progress',
              phase: 'artifact-warning',
              status: 'warning',
              book: bookPlan.book.name,
              doc: docPlan.node.name,
              targetMdPath: docPlan.targetMdPath,
              message: `${bookPlan.book.name} / ${docPlan.node.name}: Complex block capture skipped: ${errorToMessage(artifactError)}`,
              error: errorToMessage(artifactError),
              percent: percent(completed, exportPlan.documents.length),
              bookPercent: percent(bookContext.completed, bookContext.total),
              bookCompleted: bookContext.completed,
              bookTotal: bookContext.total,
            });
          }

          currentPhase = 'write-markdown';
          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message: 'Writing markdown file...',
          }));
          const finalMarkdown = mergeMarkdownWithArtifacts(rewrittenMarkdown, artifacts, docPlan.targetMdPath);
          fs.writeFileSync(docPlan.targetMdPath, finalMarkdown, 'utf8');

          completed += 1;
          bookContext.completed += 1;
          report.totals.exported += 1;
          bookReport.summary.exported += 1;
          exportState.markExported(docPlan);
          bookReport.documents.push({
            name: docPlan.node.name,
            path: docPlan.targetMdPath,
            yuquePath: docPlan.absoluteDocUrl,
            status: 'exported',
          });
          emit(buildDocEvent({
            bookPlan,
            docPlan,
            completed,
            totalDocuments: exportPlan.documents.length,
            bookCompleted: bookContext.completed,
            bookTotal: bookContext.total,
            message: `Exported ${docPlan.node.name}`,
            status: 'success',
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
            const artifacts = await safeExtractArtifacts(page, docPlan, bookPlan, {
              ...config,
              forceFallbackSnapshot: true,
              fallbackReason: 'export-failure',
            });
            fs.writeFileSync(docPlan.targetMdPath, buildPlaceholderMarkdown(docPlan, failure, artifacts), 'utf8');
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

        activeDocPlan = null;
      }
    }

    report.finishedAt = new Date().toISOString();
    report.status = 'success';
    exportState.saveMeta({
      status: 'success',
      lastRunFinishedAt: report.finishedAt,
    });
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
    await browser.close();
  }
}

export async function exportMarkDownFiles() {
  const config = {
    browserPath: process.env.BROWSER_PATH || '',
    cookiePath: process.env.COOKIE_PATH || path.join(process.cwd(), 'cookies.json'),
    outputDir: process.env.EXPORT_PATH || path.join(process.cwd(), 'output'),
    selectedBooks: [],
    downloadImages: process.env.DOWNLOAD_IMAGES !== 'false',
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS !== 'false',
    incrementalExport: process.env.INCREMENTAL_EXPORT !== 'false',
    encryptedBlockPasswords: parseEnvPasswordList(process.env.ENCRYPTED_BLOCK_PASSWORDS, process.env.ENCRYPTED_BLOCK_PASSWORD),
    encryptedBlockPassword: process.env.ENCRYPTED_BLOCK_PASSWORD || '',
    complexBlockMode: 'snapshot-first',
    assetLayout: 'book_assets',
    jobControlPath: '',
  };
  return await exportBooks(config, (event) => {
    if (event.message) {
      console.log(event.message);
    }
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

async function downloadAsset(client, bookPlan, docPlan, assetUrl, kind, emit, completed, totalDocuments, bookContext) {
  if (bookPlan.assetCache.has(assetUrl)) {
    return bookPlan.assetCache.get(assetUrl);
  }

  const parsed = new URL(assetUrl);
  const folder = kind === 'image' ? bookPlan.assets.images : bookPlan.assets.files;
  const rawName = sanitizeFileName(path.basename(parsed.pathname) || `${docPlan.node.name}-${kind}`);
  const fileName = reserveAssetName(bookPlan, folder, rawName);
  const targetPath = path.join(folder, fileName);

  emit(buildDocEvent({
    bookPlan,
    docPlan,
    completed,
    totalDocuments,
    bookCompleted: bookContext.completed,
    bookTotal: bookContext.total,
    message: `Downloading ${kind}: ${fileName}`,
  }));

  const response = await client.get(assetUrl, {
    responseType: 'arraybuffer',
    transformResponse: [(value) => value],
  });

  fs.writeFileSync(targetPath, response.data);
  bookPlan.assetCache.set(assetUrl, targetPath);
  return targetPath;
}

function reserveAssetName(bookPlan, folder, fileName) {
  const seen = bookPlan.assetNames.get(folder) ?? new Set();
  bookPlan.assetNames.set(folder, seen);
  return uniqueName(fileName, seen);
}

async function extractComplexArtifacts(page, docPlan, bookPlan, options = {}) {
  await page.goto(docPlan.absoluteDocUrl, {
    timeout: 120000,
    waitUntil: 'networkidle2',
  });

  const encryptedState = await unlockEncryptedBlocks(
    page,
    options.encryptedBlockPasswords && options.encryptedBlockPasswords.length > 0
      ? options.encryptedBlockPasswords
      : options.encryptedBlockPassword || '',
  );
  const pageData = await page.evaluate((selectorGroups, encryptedSelectors) => {
    const root =
      document.querySelector('article') ||
      document.querySelector('.ne-viewer-body') ||
      document.querySelector('.lake-content') ||
      document.querySelector('.yuque-doc-content') ||
      document.body;

    const hasSelectorMatch = (selectors) => selectors.some((selector) => root.querySelector(selector));

    const tables = Array.from(root.querySelectorAll('table')).map((table) =>
      Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent.trim()),
      ),
    );

    const encryptedTexts = Array.from(root.querySelectorAll(encryptedSelectors.content))
      .map((node) => (node.innerText || node.textContent || '').replace(/\u00a0/g, ' ').trim())
      .map((text) => text.replace(/\n{3,}/g, '\n\n').trim())
      .filter((text) => text && text.length > 0);

    const lockedEncryptedCount = root.querySelectorAll(encryptedSelectors.input).length;
    const artifactKinds = [];
    for (const [kind, selectors] of Object.entries(selectorGroups)) {
      if (kind === 'encrypted') {
        continue;
      }
      if (hasSelectorMatch(selectors)) {
        artifactKinds.push(kind);
      }
    }

    return {
      tables,
      artifactKinds,
      encryptedTexts,
      lockedEncryptedCount,
    };
  }, COMPLEX_ARTIFACT_SELECTORS, ENCRYPTED_DOM_SELECTORS);
  const extractedEncryptedTexts = await extractEncryptedBlockTexts(page);

  const artifacts = {
    ...emptyArtifacts(),
    tables: pageData.tables.filter((table) => table.length > 0),
    encryptedTexts: dedupeTexts(extractedEncryptedTexts.length > 0 ? extractedEncryptedTexts : pageData.encryptedTexts),
    encryptedState: {
      ...encryptedState,
      lockedEncryptedCount: pageData.lockedEncryptedCount,
    },
  };
  Object.assign(artifacts, resolveArtifactFallback(pageData, artifacts.encryptedState, options));

  if (artifacts.requiresFallback) {
    const fileName = reserveAssetName(
      bookPlan,
      bookPlan.assets.blocks,
      sanitizeFileName(`${docPlan.node.name}-snapshot.png`),
    );
    const targetPath = path.join(bookPlan.assets.blocks, fileName);
    const container = await findFallbackCaptureTarget(page, artifacts, options);

    if (container) {
      await container.screenshot({ path: targetPath });
    } else {
      await page.screenshot({ path: targetPath, fullPage: true });
    }
    artifacts.blockImages.push(targetPath);
  }

  return artifacts;
}

async function unlockEncryptedBlocks(page, passwords) {
  await clearEncryptedBlockSkipMarkers(page);
  const detectedCount = await countLockedEncryptedInputs(page);
  if (!detectedCount) {
    return {
      attempted: false,
      detectedCount: 0,
      unlockedCount: 0,
      remainingLockedCount: 0,
      attemptedPasswordCount: 0,
      matchedPassword: '',
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
    };
  }

  const matchedPasswords = [];
  let attempted = false;

  while ((await countPendingLockedEncryptedBlocks(page)) > 0) {
    const result = await unlockNextEncryptedBlock(page, candidates, matchedPasswords);
    attempted = attempted || result.attempted;
    if (result.status === 'unlocked' && result.password && !matchedPasswords.includes(result.password)) {
      matchedPasswords.push(result.password);
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

async function unlockNextEncryptedBlock(page, passwords, matchedPasswords = []) {
  const orderedPasswords = [...matchedPasswords, ...passwords.filter((password) => !matchedPasswords.includes(password))];
  const beforeCount = await countLockedEncryptedInputs(page);
  if (beforeCount === 0) {
    return { attempted: false, status: 'none', password: '' };
  }

  for (const password of orderedPasswords) {
    const prepared = await fillFirstPendingEncryptedBlockPassword(page, password);
    if (!prepared) {
      return { attempted: false, status: 'none', password: '' };
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
      return { attempted: true, status: 'unlocked', password };
    } catch {
      await sleep(500);
    }
  }

  await markFirstPendingEncryptedBlockSkipped(page);
  return {
    attempted: orderedPasswords.length > 0,
    status: 'skipped',
    password: '',
  };
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

async function extractEncryptedBlockTexts(page) {
  return await page.evaluate((contentSelector) => {
    return Array.from(document.querySelectorAll(contentSelector))
      .map((node) => (node.innerText || node.textContent || '').replace(/\u00a0/g, ' '))
      .map((text) => text.replace(/\n{3,}/g, '\n\n').trim())
      .filter((text) => text.length > 0);
  }, ENCRYPTED_DOM_SELECTORS.content);
}

async function safeExtractArtifacts(page, docPlan, bookPlan, options = {}) {
  try {
    return await extractComplexArtifacts(page, docPlan, bookPlan, options);
  } catch {
    return emptyArtifacts(options.forceFallbackSnapshot ? 'export-failure' : '');
  }
}

export function mergeMarkdownWithArtifacts(markdown, artifacts, targetMdPath) {
  let output = markdown.trimEnd();
  let positionedEncryptedInsertCount = 0;

  if (artifacts.tables.length > 0) {
    output += '\n\n## 导出的表格\n';
    for (const table of artifacts.tables) {
      output += `\n${tableToMarkdown(table)}\n`;
    }
  }

  if (artifacts.encryptedTexts.length > 0) {
    const positioned = injectEncryptedTextsIntoMarkdown(output, artifacts.encryptedTexts);
    output = positioned.markdown;
    positionedEncryptedInsertCount = positioned.insertedCount;
  }

  if (artifacts.encryptedTexts.length > positionedEncryptedInsertCount) {
    output += '\n\n## 加密文本块导出\n';
    for (const blockText of artifacts.encryptedTexts.slice(positionedEncryptedInsertCount)) {
      output += `\n${toBlockQuote(blockText)}\n`;
    }
  } else if (artifacts.encryptedTexts.length === 0 && artifacts.encryptedState.detectedCount > 0) {
    output += '\n\n## 加密文本块导出\n';
    if (artifacts.encryptedState.attempted && artifacts.encryptedState.remainingLockedCount === 0) {
      output += '\n> 已检测到加密文本块，但未能提取到稳定文本内容，已在下方保留页面快照。\n';
    } else if (artifacts.encryptedState.attemptedPasswordCount > 0) {
      output += `\n> 检测到加密文本块，已依次尝试 ${artifacts.encryptedState.attemptedPasswordCount} 个预设密码，但均未解锁，已跳过加密内容并保留页面快照。\n`;
    } else {
      output += '\n> 检测到加密文本块，但当前未配置可用密码，已跳过加密内容并保留页面快照。\n';
    }
  }

  const fallbackNotice = buildFallbackNotice(artifacts.fallbackReason);
  if (shouldAppendFallbackSection(artifacts)) {
    output += '\n\n## 语雀扩展内容\n';
    if (fallbackNotice) {
      output += `\n> ${fallbackNotice}\n`;
    }
    for (const blockImage of artifacts.blockImages) {
      output += `\n![复杂内容快照](${relativeMarkdownPath(targetMdPath, blockImage)})\n`;
    }
  }

  return output.trimEnd() + '\n';
}

function buildPlaceholderMarkdown(docPlan, failure, artifacts) {
  let output = `# ${docPlan.node.name}\n\n`;
  output += '此文档未能直接导出为标准 Markdown，已保留失败信息和可用快照。\n\n';
  output += `- 语雀地址: ${docPlan.absoluteDocUrl}\n`;
  output += `- 导出目标: ${docPlan.targetMdPath}\n`;
  output += `- 失败阶段: ${failure.phase}\n`;
  output += `- 失败原因: ${failure.error_message}\n`;

  if (artifacts.tables.length > 0) {
    output += '\n## 导出的表格\n';
    for (const table of artifacts.tables) {
      output += `\n${tableToMarkdown(table)}\n`;
    }
  }

  if (artifacts.encryptedTexts.length > 0) {
    output += '\n## 加密文本块导出\n';
    for (const blockText of artifacts.encryptedTexts) {
      output += `\n${toBlockQuote(blockText)}\n`;
    }
  }

  const placeholderFallbackNotice = buildFallbackNotice(artifacts.fallbackReason || 'export-failure');
  if (placeholderFallbackNotice && artifacts.blockImages.length > 0) {
    output += `\n> ${placeholderFallbackNotice}\n`;
  }
  if (artifacts.blockImages.length > 0) {
    output += '\n## 语雀扩展内容\n';
    for (const blockImage of artifacts.blockImages) {
      output += `\n![复杂内容快照](${relativeMarkdownPath(docPlan.targetMdPath, blockImage)})\n`;
    }
  }

  return output.trimEnd() + '\n';
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
    bookPercent: percent(bookContext?.completed ?? 0, bookContext?.total ?? 0),
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
    manifestPath: report.manifestPath,
    reportPath: report.reportPath,
    statePath: report.statePath,
    failureCsv: failureLogger.filePath,
    totals: report.totals,
  };
  emit(result);
  return report;
}

export function emptyArtifacts(fallbackReason = '') {
  return {
    tables: [],
    blockImages: [],
    encryptedTexts: [],
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
  };
}

export function resolveArtifactFallback(pageData, encryptedState, options = {}) {
  const artifactKinds = dedupeTexts(pageData?.artifactKinds ?? []);
  if (options.forceFallbackSnapshot) {
    return {
      artifactKinds,
      requiresFallback: true,
      fallbackReason: options.fallbackReason || 'export-failure',
    };
  }

  if (artifactKinds.length > 0) {
    return {
      artifactKinds,
      requiresFallback: true,
      fallbackReason: artifactKinds[0],
    };
  }

  const hasLockedEncrypted =
    (encryptedState?.detectedCount ?? 0) > 0 &&
    ((encryptedState?.remainingLockedCount ?? 0) > 0 || (pageData?.encryptedTexts?.length ?? 0) === 0);

  if (hasLockedEncrypted) {
    return {
      artifactKinds: ['encrypted'],
      requiresFallback: true,
      fallbackReason: 'encrypted-fallback',
    };
  }

  return {
    artifactKinds: [],
    requiresFallback: false,
    fallbackReason: '',
  };
}

function shouldAppendFallbackSection(artifacts) {
  return artifacts.blockImages.length > 0 && FALLBACK_ARTIFACT_REASONS.has(artifacts.fallbackReason);
}

function buildFallbackNotice(fallbackReason) {
  const notices = {
    board: '宸叉娴嬪埌鐪熷疄鐢绘澘鍐呭锛屽凡淇濈暀 PNG 蹇収銆',
    mindmap: '宸叉娴嬪埌鐪熷疄鎬濈淮瀵煎浘鍐呭锛屽凡淇濈暀 PNG 蹇収銆',
    datatable: '宸叉娴嬪埌鏁版嵁琛ㄧ瓑澶嶆潅鍐呭锛屽凡淇濈暀 PNG 蹇収銆',
    'encrypted-fallback': '鍔犲瘑鍧楁湭鑳藉畬鏁磋В閿侊紝宸蹭繚鐣欏眬閮ㄥ揩鐓т綔涓哄厹搴曡褰曘',
    'export-failure': '姝ｆ枃瀵煎嚭澶辫触锛屽凡淇濈暀鍙敤蹇収浣滀负鍏滃簳璁板綍銆',
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

function toBlockQuote(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line || ' '}`)
    .join('\n');
}

function injectEncryptedTextsIntoMarkdown(markdown, encryptedTexts) {
  if (!markdown || !Array.isArray(encryptedTexts) || encryptedTexts.length === 0) {
    return { markdown, insertedCount: 0 };
  }

  let insertedCount = 0;
  const replaced = markdown.replace(
    /\[(此处为语雀卡片，点击链接查看)\]\((https?:\/\/(?:www\.)?yuque\.com\/docs\/\d+(?:#[^)]+)?)\)/g,
    (match) => {
      const blockText = encryptedTexts[insertedCount];
      if (!blockText) {
        return match;
      }
      insertedCount += 1;
      return toBlockQuote(blockText);
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
