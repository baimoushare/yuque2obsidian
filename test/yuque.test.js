import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBrowserLaunchOptions,
  fetchAllTableRecords,
  fetchDocDetail,
  fetchMarkdown,
  fetchTableRecordContent,
  isTableDocument,
  parseTableDocumentBody,
} from '../src/yuque.js';

test('fetchMarkdown keeps markdown that embeds html code examples', async () => {
  const markdown = [
    '# Demo',
    '',
    '```html',
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<body>Hello</body>',
    '</html>',
    '```',
  ].join('\n');

  const client = {
    async get() {
      return {
        data: markdown,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
        },
      };
    },
  };

  const result = await fetchMarkdown(client, 'demo/book/doc');
  assert.equal(result, markdown);
});

test('fetchMarkdown rejects full html document responses', async () => {
  const client = {
    async get() {
      return {
        data: '<!doctype html><html><head><title>Login</title></head><body>Sign in</body></html>',
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      };
    },
  };

  await assert.rejects(
    fetchMarkdown(client, 'demo/book/doc'),
    /Received an HTML document instead of markdown\. Yuque may have returned a sign-in, permission, or error page\./,
  );
});

test('buildBrowserLaunchOptions derives a persistent profile dir from cookiePath for headless export', () => {
  const options = buildBrowserLaunchOptions({
    cookiePath: 'D:/tmp/yuque/cookies.json',
    headless: true,
  });

  assert.equal(options.headless, 'new');
  assert.match(options.userDataDir || '', /\.yuque-login-profile$/);
});

test('buildBrowserLaunchOptions keeps an explicit login profile dir when provided', () => {
  const options = buildBrowserLaunchOptions({
    cookiePath: 'D:/tmp/yuque/cookies.json',
    loginProfileDir: 'D:/tmp/custom-profile',
    headless: false,
  });

  assert.equal(options.userDataDir, 'D:/tmp/custom-profile');
  assert.equal(options.defaultViewport, null);
});

test('fetchDocDetail requests the structured docs api with book context', async () => {
  let requestedUrl = '';
  const client = {
    async getJson(url) {
      requestedUrl = url;
      return {
        data: {
          id: 42,
          title: 'Board',
        },
      };
    },
  };

  const result = await fetchDocDetail(client, 'doc-slug', 9527);
  assert.equal(result.id, 42);
  assert.match(
    requestedUrl,
    /https:\/\/www\.yuque\.com\/api\/docs\/doc-slug\?include_contributors=true&include_like=true&include_hits=true&merge_dynamic_data=false&book_id=9527/,
  );
});

test('isTableDocument and parseTableDocumentBody detect standalone laketable docs', () => {
  const docDetail = {
    type: 'Table',
    body: JSON.stringify({
      type: 'Table',
      format: 'laketable',
      sheet: [{ id: 'sheet-1', columns: [] }],
    }),
  };

  assert.equal(isTableDocument(docDetail), true);
  assert.equal(parseTableDocumentBody(docDetail).format, 'laketable');
});

test('fetchAllTableRecords paginates until hasMore is false', async () => {
  const requested = [];
  const client = {
    async getJson(url) {
      requested.push(url);
      if (url.includes('offset=0')) {
        return {
          records: [{ id: 'r1' }, { id: 'r2' }],
          hasMore: true,
        };
      }
      return {
        records: [{ id: 'r3' }],
        hasMore: false,
      };
    },
  };

  const records = await fetchAllTableRecords(client, {
    docId: 42,
    sheetId: 'sheet-1',
    limit: 2,
  });

  assert.deepEqual(records.map((record) => record.id), ['r1', 'r2', 'r3']);
  assert.equal(requested.length, 2);
});

test('fetchTableRecordContent posts the requested record ids', async () => {
  let requestBody = null;
  const client = {
    async postJson(_url, body) {
      requestBody = body;
      return {
        content: {
          recordA: { text: 'hello' },
        },
      };
    },
  };

  const payload = await fetchTableRecordContent(client, {
    docId: 42,
    sheetId: 'sheet-1',
    recordIds: ['recordA', 'recordB'],
  });

  assert.deepEqual(payload, {
    recordA: { text: 'hello' },
  });
  assert.deepEqual(requestBody, {
    docId: 42,
    docType: 'Doc',
    sheetId: 'sheet-1',
    recordIds: ['recordA', 'recordB'],
  });
});
