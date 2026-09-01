import assert from 'node:assert/strict';
import test from 'node:test';
import { getAllBooks, scanAllBooks, serializeBooks } from '../src/toc.js';

function createHttpError(status, message = `Request failed with status code ${status}`) {
  const error = new Error(message);
  error.response = { status };
  return error;
}

function createBookStacks(...books) {
  return {
    data: [
      {
        books: books.map((book, index) => ({
          id: book.id ?? index + 1,
          name: book.name ?? `知识库 ${index + 1}`,
          slug: book.slug ?? `book-${index + 1}`,
          user: { login: 'demo' },
        })),
      },
    ],
  };
}

function createCatalog(title = '文档') {
  return {
    data: [
      {
        id: 101,
        uuid: 'doc-1',
        title,
        url: 'doc-1',
        type: 'DOC',
        parent_uuid: '',
        child_uuid: '',
        sibling_uuid: '',
      },
    ],
  };
}

test('scanAllBooks skips one inaccessible book and keeps the remaining books', async () => {
  const client = {
    async getJson(url) {
      if (url.includes('book_stacks')) {
        return createBookStacks({ id: 1, name: '正常知识库' }, { id: 2, name: '已删除知识库' });
      }
      if (url.includes('book_id=1')) {
        return createCatalog('正常文档');
      }
      throw createHttpError(404);
    },
  };

  const result = await scanAllBooks(client, { retryDelayMs: 0 });

  assert.equal(result.totalBooks, 2);
  assert.equal(result.skippedBooks, 1);
  assert.deepEqual(serializeBooks(result.books).map((book) => book.name), ['正常知识库']);
  assert.equal(result.warnings[0].bookId, '2');
  assert.equal(result.warnings[0].category, 'not-found');
  assert.match(result.warnings[0].message, /已删除知识库.*404/);
});

test('scanAllBooks retries a temporary catalog error before succeeding', async () => {
  let catalogAttempts = 0;
  const client = {
    async getJson(url) {
      if (url.includes('book_stacks')) {
        return createBookStacks({ id: 1, name: '临时异常知识库' });
      }
      catalogAttempts += 1;
      if (catalogAttempts === 1) {
        throw createHttpError(503);
      }
      return createCatalog();
    },
  };

  const result = await scanAllBooks(client, { retryDelayMs: 0 });

  assert.equal(catalogAttempts, 2);
  assert.equal(result.books.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('scanAllBooks fails clearly instead of reporting zero when every catalog is inaccessible', async () => {
  const client = {
    async getJson(url) {
      if (url.includes('book_stacks')) {
        return createBookStacks({ id: 1, name: '知识库一' }, { id: 2, name: '知识库二' });
      }
      throw createHttpError(403);
    },
  };

  await assert.rejects(scanAllBooks(client, { retryDelayMs: 0 }), (error) => {
    assert.match(error.message, /扫描到 2 个知识库，但目录均无法读取.*知识库一.*403.*知识库二.*403/);
    assert.equal(error.scanWarnings.length, 2);
    assert.deepEqual(error.scanWarnings.map((warning) => warning.bookId), ['1', '2']);
    return true;
  });
});

test('getAllBooks keeps the legacy fail-fast behavior for export callers', async () => {
  const client = {
    async getJson(url) {
      if (url.includes('book_stacks')) {
        return createBookStacks({ id: 1, name: '知识库一' }, { id: 2, name: '知识库二' });
      }
      if (url.includes('book_id=1')) {
        return createCatalog();
      }
      throw createHttpError(404);
    },
  };

  await assert.rejects(getAllBooks(client), /Request failed with status code 404/);
});

test('scanAllBooks adds context when the main book list request fails', async () => {
  let attempts = 0;
  const client = {
    async getJson() {
      attempts += 1;
      throw createHttpError(503);
    },
  };

  await assert.rejects(scanAllBooks(client, { retryDelayMs: 0 }), /读取语雀知识库列表失败.*HTTP 503/);
  assert.equal(attempts, 2);
});

test('scanAllBooks does not retry a permanent main book list error', async () => {
  let attempts = 0;
  const client = {
    async getJson() {
      attempts += 1;
      throw createHttpError(403);
    },
  };

  await assert.rejects(scanAllBooks(client, { retryDelayMs: 0 }), /读取语雀知识库列表失败.*403/);
  assert.equal(attempts, 1);
});

test('scanAllBooks rejects an unexpected main book list response instead of reporting zero books', async () => {
  const client = {
    async getJson() {
      return '<html>unexpected response</html>';
    },
  };

  await assert.rejects(scanAllBooks(client, { retryDelayMs: 0 }), /知识库列表返回格式异常/);
});
