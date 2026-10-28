import { type } from './const.js';
import { sanitizeFileName } from './utils.js';

class BookPage {
  constructor(id, uuid, name, url, nodeType, parentUuid, childUuid, siblingUuid, sourceVersion = '') {
    this.id = id;
    this.uuid = uuid;
    this.name = name;
    this.url = url;
    this.type = nodeType;
    this.parent_uuid = parentUuid;
    this.child_uuid = childUuid;
    this.sibling_uuid = siblingUuid;
    this.sourceVersion = sourceVersion;
  }
}

class Book {
  constructor(id, name, slug, userUrl) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.user_url = userUrl;
    this.root = null;
  }
}

export async function getAllBooks(client) {
  const rawBooks = await fetchBookEntries(client);
  const books = [];

  for (const rawBook of rawBooks) {
    const book = createBook(rawBook);
    book.root = await getBookDetail(client, book);
    books.push(book);
  }

  return books;
}

export async function scanAllBooks(client, options = {}) {
  const rawBooks = await fetchBookEntriesWithRetry(client, options);
  const books = [];
  const warnings = [];

  for (const rawBook of rawBooks) {
    const book = createBook(rawBook);
    try {
      book.root = await getBookDetailWithRetry(client, book, options);
      books.push(book);
    } catch (error) {
      warnings.push(buildBookScanWarning(book, error));
    }
  }

  // 账号明明返回了知识库，但所有目录都读取失败时不能伪装成“0 个知识库”。
  // 这种情况通常是登录态、账号权限或语雀接口整体异常，需要明确失败并保留诊断日志。
  if (rawBooks.length > 0 && books.length === 0 && warnings.length > 0) {
    const summary = warnings
      .slice(0, 3)
      .map((warning) => warning.message)
      .join('；');
    const remaining = warnings.length > 3 ? `；另有 ${warnings.length - 3} 个知识库失败` : '';
    const error = new Error(`扫描到 ${rawBooks.length} 个知识库，但目录均无法读取。${summary}${remaining}`);
    error.scanWarnings = warnings;
    throw error;
  }

  return {
    books,
    warnings,
    totalBooks: rawBooks.length,
    skippedBooks: warnings.length,
  };
}

async function fetchBookEntries(client) {
  const payload = await client.getJson('https://www.yuque.com/api/mine/book_stacks');
  if (!Array.isArray(payload?.data)) {
    throw new Error('语雀知识库列表返回格式异常，未找到有效的 data 数组。');
  }
  return payload.data.flatMap((stack) => (Array.isArray(stack?.books) ? stack.books : []));
}

async function fetchBookEntriesWithRetry(client, options = {}) {
  try {
    return await runWithRetry(() => fetchBookEntries(client), options);
  } catch (error) {
    throw new Error(`读取语雀知识库列表失败：${describeRequestFailure(error)}`, { cause: error });
  }
}

function createBook(rawBook = {}) {
  return new Book(
    rawBook.id,
    sanitizeFileName(rawBook.name),
    rawBook.slug,
    rawBook.user?.login,
  );
}

async function getBookDetailWithRetry(client, book, options = {}) {
  return await runWithRetry(() => getBookDetail(client, book), options);
}

async function runWithRetry(operation, options = {}) {
  const configuredAttempts = Number(options.maxAttempts ?? 2);
  const configuredDelay = Number(options.retryDelayMs ?? 350);
  const maxAttempts = Number.isFinite(configuredAttempts) ? Math.max(1, Math.floor(configuredAttempts)) : 2;
  const retryDelayMs = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 350;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableScanError(error)) {
        break;
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs * attempt);
      }
    }
  }

  throw lastError || new Error('语雀请求失败，但没有返回可用的错误信息。');
}

function buildBookScanWarning(book, error) {
  const statusCode = getRequestStatus(error);
  const bookId = String(book.id ?? '').trim();
  const bookName = String(book.name || '未命名知识库').trim();
  const reason = describeRequestFailure(error);
  const identity = bookId ? `“${bookName}”（ID: ${bookId}）` : `“${bookName}”`;

  return {
    bookId,
    bookName,
    statusCode,
    category: classifyScanFailure(statusCode, error),
    reason,
    message: `已跳过知识库${identity}：${reason}`,
  };
}

