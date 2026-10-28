import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarksPageUrl,
  deduplicateDocumentEntries,
  fetchAllMarks,
  fetchMarksPage,
  findMissingTargetActionIds,
  normalizeMarkActions,
  summarizeMarksPayload,
} from '../src/document-sources.js';

test('收藏探针仅构造已观察到的第一页 marks 请求', () => {
  assert.equal(
    buildMarksPageUrl(),
    'https://www.yuque.com/api/mine/marks?offset=0&limit=100&type=all',
  );
  assert.throws(() => buildMarksPageUrl({ offset: -1 }), /offset 必须是非负整数/);
  assert.throws(() => buildMarksPageUrl({ limit: 101 }), /limit 必须在 1 到 100 之间/);
  assert.throws(() => buildMarksPageUrl({ type: 'docs' }), /仅支持已观察到的 type=all/);
});

test('收藏响应摘要区分文档和知识库且不泄露条目字段值', () => {
  const result = summarizeMarksPayload({
    data: {
      actionTag: null,
      actions: [
        {
          id: 1,
          action_name: 'mark_doc',
          target_type: 'Doc',
          title: 'private title',
          target: { id: 2, slug: 'private-slug', name: 'private title' },
        },
        {
          id: 3,
          action_name: 'mark_book',
          target_type: 'Book',
          target: { id: 4, slug: 'private-book', name: 'private book' },
        },
      ],
    },
  });

  assert.deepEqual(result.targetTypes, { Doc: 1, Book: 1 });
  assert.equal(result.missingTargetCount, 0);
  assert.deepEqual(result.actionNames, { mark_doc: 1, mark_book: 1 });
  assert.deepEqual(result.actionFields, ['action_name', 'id', 'target', 'target_type', 'title']);
  assert.deepEqual(result.targetFieldsByType, {
    Book: ['id', 'name', 'slug'],
    Doc: ['id', 'name', 'slug'],
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('收藏探针拒绝非预期响应，不把结构变化当成空列表', async () => {
  await assert.rejects(
    fetchMarksPage({ async getJson() { return { data: { items: [] } }; } }),
    /缺少 data\.actions 数组/,
  );
});

test('缺失收藏目标只报告数量与不透明 action id，不输出标题或路径', () => {
  const payload = {
    data: {
      actions: [
        { id: 101, target_type: 'Doc', title: 'private title', _url: '/go/doc/private' },
        { id: 102, target_type: 'Book', title: 'private book', target: {} },
      ],
    },
  };
  const ids = findMissingTargetActionIds(payload);
  const summary = summarizeMarksPayload(payload);

  assert.deepEqual(ids, ['101']);
  assert.equal(summary.missingTargetCount, 1);
  assert.equal(JSON.stringify(summary).includes('private'), false);
});

test('收藏分页按 offset 收齐条目并保留服务器总数', async () => {
  const requests = [];
  const pages = new Map([
    [0, { data: { totalItems: 3, actions: [{ id: 1 }, { id: 2 }] } }],
    [2, { data: { totalItems: 3, actions: [{ id: 3 }] } }],
  ]);
  const result = await fetchAllMarks({
    async getJson(url) {
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('offset'));
      requests.push({ offset, limit: Number(parsed.searchParams.get('limit')) });
      return pages.get(offset);
    },
  }, { pageSize: 2, maxItems: 10 });

  assert.deepEqual(result, {
    totalItems: 3,
    actions: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  assert.deepEqual(requests, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }]);
});

test('收藏分页逐页报告进度，并在页间停止时明确返回部分结果', async () => {
  const progress = [];
  let stopped = false;
  let requests = 0;
  const result = await fetchAllMarks({
    async getJson() {
      requests += 1;
      return {
        data: {
          totalItems: 3,
          actions: requests === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
        },
      };
    },
  }, {
    pageSize: 2,
    maxItems: 10,
    shouldStop: () => stopped,
    onProgress: (event) => {
      progress.push(event);
      stopped = true;
    },
  });

  assert.deepEqual(progress, [{ completedItems: 2, totalItems: 3, pageCount: 1 }]);
  assert.equal(requests, 1);
  assert.deepEqual(result, {
    totalItems: 3,
    actions: [{ id: 1 }, { id: 2 }],
    cancelled: true,
    pagesRead: 1,
  });
});

test('收藏分页对总量超限、空页、重复项和总数变化明确失败', async () => {
  for (const invalidTotal of [null, undefined, '', '3', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      fetchAllMarks({
        async getJson() { return { data: { totalItems: invalidTotal, actions: [] } }; },
      }, { pageSize: 2, maxItems: 10 }),
      /缺少有效的 data\.actions 或 data\.totalItems/,
      `totalItems=${String(invalidTotal)} 必须拒绝`,
    );
  }

  await assert.rejects(
    fetchAllMarks({
      async getJson() { return { data: { totalItems: 11, actions: [] } }; },
    }, { pageSize: 2, maxItems: 10 }),
    /超过本地安全上限/,
  );

  await assert.rejects(
    fetchAllMarks({
      async getJson() { return { data: { totalItems: 2, actions: [] } }; },
    }, { pageSize: 2, maxItems: 10 }),
    /返回空页/,
  );

  await assert.rejects(
    fetchAllMarks({
      async getJson(url) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        return {
          data: {
            totalItems: 3,
            actions: offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }],
          },
        };
      },
    }, { pageSize: 2, maxItems: 10 }),
    /重复条目/,
  );

  await assert.rejects(
    fetchAllMarks({
      async getJson(url) {
        const offset = Number(new URL(url).searchParams.get('offset'));
        return {
          data: {
            totalItems: offset === 0 ? 3 : 4,
            actions: offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }, { id: 4 }],
          },
        };
      },
    }, { pageSize: 2, maxItems: 10 }),
    /totalItems 发生变化/,
  );
});

