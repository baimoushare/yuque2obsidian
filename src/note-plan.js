import path from 'node:path';
import { normalizeAssetDirectoryName, sanitizeFileName } from './utils.js';

const NOTE_DIRECTORY = '小记';
const UNCATEGORIZED_TAG = '未分类';
const UNKNOWN_DATE_DIRECTORY = '日期未知';
const TIME_ZONE = 'Asia/Shanghai';
const MAX_TAG_SEGMENT_LENGTH = 20;

/**
 * 基于已扫描的小记快照创建纯输出计划。计划阶段不写文件，也不读取状态文件，
 * 因此调用者必须显式传入当前账号和已验证的旧状态记录。
 */
export function buildNotePlan(notes, options = {}) {
  const rawOutputDir = String(options.outputDir ?? '').trim();
  if (!rawOutputDir) throw new Error('小记计划必须指定 outputDir。');
  const outputDir = path.resolve(rawOutputDir);
  const accountScope = String(options.accountScope ?? '').trim();
  if (!accountScope) throw new Error('小记计划必须指定当前账号范围。');
  const selectedKeys = selectedKeySet(options.selectedNoteKeys);
  if (selectedKeys.size === 0) throw new Error('没有选中具体小记；空选择不会导出全部。');

  const allNotes = Array.isArray(notes) ? notes : [];
  const byKey = new Map();
  for (const note of allNotes) {
    const key = String(note?.documentKey ?? '').trim();
    if (!key) continue;
    if (byKey.has(key)) throw new Error(`扫描列表中存在重复小记标识：${key}`);
    byKey.set(key, note);
  }

  const selected = [];
  for (const key of selectedKeys) {
    const note = byKey.get(key);
    if (!note) throw new Error(`选择中包含当前来源列表不存在的小记标识：${key}`);
    if (String(note.accountScope ?? '').trim() !== accountScope) {
      throw new Error(`选择的小记不属于当前账号：${key}`);
    }
    validateNoteIdentity(note, accountScope);
    selected.push(note);
  }

  const assetDirectoryName = normalizeAssetDirectoryName(options.assetDirectoryName);
  const usedPaths = new Map();
  const shortIds = new Map();
  const planned = selected.map((note) => {
    const shortId = shortNoteId(note.noteId);
    const previousKey = shortIds.get(shortId);
    if (previousKey && previousKey !== note.documentKey) {
      throw new Error(`短 ID 冲突：${previousKey} 与 ${note.documentKey} 不能共享 ${shortId}。`);
    }
    shortIds.set(shortId, note.documentKey);

    const targetMdPath = resolveTargetPath(note, outputDir, accountScope, shortId);
    const tags = noteTagNames(note.tags);
    const primaryTag = tags[0] || UNCATEGORIZED_TAG;
    const indexFiles = tags.slice(1).map((tag) => ({
      tag,
      path: buildIndexPath(targetMdPath, tag, note.createdAt, outputDir),
    }));
    for (const entry of [{ path: targetMdPath, tag: primaryTag }, ...indexFiles]) {
      const currentKey = pathKey(entry.path);
      const existing = usedPaths.get(currentKey);
      if (existing && existing !== note.documentKey) {
        throw new Error(`小记输出路径冲突：${existing} 与 ${note.documentKey}。`);
      }
      usedPaths.set(currentKey, note.documentKey);
    }

    // 资源不跟随正文标签/月份目录，避免同一小记改标签或不同账号时发生串目录。
    const assetDir = path.join(outputDir, NOTE_DIRECTORY, assetDirectoryName, safeIdSegment(accountScope), safeIdSegment(note.noteId));
    assertInsideNoteRoot(assetDir, outputDir, note.documentKey, '资源路径');
    return {
      ...note,
      documentKey: String(note.documentKey).trim(),
      absoluteDocUrl: String(note.canonicalUrl ?? '').trim(),
      sourceVersion: String(note.updatedAt ?? '').trim(),
      primaryTag,
      indexFiles,
      targetMdPath,
      assetDir,
    };
  });

  return { outputDir, notes: planned };
}

function selectedKeySet(selectedNoteKeys) {
  if (!Array.isArray(selectedNoteKeys)) return new Set();
  return new Set(selectedNoteKeys.map((key) => String(key ?? '').trim()).filter(Boolean));
}

