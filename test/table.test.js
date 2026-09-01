import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPrimaryLaketableSheet,
  isTableDocument,
  listLaketableViewTypes,
  normalizeStandaloneTableDocument,
  parseLaketableBody,
} from '../src/table.js';

function createLaketableBody() {
  return {
    type: 'Table',
    format: 'laketable',
    tableId: 'table-1',
    sheet: [
      {
        id: 'sheet-1',
        defaultView: 'view-grid',
        activeView: 'view-cards',
        views: {
          'view-grid': { id: 'view-grid', name: '表格视图', type: 'GRID' },
          'view-cards': {
            id: 'view-cards',
            name: '卡片视图',
            type: 'CARDS',
            columns: [
              { id: 'c1', hidden: false },
              { id: 'c2', hidden: false },
              { id: 'c5', hidden: true },
            ],
            cover: {
              id: 'c5',
              display: 'fit',
            },
          },
        },
        columns: [
          { id: 'c1', name: '名称', type: 'input' },
          {
            id: 'c2',
            name: '状态',
            type: 'select',
            options: [{ id: 'done', value: '已看', color: 'green' }],
          },
          { id: 'c3', name: '日期', type: 'date' },
          { id: 'c4', name: '链接', type: 'link' },
          { id: 'c5', name: '海报', type: 'image' },
        ],
      },
    ],
  };
}

test('parseLaketableBody and document helpers understand standalone table metadata', () => {
  const body = createLaketableBody();
  const docDetail = {
    type: 'Table',
    body: JSON.stringify(body),
  };

  const parsed = parseLaketableBody(docDetail.body);
  const normalized = normalizeStandaloneTableDocument(
    {
      id: 1,
      type: 'Table',
      title: 'Test',
      body: JSON.stringify(body),
    },
    [],
  );

  assert.equal(isTableDocument(docDetail), true);
  assert.equal(getPrimaryLaketableSheet(parsed).id, 'sheet-1');
  assert.deepEqual(listLaketableViewTypes(parsed.sheet[0]), ['GRID', 'CARD']);
  assert.equal(normalized.defaultViewId, 'view-grid');
  assert.equal(normalized.activeViewId, 'view-cards');
  assert.equal(normalized.tableView?.type, 'GRID');
  assert.equal(normalized.cardView?.type, 'CARD');
  assert.deepEqual(normalized.cardView?.visibleColumnIds, ['c1', 'c2']);
  assert.equal(normalized.cardView?.coverColumnId, 'c5');
});

test('normalizeStandaloneTableDocument restores select date link and image values', () => {
  const docDetail = {
    id: 53473345,
    type: 'Table',
    title: '个人观影清单',
    body: JSON.stringify(createLaketableBody()),
  };
  const records = [
    {
      id: 'r1',
      uuid: 'record-1',
      data: JSON.stringify({
        c1: { value: '星际穿越' },
        c2: { value: 'done' },
        c3: { value: { text: '2019/01/28', time: '2019-01-27T16:00:00.000Z' } },
        c4: { value: { name: 'https://example.com/movie', src: 'https://example.com/movie' } },
        c5: {
          value: [
            {
              uid: 'asset-1',
              name: 'poster.jpg',
              width: 480,
              height: 640,
              size: 12345,
              src: 'https://cdn.example.com/poster.jpg',
            },
          ],
        },
      }),
    },
  ];

  const normalized = normalizeStandaloneTableDocument(docDetail, records);
  const row = normalized.rows[0];

  assert.equal(normalized.sourceType, 'standalone-table-document');
  assert.equal(normalized.tableFormat, 'laketable');
  assert.equal(normalized.docId, 53473345);
  assert.equal(normalized.sheetId, 'sheet-1');
  assert.deepEqual(normalized.viewTypes, ['GRID', 'CARD']);
  assert.equal(normalized.rowCount, 1);
  assert.equal(normalized.columnCount, 5);
  assert.equal(normalized.cardView?.type, 'CARD');
  assert.equal(row.values.col_1, '星际穿越');
  assert.equal(row.values.col_2, '已看');
  assert.equal(row.values.col_3, '2019-01-28');
  assert.equal(row.values.col_4, 'https://example.com/movie');
  assert.deepEqual(row.values.col_5, [
    {
      uid: 'asset-1',
      name: 'poster.jpg',
      width: 480,
      height: 640,
      size: 12345,
      sourceUrl: 'https://cdn.example.com/poster.jpg',
      localPath: '',
      localRelativePath: '',
    },
  ]);
  assert.equal(row.cells[4].text, 'https://cdn.example.com/poster.jpg');
});