test('收藏摘要暴露协作标记，用于区分普通收藏与协作文档', () => {
  const result = summarizeMarksPayload({
    data: {
      actions: [
        { action_name: 'mark_doc', target_type: 'Doc', action_option: 'doc' },
        { action_name: 'mark_doc', target_type: 'Doc', action_option: 'collaboration_Doc_doc' },
        { action_name: 'mark_doc', target_type: 'Doc', action_option: 'collaboration_Doc_sheet' },
        { action_name: 'mark_book', target_type: 'Book', action_option: 'book' },
      ],
    },
  });

  assert.deepEqual(result.actionOptions, {
    book: 1,
    'collaboration_Doc_doc': 1,
    'collaboration_Doc_sheet': 1,
    doc: 1,
  });
});

test('收藏条目标准化只生成具体文档项，不展开知识库或猜测缺失目标', () => {
  const result = normalizeMarkActions({
    data: {
      actions: [
        {
          action_name: 'mark_doc',
          action_option: 'doc',
          target_type: 'Doc',
          title: 'sample title',
          target: {
            id: 123,
            type: 'Doc',
            slug: 'doc-slug',
            title: 'sample title',
            book_id: 456,
            book: {
              slug: 'book-slug',
              user: { login: 'owner' },
            },
          },
        },
        {
          action_name: 'mark_doc',
          action_option: 'collaboration_Doc_doc',
          target_type: 'Doc',
          target: {
            id: 789,
            type: 'Sheet',
            slug: 'sheet-slug',
            title: 'sheet title',
            book_id: 456,
            book: { slug: 'book-slug', user: { login: 'owner' } },
          },
        },
        { action_name: 'mark_doc', action_option: 'doc', target_type: 'Doc', target_id: 999 },
        { action_name: 'mark_book', action_option: 'book', target_type: 'Book' },
      ],
    },
  });

  assert.deepEqual(result[0], {
      itemType: 'document',
      documentKey: 'yuque:456:123',
      documentId: '123',
      documentSlug: 'doc-slug',
      documentType: 'Doc',
      bookId: '456',
      bookName: '',
      owner: 'owner',
      canonicalUrl: 'https://www.yuque.com/owner/book-slug/doc-slug',
      title: 'sample title',
      sourceVersion: '',
      sourceType: 'favorite',
    actionOption: 'doc',
    status: 'unverified',
  });
  assert.equal(result[1].documentType, 'Sheet');
  assert.equal(result[1].sourceType, 'collaboration');
  assert.equal(result[1].status, 'unverified');
  assert.deepEqual(result[2], {
    itemType: 'document',
    sourceType: 'favorite',
    status: 'unresolved-target',
  });
  assert.deepEqual(result[3], {
    itemType: 'book-entry',
    sourceType: 'favorite',
    status: 'not-expanded',
  });
});

test('文档来源按稳定身份去重并合并收藏与协作关系，不按标题猜测合并', () => {
  const base = {
    itemType: 'document',
    documentKey: 'yuque:456:123',
    canonicalUrl: 'https://www.yuque.com/owner/book/doc',
    title: 'shared title',
    status: 'unverified',
  };
  const result = deduplicateDocumentEntries([
    { ...base, sourceType: 'favorite', actionOption: 'doc' },
    { ...base, sourceType: 'collaboration', actionOption: 'collaboration_Doc_doc' },
    { ...base, sourceType: 'favorite', actionOption: 'doc' },
    {
      itemType: 'document',
      documentKey: 'yuque:456:789',
      canonicalUrl: 'https://www.yuque.com/owner/book/another',
      title: 'shared title',
      sourceType: 'favorite',
      actionOption: 'doc',
      status: 'unverified',
    },
    { itemType: 'book-entry', sourceType: 'favorite', status: 'not-expanded' },
    { itemType: 'document', sourceType: 'favorite', status: 'unresolved-target' },
  ]);

  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].sourceRelations.length, 2);
  assert.equal(result.documents[1].documentKey, 'yuque:456:789');
  assert.deepEqual(result.excluded.map((entry) => entry.status), ['not-expanded', 'unresolved-target']);
});

test('文档身份映射到多个规范地址时拒绝静默合并', () => {
  assert.throws(
    () => deduplicateDocumentEntries([
      {
        itemType: 'document',
        documentKey: 'yuque:456:123',
        canonicalUrl: 'https://www.yuque.com/owner/book/doc-a',
        sourceType: 'favorite',
        actionOption: 'doc',
        status: 'unverified',
      },
      {
        itemType: 'document',
        documentKey: 'yuque:456:123',
        canonicalUrl: 'https://www.yuque.com/owner/book/doc-b',
        sourceType: 'collaboration',
        actionOption: 'collaboration_Doc_doc',
        status: 'unverified',
      },
    ]),
    /拒绝自动合并/,
  );
});

test('收藏响应中的类型字符串不会成为摘要对象的原型键', () => {
  const result = summarizeMarksPayload({
    data: {
      actions: [{ action_name: '__proto__', target_type: '__proto__' }],
    },
  });

  assert.equal(result.actionNames.__proto__, 1);
  assert.equal(result.targetTypes.__proto__, 1);
});
