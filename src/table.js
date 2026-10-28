import path from 'path';
import { sanitizeFileName, stripHtml } from './utils.js';

export const TABLE_RECORD_FETCH_LIMIT = 5000;

export function isTableDocument(docDetail = {}) {
  if (docDetail?.type === 'Table') {
    return true;
  }

  const parsed = parseLaketableBody(docDetail?.body ?? docDetail?.content ?? '');
  return Boolean(parsed?.format === 'laketable' && parsed?.type === 'Table');
}

export function parseLaketableBody(body) {
  if (!body) {
    return null;
  }

  if (typeof body === 'object') {
    return body;
  }

  try {
    const parsed = JSON.parse(String(body));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function getPrimaryLaketableSheet(parsedBody) {
  return parsedBody?.sheet?.[0] ?? null;
}

export function listLaketableViewTypes(sheet = {}) {
  return Array.from(
    new Set(
      Object.values(sheet?.views ?? {})
        .map((view) => canonicalizeLaketableViewType(view?.type))
        .filter(Boolean),
    ),
  );
}

export function normalizeLaketableViews(sheet = {}, columns = []) {
  const columnMap = new Map(columns.map((column) => [column.id, column]));
  const views = Object.values(sheet?.views ?? {})
    .map((view) => normalizeLaketableView(view, columnMap))
    .filter(Boolean);

  const byId = new Map(views.map((view) => [view.id, view]));
  const activeViewId = String(sheet?.activeView || '').trim();
  const defaultViewId = String(sheet?.defaultView || '').trim();
  const activeView = byId.get(activeViewId) || views[0] || null;
  const defaultView = byId.get(defaultViewId) || activeView || null;

  return {
    views,
    activeViewId,
    defaultViewId,
    activeView,
    defaultView,
    tableView: views.find((view) => view.type === 'GRID') || null,
    cardView: views.find((view) => view.type === 'CARD') || null,
  };
}

function normalizeLaketableView(view, columnMap) {
  const id = String(view?.id || '').trim();
  const type = canonicalizeLaketableViewType(view?.type);
  if (!id || !type) {
    return null;
  }

  const orderedColumns = Array.isArray(view?.columns)
    ? view.columns
        .map((item) => {
          const columnId = String(item?.id || '').trim();
          if (!columnId) {
            return null;
          }
          const column = columnMap.get(columnId);
          return {
            id: columnId,
            hidden: item?.hidden === true,
            name: column?.name || '',
            type: column?.type || 'text',
            key: column?.key || '',
          };
        })
        .filter(Boolean)
    : [];

  const orderedColumnIds = orderedColumns.map((column) => column.id);
  const visibleColumnIds = orderedColumns
    .filter((column) => column.hidden !== true)
    .map((column) => column.id);

  return {
    id,
    name: String(view?.name || '').trim() || type,
    type,
    orderedColumns,
    orderedColumnIds,
    visibleColumnIds: visibleColumnIds.length > 0 ? visibleColumnIds : orderedColumnIds,
    coverColumnId: view?.cover?.show === false ? '' : String(view?.cover?.id || '').trim(),
    coverDisplay: String(view?.cover?.display || '').trim().toLowerCase(),
    showField: Boolean(view?.showField),
    group: Array.isArray(view?.group) ? view.group : [],
    sort: view?.sort ?? null,
  };
}

export function canonicalizeLaketableViewType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  const aliases = {
    TABLE: 'GRID',
    TABLES: 'GRID',
    CARDS: 'CARD',
  };

  return aliases[normalized] || normalized;
}

export function normalizeStandaloneTableDocument(docDetail = {}, records = []) {
  const body = parseLaketableBody(docDetail?.body ?? docDetail?.content ?? '');
  if (!body) {
    throw new Error('The Yuque table body is empty or invalid.');
  }

  const sheet = getPrimaryLaketableSheet(body);
  if (!sheet) {
    throw new Error('The Yuque laketable document does not contain a usable sheet.');
  }

  const columns = normalizeTableColumns(sheet.columns ?? []);
  const normalizedRecords = normalizeTableRecords(records, columns);
  const normalizedViews = normalizeLaketableViews(sheet, columns);

  return {
    sourceType: 'standalone-table-document',
    tableFormat: String(body.format || '').trim() || 'laketable',
    docId: docDetail?.id ?? 0,
    sheetId: sheet.id || body.sheetId || body.tableId || '',
    tableId: body.tableId || '',
    title: String(docDetail?.title || '').trim() || 'Untitled Table',
    description: String(docDetail?.description || '').trim(),
    cover: String(docDetail?.cover || '').trim(),
    rowCount: normalizedRecords.length,
    columnCount: columns.length,
    viewTypes: listLaketableViewTypes(sheet),
    defaultViewId: normalizedViews.defaultViewId,
    activeViewId: normalizedViews.activeViewId,
    defaultView: normalizedViews.defaultView,
    activeView: normalizedViews.activeView,
    tableView: normalizedViews.tableView,
    cardView: normalizedViews.cardView,
    views: normalizedViews.views,
    columns,
    rows: normalizedRecords,
    rawBody: body,
  };
}

export function normalizeTableColumns(columns = []) {
  return columns.map((column, index) => {
    const type = String(column?.type || 'text').trim().toLowerCase() || 'text';
    const key = `col_${index + 1}`;
    const options = normalizeSelectOptions(column?.options);
    return {
      key,
      id: String(column?.id || key),
      name: String(column?.name || `Column ${index + 1}`).trim() || `Column ${index + 1}`,
      type,
      rawName: String(column?.name || '').trim(),
      options,
      optionMap: new Map(options.map((option) => [option.id, option])),
      config: column?.config ?? null,
    };
  });
}

export function normalizeSelectOptions(options = []) {
  return Array.isArray(options)
    ? options
        .map((option) => ({
          id: String(option?.id || '').trim(),
          value: String(option?.value || '').trim(),
          color: String(option?.color || '').trim(),
        }))
        .filter((option) => option.id || option.value)
    : [];
}

export function normalizeTableRecords(records = [], columns = []) {
  return records.map((record, index) => normalizeTableRecord(record, columns, index));
}

export function normalizeTableRecord(record = {}, columns = [], index = 0) {
  const payload = parseTableRecordPayload(record?.data);
  const cells = columns.map((column) => buildNormalizedCell(payload, column));
  const values = {};

  for (const cell of cells) {
    values[cell.columnKey] = cell.value;
  }

  return {
    index,
    recordId: String(record?.uuid || record?.id || `record-${index + 1}`),
    createdAt: record?.created_at || payload.createdAt || '',
    updatedAt: record?.updated_at || payload.updatedAt || '',
    values,
    cells,
    raw: {
      record,
      payload,
    },
  };
}

export function parseTableRecordPayload(data) {
  if (!data) {
    return {};
  }
  if (typeof data === 'object') {
    return data;
  }

  try {
    const parsed = JSON.parse(String(data));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function buildNormalizedCell(payload, column) {
  const rawEntry = payload?.[column.id] ?? {};
  const sourceValue = rawEntry?.value;
  const normalizedValue = normalizeTableCellValue(sourceValue, column);
  const text = renderTableCellText(normalizedValue, column);

  return {
    columnKey: column.key,
    columnId: column.id,
    columnName: column.name,
    type: column.type,
    text,
    html: renderTableCellHtml(normalizedValue, column),
    kind: column.type || 'text',
    value: normalizedValue,
    raw: {
      sourceValue,
      normalizedValue,
      entry: rawEntry,
      columnType: column.type,
      options: column.options,
      imageAssets: extractTableImageAssets(normalizedValue),
    },
  };
}

export function normalizeTableCellValue(sourceValue, column) {
  switch (column.type) {
    case 'select':
      return normalizeSelectValue(sourceValue, column);
    case 'date':
      return normalizeDateValue(sourceValue);
    case 'number':
      return normalizeNumberValue(sourceValue);
    case 'link':
      return normalizeLinkValue(sourceValue);
    case 'image':
      return normalizeImageValue(sourceValue);
    case 'textarea':
    case 'input':
    default:
      return normalizeTextValue(sourceValue);
  }
}

export function normalizeSelectValue(sourceValue, column) {
  if (Array.isArray(sourceValue)) {
    return sourceValue.map((item) => resolveSelectOptionValue(item, column)).filter(Boolean);
  }
  return resolveSelectOptionValue(sourceValue, column);
}

function resolveSelectOptionValue(sourceValue, column) {
  const raw = String(sourceValue ?? '').trim();
  if (!raw) {
    return '';
  }
  const matched = column.optionMap?.get(raw);
  return matched?.value || raw;
}

export function normalizeDateValue(sourceValue) {
  if (!sourceValue) {
    return '';
  }
  if (typeof sourceValue === 'string') {
    return normalizeTextValue(sourceValue);
  }

  const text = String(sourceValue?.text || '').trim();
  if (text) {
    return text.replace(/\//g, '-');
  }

  const time = String(sourceValue?.time || '').trim();
  if (time) {
    return time.slice(0, 10);
  }

  return '';
}

export function normalizeNumberValue(sourceValue) {
  const raw = String(sourceValue ?? '').trim();
  if (!raw) {
    return '';
  }
  const match = raw.match(/^-?\d+(?:\.\d+)?/);
  if (!match) {
    return raw;
  }
  const number = Number(match[0]);
  if (!Number.isFinite(number)) {
    return raw;
  }
  return Number.isInteger(number) ? number : number;
}

export function normalizeLinkValue(sourceValue) {
  if (!sourceValue) {
    return '';
  }
  if (typeof sourceValue === 'string') {
    return sourceValue.trim();
  }
  return String(sourceValue?.src || sourceValue?.url || sourceValue?.name || '').trim();
}

export function normalizeImageValue(sourceValue) {
  if (!Array.isArray(sourceValue)) {
    return [];
  }

  return sourceValue
    .map((item) => ({
      uid: String(item?.uid || '').trim(),
      name: String(item?.name || '').trim(),
      width: Number(item?.width || 0) || 0,
      height: Number(item?.height || 0) || 0,
      size: Number(item?.size || 0) || 0,
      sourceUrl: String(item?.src || item?.url || '').trim(),
      localPath: '',
      localRelativePath: '',
    }))
    .filter((item) => item.name || item.sourceUrl);
}

export function normalizeTextValue(sourceValue) {
  if (Array.isArray(sourceValue)) {
    return sourceValue.map((item) => normalizeTextValue(item)).filter(Boolean);
  }
  if (sourceValue == null) {
    return '';
  }
  if (typeof sourceValue === 'object') {
    if (typeof sourceValue.text === 'string') {
      return normalizeTextValue(sourceValue.text);
    }
    if (typeof sourceValue.name === 'string') {
      return normalizeTextValue(sourceValue.name);
    }
    return stripHtml(JSON.stringify(sourceValue));
  }
  return stripHtml(String(sourceValue)).trim();
}

export function renderTableCellText(value, column) {
  if (column.type === 'image') {
    const images = extractTableImageAssets(value);
    if (images.length === 0) {
      return '';
    }
    return images
      .map((image) => image.localRelativePath || image.sourceUrl || image.name)
      .filter(Boolean)
      .join('; ');
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTableScalar(item)).filter(Boolean).join('; ');
  }

  return renderTableScalar(value);
}

export function renderTableScalar(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    if (value.localRelativePath) {
      return value.localRelativePath;
    }
    if (value.localPath) {
      return value.localPath;
    }
    if (value.sourceUrl) {
      return value.sourceUrl;
    }
    if (value.name) {
      return value.name;
    }
    if (value.text) {
      return String(value.text);
    }
    return JSON.stringify(value);
  }
  return String(value).trim();
}

export function renderTableCellHtml(value, column) {
  if (column.type === 'link') {
    const href = renderTableScalar(value);
    if (!href) {
      return '';
    }
    return `<a href="${escapeHtmlAttribute(href)}">${escapeHtml(href)}</a>`;
  }

  if (column.type === 'image') {
    const images = extractTableImageAssets(value);
    if (images.length === 0) {
      return '';
    }
    return images
      .map((image) => {
        const src = image.localRelativePath || image.sourceUrl;
        if (!src) {
          return '';
        }
        const alt = image.name || path.basename(src);
        return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}" loading="lazy" />`;
      })
      .filter(Boolean)
      .join('');
  }

  const text = renderTableCellText(value, column);
  return text ? escapeHtml(text) : '';
}

export function extractTableImageAssets(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object');
  }
  if (value && typeof value === 'object') {
    return [value];
  }
  return [];
}

export function getTablePreviewRows(datatable, limit = 5) {
  return Array.isArray(datatable?.rows) ? datatable.rows.slice(0, Math.max(limit, 0)) : [];
}

export function summarizeTableColumns(datatable) {
  return (datatable?.columns || []).map((column) => ({
    name: column.name,
    type: column.type,
    optionCount: Array.isArray(column.options) ? column.options.length : 0,
  }));
}

export function toDatatableRecordTitle(row, columns) {
  const titleColumn = columns.find((column) => /^(title|name)$/i.test(column.name)) || columns[0];
  const value = row?.values?.[titleColumn?.key || ''] ?? '';
  const rendered = renderTableScalar(value);
  return rendered || `记录 ${Number(row?.index ?? 0) + 1}`;
}

export function sanitizeTableImageFileName(input, fallback = 'image') {
  const ext = path.extname(String(input || '')).trim();
  const stem = ext ? String(input).slice(0, -ext.length) : String(input || '');
  return `${sanitizeFileName(stem || fallback, fallback)}${ext || '.png'}`;
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
