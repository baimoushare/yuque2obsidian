import zlib from 'zlib';
import { escapeCsv, stripHtml } from './utils.js';

export function isSheetDocument(docDetail = {}) {
  if (docDetail?.type === 'Sheet') {
    return true;
  }

  const parsed = parseLakesheetBody(docDetail?.body ?? docDetail?.content ?? '');
  return Boolean(parsed?.format === 'lakesheet');
}

export function parseLakesheetBody(body) {
  if (!body) {
    return null;
  }

  if (typeof body === 'object') {
    return body?.format === 'lakesheet' ? body : null;
  }

  try {
    const parsed = JSON.parse(String(body));
    return parsed?.format === 'lakesheet' ? parsed : null;
  } catch {
    return null;
  }
}

export function decodeLakesheetWorkbook(parsedBody = {}) {
  const compressed = String(parsedBody?.sheet || '');
  if (!compressed) {
    throw new Error('The Yuque spreadsheet body does not contain a compressed workbook payload.');
  }

  const buffer = Buffer.from(compressed, 'latin1');
  const inflated = zlib.inflateSync(buffer).toString('utf8');
  const workbook = JSON.parse(inflated);
  if (!Array.isArray(workbook)) {
    throw new Error('The Yuque spreadsheet workbook payload is not an array of worksheets.');
  }
  return workbook;
}

export function normalizeStandaloneSheetDocument(docDetail = {}) {
  const body = parseLakesheetBody(docDetail?.body ?? docDetail?.content ?? '');
  if (!body) {
    throw new Error('The Yuque spreadsheet body is empty or invalid.');
  }

  const workbook = decodeLakesheetWorkbook(body);
  const sheets = workbook.map((sheet, index) => normalizeWorksheet(sheet, index));

  return {
    sourceType: 'standalone-sheet-document',
    sheetFormat: String(body.format || '').trim() || 'lakesheet',
    version: String(body.version || '').trim(),
    docId: docDetail?.id ?? 0,
    title: String(docDetail?.title || '').trim() || 'Untitled Spreadsheet',
    description: String(docDetail?.description || '').trim(),
    cover: String(docDetail?.cover || '').trim(),
    sheetCount: sheets.length,
    sheets,
    rawBody: body,
  };
}

export function buildWorksheetCsv(worksheet = {}) {
  const grid = Array.isArray(worksheet.grid) ? worksheet.grid : [];
  return `${grid.map((row) => row.map((cell) => escapeCsv(cell)).join(',')).join('\n')}\n`;
}

