import fs from 'fs';
import path from 'path';

const INVALID_FILENAME_RE = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function sanitizeFileName(input, fallback = 'untitled') {
  const normalized = String(input ?? '')
    .replace(INVALID_FILENAME_RE, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  const value = normalized || fallback;
  if (RESERVED_RE.test(value)) {
    return `_${value}`;
  }

  return value.slice(0, 160);
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function relativeMarkdownPath(fromFilePath, toFilePath) {
  return toPosixPath(path.relative(path.dirname(fromFilePath), toFilePath));
}

export function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

export function escapeCsv(value) {
  const source = value == null ? '' : String(value);
  return `"${source.replace(/"/g, '""')}"`;
}

export function errorToMessage(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

export function uniqueName(baseName, seenSet) {
  if (!seenSet.has(baseName)) {
    seenSet.add(baseName);
    return baseName;
  }

  const extension = path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  let counter = 2;
  let candidate = `${stem}-${counter}${extension}`;
  while (seenSet.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${extension}`;
  }

  seenSet.add(candidate);
  return candidate;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