function validateNoteIdentity(note, accountScope) {
  const noteId = String(note.noteId ?? '').trim();
  if (!isPositiveIntegerString(accountScope) || !isPositiveIntegerString(noteId)) {
    throw new Error(`小记身份必须使用正整数字符串账号和 ID：${String(note.documentKey ?? '')}`);
  }
  const expected = `yuque-note:${accountScope}:${noteId}`;
  if (String(note.documentKey ?? '').trim() !== expected) {
    throw new Error(`小记身份不符合冻结契约：${String(note.documentKey ?? '')}`);
  }
}

function resolveTargetPath(note, outputDir, accountScope, shortId) {
  // 目标路径只由当前标签、创建时间和稳定身份决定；旧状态留给导出器做安全移动，
  // 不能把已改标签的小记永久固定在旧目录。
  const dateParts = archiveDate(note.createdAt);
  const safeSummary = truncateCodePoints(sanitizeFileName(note.summary || '未命名小记', '未命名小记'), 50);
  const tagSegment = safeTagSegment(noteTagNames(note.tags)[0] || UNCATEGORIZED_TAG);
  const baseName = dateParts
    ? `${dateParts.year}-${dateParts.month}-${dateParts.day}_${dateParts.hour}${dateParts.minute}${dateParts.second}_${safeSummary}__${shortId}__a${accountScope}.md`
    : `${safeSummary}__${shortId}__a${accountScope}.md`;
  const dateDirectory = dateParts
    ? [dateParts.year, dateParts.month]
    : [UNKNOWN_DATE_DIRECTORY];
  return path.join(outputDir, NOTE_DIRECTORY, tagSegment, ...dateDirectory, baseName);
}

function buildIndexPath(targetMdPath, tag, createdAt, outputDir) {
  // 索引按标签归档，并与正文使用同一套日期目录规则；正文可能来自可信旧路径，
  // 所以这里只复用正文文件名，不假设正文目录仍等于标签目录。
  const baseName = path.basename(targetMdPath, '.md');
  const dateParts = archiveDate(createdAt);
  const dateDirectory = dateParts ? [dateParts.year, dateParts.month] : [UNKNOWN_DATE_DIRECTORY];
  return path.join(
    outputDir,
    NOTE_DIRECTORY,
    safeTagSegment(tag),
    ...dateDirectory,
    `${baseName}__索引.md`,
  );
}

function noteTagNames(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const names = [];
  for (const tag of tags) {
    const name = (typeof tag === 'string' ? tag : tag?.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function safeTagSegment(tag) {
  const value = truncateCodePoints(sanitizeFileName(tag || UNCATEGORIZED_TAG, UNCATEGORIZED_TAG), MAX_TAG_SEGMENT_LENGTH).trim();
  if (!value || value === '.' || value === '..') return UNCATEGORIZED_TAG;
  return value;
}

function assertInsideNoteRoot(candidate, outputDir, documentKey, label) {
  const noteRoot = path.resolve(outputDir, NOTE_DIRECTORY);
  const relative = path.relative(noteRoot, path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}超出允许的小记目录：${documentKey}`);
  }
}

function archiveDate(value) {
  const raw = String(value ?? '').trim();
  // 无偏移的服务端时间无法可靠推断其时区，不能让本机时区参与归档。
  if (!raw || !/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(raw)) return null;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values;
}

function isPositiveIntegerString(value) {
  return /^[1-9]\d*$/u.test(String(value ?? '').trim());
}

function truncateCodePoints(value, limit) {
  return Array.from(String(value ?? '')).slice(0, limit).join('').trimEnd() || '未命名小记';
}

function shortNoteId(noteId) {
  const value = safeIdSegment(noteId);
  return value.slice(0, 10);
}

function safeIdSegment(value) {
  return sanitizeFileName(String(value ?? ''), 'unknown-note-id').replace(/\.+$/u, '') || 'unknown-note-id';
}

function pathKey(filePath) {
  // Windows 默认不区分大小写，使用小写键可在开发机提前发现同路径覆盖。
  return path.resolve(filePath).toLocaleLowerCase('en-US');
}