export function buildWorksheetBaseDataset(worksheet = {}) {
  const grid = Array.isArray(worksheet.grid) ? worksheet.grid : [];
  const width = grid.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  if (grid.length < 2 || width === 0) {
    return { columns: [], rows: [] };
  }

  const headerCells = Array.isArray(worksheet.rows?.[0]?.cells) ? worksheet.rows[0].cells : [];
  const coveredColumns = new Set();
  const columns = [];
  for (const cell of headerCells) {
    const start = Number(cell?.colIndex);
    if (!Number.isInteger(start) || start < 0 || start >= width || coveredColumns.has(start)) {
      continue;
    }
    const span = Math.max(1, Number(cell?.colSpan) || 1);
    const end = Math.min(width, start + span);
    for (let column = start; column < end; column += 1) coveredColumns.add(column);
    columns.push({
      key: `col_${String(columns.length + 1).padStart(2, '0')}`,
      displayName: String(cell?.text || '').trim() || `列${start + 1}`,
      start,
      end,
    });
  }

  for (let column = 0; column < width; column += 1) {
    if (coveredColumns.has(column)) continue;
    columns.push({
      key: `col_${String(columns.length + 1).padStart(2, '0')}`,
      displayName: `列${column + 1}`,
      start: column,
      end: column + 1,
    });
  }
  columns.sort((left, right) => left.start - right.start);
  columns.forEach((column, index) => {
    column.key = `col_${String(index + 1).padStart(2, '0')}`;
  });

  const rows = grid.slice(1).map((sourceRow) => {
    const values = {};
    for (const column of columns) {
      values[column.key] = sourceRow
        .slice(column.start, column.end)
        .map((value) => String(value ?? '').replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .join(' ');
    }
    return values;
  }).filter((row) => Object.values(row).some((value) => value !== ''));

  return { columns, rows };
}

export function buildWorksheetBaseFile({ datasetId, worksheet = {} }) {
  const { columns } = buildWorksheetBaseDataset(worksheet);
  const lines = [
    'filters:',
    '  and:',
    '    - file.ext == "md"',
    `    - dataset == ${JSON.stringify(String(datasetId || ''))}`,
    'properties:',
  ];

  for (const column of columns) {
    lines.push(`  ${JSON.stringify(column.key)}:`);
    lines.push(`    displayName: ${JSON.stringify(column.displayName)}`);
  }

  lines.push(
    'views:',
    '  - type: table',
    `    name: ${JSON.stringify(String(worksheet.name || '表格'))}`,
    '    order:',
    ...columns.map((column) => `      - ${JSON.stringify(column.key)}`),
  );
  return `${lines.join('\n')}\n`;
}

export function buildWorksheetHtmlFragment(worksheet = {}) {
  const rows = Array.isArray(worksheet.rows) ? worksheet.rows : [];
  const body = rows
    .map((row) => {
      const cells = (row.cells || [])
        .map((cell) => {
          const attributes = [];
          const styles = [];
          if (cell.rowSpan > 1) {
            attributes.push(` rowspan="${cell.rowSpan}"`);
          }
          if (cell.colSpan > 1) {
            attributes.push(` colspan="${cell.colSpan}"`);
          }
          if (cell.formula) {
            attributes.push(` data-formula="${escapeHtmlAttribute(cell.formula)}"`);
          }
          // 仅允许来自工作簿调色板的标准颜色值，避免将原始数据拼入 HTML 样式。
          if (cell.backgroundColor && /^#[\da-f]{6}$/iu.test(cell.backgroundColor)) {
            styles.push(`background-color:${cell.backgroundColor}`);
          }
          if (cell.color && /^(?:#[\da-f]{6}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))$/iu.test(cell.color)) {
            styles.push(`color:${cell.color}`);
          }
          // 保留源单元格中的显式换行，但不因列宽而自动折行；统一紧凑行高并居中。
          styles.push('white-space:pre', 'text-align:center', 'vertical-align:middle', 'padding:4px 8px', 'line-height:1.35');
          if (styles.length > 0) {
            attributes.push(` style="${styles.join(';')}"`);
          }
          const text = cell.text ? escapeHtml(cell.text).replace(/\n/g, '<br />') : '&nbsp;';
          return `<td${attributes.join('')}>${text}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');

  return `<table class="sheet-table" style="width:max-content;max-width:100%;border-collapse:collapse;table-layout:auto">\n<tbody>\n${body}\n</tbody>\n</table>`;
}

export function buildWorksheetHtmlDocument(title, worksheet = {}) {
  const heading = `${String(title || 'Spreadsheet').trim() || 'Spreadsheet'} / ${
    String(worksheet?.name || 'Sheet').trim() || 'Sheet'
  }`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(heading)}</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
      background: #f7f8fb;
      color: #1f2937;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 24px;
    }
    .meta {
      margin: 0 0 18px;
      color: #4b5563;
      font-size: 14px;
    }
    .sheet-table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
    }
    .sheet-table td {
      min-width: 88px;
      padding: 8px 10px;
      border: 1px solid #d8deea;
      vertical-align: top;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(worksheet?.name || 'Sheet')}</h1>
  <p class="meta">已按语雀电子表格工作表导出。</p>
  ${buildWorksheetHtmlFragment(worksheet)}
</body>
</html>
`;
}

export function buildWorkbookHtmlDocument(workbook = {}) {
  const sections = (workbook.sheets || [])
    .map(
      (sheet, index) => `<section class="sheet-card" id="sheet-${index + 1}">
  <header class="sheet-header">
    <h2>${escapeHtml(sheet.name || `Sheet ${index + 1}`)}</h2>
    <p>${escapeHtml(
      `有效区域 ${sheet.usedRowCount} 行 × ${sheet.usedColCount} 列，合并单元格 ${sheet.mergeCellCount} 处`,
    )}</p>
  </header>
  ${buildWorksheetHtmlFragment(sheet)}
</section>`,
    )
    .join('\n');

  const nav = (workbook.sheets || [])
    .map(
      (sheet, index) =>
        `<a href="#sheet-${index + 1}">${escapeHtml(sheet.name || `Sheet ${index + 1}`)}</a>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(workbook.title || 'Spreadsheet')}</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
      background: #f5f7fb;
      color: #111827;
    }
    header {
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .meta {
      margin: 0;
      color: #4b5563;
      font-size: 14px;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 18px 0 24px;
    }
    nav a {
      display: inline-block;
      padding: 8px 12px;
      border-radius: 999px;
      text-decoration: none;
      background: #ffffff;
      color: #2563eb;
      box-shadow: 0 8px 20px rgba(37, 99, 235, 0.08);
    }
    .sheet-card {
      margin-bottom: 24px;
      padding: 18px;
      border-radius: 18px;
      background: #ffffff;
      box-shadow: 0 14px 28px rgba(15, 23, 42, 0.08);
      overflow-x: auto;
    }
    .sheet-header h2 {
      margin: 0 0 6px;
      font-size: 20px;
    }
    .sheet-header p {
      margin: 0 0 14px;
      color: #4b5563;
      font-size: 14px;
    }
    .sheet-table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
    }
    .sheet-table td {
      min-width: 88px;
      padding: 8px 10px;
      border: 1px solid #d8deea;
      vertical-align: top;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(workbook.title || 'Spreadsheet')}</h1>
    <p class="meta">${escapeHtml(
      `已按语雀电子表格工作簿导出，共 ${workbook.sheetCount || 0} 个工作表。`,
    )}</p>
  </header>
  <nav>${nav}</nav>
  ${sections}
</body>
</html>
`;
}

function normalizeWorksheet(sheet = {}, index = 0) {
  const merges = normalizeMergeCells(sheet?.mergeCells);
  const bounds = detectUsedBounds(sheet, merges);
  const grid = buildGrid(sheet, bounds);
  const rows = buildWorksheetRows(sheet, bounds, merges, sheet?.vStore || {});

  return {
    index,
    name: String(sheet?.name || `Sheet ${index + 1}`).trim() || `Sheet ${index + 1}`,
    id: String(sheet?.id || '').trim(),
    totalRowCount: Number(sheet?.rowCount || 0) || 0,
    totalColCount: Number(sheet?.colCount || 0) || 0,
    usedRowCount: grid.length,
    usedColCount: grid.reduce((max, row) => Math.max(max, row.length), 0),
    mergeCellCount: merges.anchors.size,
    grid,
    rows,
    merges: Array.from(merges.anchors.values()),
  };
}

function normalizeMergeCells(rawMergeCells) {
  const anchors = new Map();
  const covered = new Set();

  for (const merge of Object.values(rawMergeCells || {})) {
    const row = Number(merge?.row);
    const col = Number(merge?.col);
    const rowCount = Math.max(1, Number(merge?.rowCount || 1));
    const colCount = Math.max(1, Number(merge?.colCount || 1));
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      continue;
    }

    const key = `${row}:${col}`;
    anchors.set(key, {
      row,
      col,
      rowCount,
      colCount,
    });

    for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
      for (let colOffset = 0; colOffset < colCount; colOffset += 1) {
        if (rowOffset === 0 && colOffset === 0) {
          continue;
        }
        covered.add(`${row + rowOffset}:${col + colOffset}`);
      }
    }
  }

  return { anchors, covered };
}

function detectUsedBounds(sheet = {}, merges) {
  let maxRow = -1;
  let maxCol = -1;

  for (const [rowKey, rowData] of Object.entries(sheet?.data || {})) {
    const rowIndex = Number(rowKey);
    if (!Number.isInteger(rowIndex)) {
      continue;
    }
    for (const [colKey, cell] of Object.entries(rowData || {})) {
      const colIndex = Number(colKey);
      if (!Number.isInteger(colIndex)) {
        continue;
      }
      const info = extractCellInfo(cell);
      if (!info.text && !info.formula) {
        continue;
      }
      maxRow = Math.max(maxRow, rowIndex);
      maxCol = Math.max(maxCol, colIndex);
    }
  }

  for (const merge of merges.anchors.values()) {
    maxRow = Math.max(maxRow, merge.row + merge.rowCount - 1);
    maxCol = Math.max(maxCol, merge.col + merge.colCount - 1);
  }

  return { maxRow, maxCol };
}

function buildGrid(sheet = {}, bounds = {}) {
  if (!Number.isInteger(bounds.maxRow) || !Number.isInteger(bounds.maxCol) || bounds.maxRow < 0 || bounds.maxCol < 0) {
    return [];
  }

  const grid = [];
  for (let rowIndex = 0; rowIndex <= bounds.maxRow; rowIndex += 1) {
    const row = [];
    for (let colIndex = 0; colIndex <= bounds.maxCol; colIndex += 1) {
      row.push(extractCellInfo(sheet?.data?.[rowIndex]?.[colIndex]).text);
    }
    grid.push(row);
  }
  return grid;
}

function buildWorksheetRows(sheet = {}, bounds = {}, merges, valueStore = {}) {
  if (!Number.isInteger(bounds.maxRow) || !Number.isInteger(bounds.maxCol) || bounds.maxRow < 0 || bounds.maxCol < 0) {
    return [];
  }

  const rows = [];
  for (let rowIndex = 0; rowIndex <= bounds.maxRow; rowIndex += 1) {
    const cells = [];
    for (let colIndex = 0; colIndex <= bounds.maxCol; colIndex += 1) {
      const key = `${rowIndex}:${colIndex}`;
      if (merges.covered.has(key)) {
        continue;
      }
      const merge = merges.anchors.get(key);
      const rawCell = sheet?.data?.[rowIndex]?.[colIndex];
      const info = extractCellInfo(rawCell);
      const styleIndex = Number(rawCell?.s);
      cells.push({
        rowIndex,
        colIndex,
        text: info.text,
        formula: info.formula,
        rowSpan: merge?.rowCount || 1,
        colSpan: merge?.colCount || 1,
        backgroundColor: Number.isInteger(styleIndex) ? String(valueStore.style_backColor?.[styleIndex] || '') : '',
        color: Number.isInteger(styleIndex) ? String(valueStore.style_color?.[styleIndex] || '') : '',
      });
    }
    rows.push({ index: rowIndex, cells });
  }
  return rows;
}

function extractCellInfo(cell) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
    return { text: '', formula: '' };
  }

  if (typeof cell.m === 'string' && cell.m.trim()) {
    return { text: normalizeCellText(cell.m), formula: '' };
  }

  const rawValue = cell.v;
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    const formula = String(rawValue.formula || '').trim();
    const formulaValue =
      Object.prototype.hasOwnProperty.call(rawValue, 'value') && rawValue.value !== undefined
        ? stringifyCellValue(rawValue.value)
        : '';
    const text =
      formulaValue ||
      stringifyCellValue(rawValue.text) ||
      stringifyCellValue(rawValue.display) ||
      stringifyCellValue(rawValue.content) ||
      stringifyCellValue(rawValue.label) ||
      JSON.stringify(rawValue);
    return {
      text: normalizeCellText(text),
      formula,
    };
  }

  return {
    text: normalizeCellText(stringifyCellValue(rawValue)),
    formula: '',
  };
}

function stringifyCellValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyCellValue(item)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return stringifyCellValue(value.value);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'text')) {
      return stringifyCellValue(value.text);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function normalizeCellText(value) {
  return stripHtml(String(value ?? ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/\n/g, '&#10;');
}