function classifyScanFailure(statusCode, error) {
  if (statusCode === 404) return 'not-found';
  if (statusCode === 401 || statusCode === 403) return 'permission';
  if (isRetryableScanError(error)) return 'temporary';
  return 'unknown';
}

function describeRequestFailure(error) {
  const statusCode = getRequestStatus(error);
  if (statusCode === 404) {
    return '语雀返回 404，该知识库可能已删除、已迁移或当前账号无权访问';
  }
  if (statusCode === 401 || statusCode === 403) {
    return `语雀返回 ${statusCode}，当前登录态或账号权限不足`;
  }
  if (statusCode === 429) {
    return '语雀请求过于频繁，重试后仍未恢复';
  }
  if (statusCode >= 500) {
    return `语雀服务暂时异常（HTTP ${statusCode}），重试后仍未恢复`;
  }
  if (isTimeoutError(error)) {
    return '请求语雀超时，重试后仍未恢复';
  }
  return String(error?.message || error || '未知错误').trim();
}

function getRequestStatus(error) {
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode ?? 0);
  return Number.isFinite(status) && status > 0 ? status : 0;
}

function isRetryableScanError(error) {
  const statusCode = getRequestStatus(error);
  if ([408, 425, 429].includes(statusCode) || statusCode >= 500) {
    return true;
  }
  return isTimeoutError(error) || ['ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH'].includes(error?.code);
}

function isTimeoutError(error) {
  return error?.code === 'ETIMEDOUT' || /timeout|timed out/i.test(String(error?.message || ''));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function filterBooks(books, selectedBooks = []) {
  if (!selectedBooks || selectedBooks.length === 0) {
    return books;
  }

  const selectedSet = new Set(selectedBooks.map((value) => String(value)));
  return books.filter((book) => selectedSet.has(String(book.id)));
}

export function flattenDocumentNodes(node, result = []) {
  if (!node) {
    return result;
  }

  if (node.type === type.Document || node.type === type.TitleDoc) {
    result.push(node);
  }

  for (const child of node.children ?? []) {
    flattenDocumentNodes(child, result);
  }

  return result;
}

export function serializeBooks(books) {
  return books.map((book) => ({
    id: book.id,
    name: book.name,
    slug: book.slug,
    userUrl: book.user_url,
    documentCount: flattenDocumentNodes(book.root).length,
    root: serializeNode(book.root),
  }));
}

function serializeNode(node) {
  if (!node) {
    return null;
  }

  return {
    name: node.name,
    type: node.type,
    url: node.object?.url ?? null,
    id: node.object?.id ?? null,
    sourceVersion: node.object?.sourceVersion ?? '',
    children: (node.children ?? []).map(serializeNode),
  };
}

async function getBookDetail(client, book) {
  const payload = await client.getJson(`https://www.yuque.com/api/catalog_nodes?book_id=${book.id}`);
  const uuidMap = new Map();
  let firstSubItem;

  for (const item of payload.data ?? []) {
    if (firstSubItem === undefined && item.parent_uuid === '') {
      firstSubItem = item;
    }
    const page = new BookPage(
      item.id,
      item.uuid,
      sanitizeFileName(item.title),
      item.url,
      item.type,
      item.parent_uuid,
      item.child_uuid,
      item.sibling_uuid,
      item.updated_at || item.updatedAt || item.version_id || '',
    );
    uuidMap.set(page.uuid, page);
  }

  const root = { name: book.name, type: type.Book, object: book };
  if (firstSubItem) {
    buildDirectoryTree(uuidMap, firstSubItem.uuid, root);
  }

  return root;
}

function buildDirectoryTree(uuidMap, uuid, node) {
  const item = uuidMap.get(uuid);
  if (!item) {
    return;
  }

  const childNode = {
    name: item.name,
    type: item.type,
    object: item,
  };

  if (item.child_uuid) {
    if (item.type === type.Document) {
      childNode.type = type.TitleDoc;
    }
    buildDirectoryTree(uuidMap, item.child_uuid, childNode);
  }

  if (item.sibling_uuid) {
    buildDirectoryTree(uuidMap, item.sibling_uuid, node);
  }

  if (!node.children) {
    node.children = [];
  }
  node.children.push(childNode);
}
