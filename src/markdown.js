import path from 'path';
import { relativeMarkdownPath, toPosixPath } from './utils.js';

const STRONG_RE = /\*\*(.+?)\*\*/g;
const WEB_DOCUMENT_EXTENSIONS = new Set(['html', 'htm', 'shtml', 'xhtml']);
const ATTACHMENT_EXTENSIONS = new Set([
  '7z',
  'apk',
  'blend',
  'csv',
  'doc',
  'docx',
  'exe',
  'fbx',
  'glb',
  'gz',
  'mov',
  'mp3',
  'mp4',
  'obj',
  'pdf',
  'ppt',
  'pptx',
  'psd',
  'rar',
  'tar',
  'tgz',
  'xls',
  'xlsx',
  'zip',
]);
const MEDIA_ATTACHMENT_EXTENSIONS = new Set(['mov', 'mp3', 'mp4']);

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const FENCED_BLOCK_RE = /^\s*([`~]{3,})/;
const YUQUE_CALLOUT_INLINE_RE = /^\s*:::\s*([a-z][\w-]*)\s+(.+?)\s*:::\s*$/i;
const YUQUE_CALLOUT_OPEN_RE = /^\s*:::\s*([a-z][\w-]*)(?:\s+(.*\S))?\s*$/i;
const YUQUE_CALLOUT_CLOSE_RE = /^\s*:::\s*$/;
const YUQUE_CALLOUT_CLOSE_SUFFIX_RE = /^(.*?)(?:\s+):::\s*$/;
const RAW_HTTP_LINK_RE = /\[([^\]]+)\]\((https?:\/\/.*?)\)/u;
const URL_WITH_FRAGMENT_RE = /^(https?:\/\/[^\s·●]+)([·●].*)$/u;
const DANGLING_BULLET_RE = /^[·●][^:\[\]#>\s]+(?:\([^)]+(?:\))?)?$/u;
const LABEL_LINE_RE = /^[^\s#>-].*:\s*(?:\[https?:\/\/|https?:\/\/)/u;
const PLAIN_URL_PAIR_RE = /([●·]\s*[^:\n]+):\s*(https?:\/\/[^\s●·]+)/gu;

const YUQUE_TO_OBSIDIAN_CALLOUT_MAP = new Map([
  ['abstract', 'abstract'],
  ['attention', 'warning'],
  ['caution', 'warning'],
  ['danger', 'danger'],
  ['error', 'danger'],
  ['faq', 'question'],
  ['help', 'question'],
  ['hint', 'tip'],
  ['important', 'tip'],
  ['info', 'info'],
  ['note', 'note'],
  ['question', 'question'],
  ['quote', 'quote'],
  ['success', 'success'],
  ['summary', 'abstract'],
  ['tip', 'tip'],
  ['tips', 'tip'],
  ['warning', 'warning'],
]);

export async function processMarkdown(markdown, context) {
  let output = normalizeYuqueMarkdownStructure(markdown);
  output = normalizeYuqueCalloutBlocks(output);

  let imageOccurrence = 0;
  output = await replaceAsync(output, IMAGE_RE, async (match, alt, rawUrl) => {
    const rewritten = await rewriteAssetUrl(rawUrl, 'image', context, {
      alt,
      occurrence: imageOccurrence,
    });
    imageOccurrence += 1;
    if (typeof rewritten === 'string') {
      return `![${alt}](${rewritten})`;
    }
    if (rewritten?.markdown) {
      return rewritten.markdown;
    }
    return `![${alt}](${rawUrl})`;
  });

  output = await replaceAsync(output, LINK_RE, async (match, text, rawUrl) => {
    const internal = rewriteInternalLink(rawUrl, context.docLinkMap, context.targetMdPath, {
      exportRoot: context.exportRoot,
      linkText: text,
    });
    if (internal) {
      return internal;
    }

    const rewritten = await rewriteFileLink(rawUrl, text, context);
    return rewritten ?? `[${text}](${rawUrl})`;
  });

  return output;
}

export function normalizeYuqueMarkdownStructure(markdown) {
  let output = String(markdown ?? '').replace(/\r\n?/g, '\n');
  output = expandBrokenLinkRuns(output);
  output = expandPlainUrlRuns(output);
  output = mergeDanglingBulletLabels(output);
  output = splitSectionAndFirstItem(output);
  output = splitCollapsedListItems(output);
  output = dropEmptyBulletFragments(output);
  output = normalizeSpacedStrongEmphasis(output);
  output = normalizeQuotedLiteralAsterisks(output);
  return output;
}

export function normalizeYuqueCalloutBlocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let fenceMarker = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(FENCED_BLOCK_RE);

    if (fenceMarker) {
      output.push(line);
      if (fenceMatch && startsFence(line, fenceMarker)) {
        fenceMarker = '';
      }
      continue;
    }

    if (fenceMatch) {
      fenceMarker = fenceMatch[1];
      output.push(line);
      continue;
    }

    const inlineMatch = line.match(YUQUE_CALLOUT_INLINE_RE);
    if (inlineMatch) {
      output.push(...renderYuqueCallout(inlineMatch[1], [inlineMatch[2]]));
      continue;
    }

    const openMatch = line.match(YUQUE_CALLOUT_OPEN_RE);
    if (!openMatch) {
      output.push(line);
      continue;
    }

    const collected = collectYuqueCalloutBody(lines, index + 1);
    if (!collected.closed) {
      output.push(line);
      continue;
    }

    const bodyLines = [];
    if (openMatch[2]) {
      bodyLines.push(openMatch[2]);
    }
    bodyLines.push(...collected.bodyLines);
    output.push(...renderYuqueCallout(openMatch[1], bodyLines));
    index = collected.endIndex;
  }

  return output.join('\n');
}

export function rewriteInternalLink(rawUrl, docLinkMap, targetMdPath, options = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'www.yuque.com' && parsed.hostname !== 'yuque.com') {
    return null;
  }

  const mapped = resolveInternalDocTarget(parsed, docLinkMap);
  if (!mapped) {
    return null;
  }

  const normalizedHash = String(parsed.hash || '').trim();
  if (normalizedHash && normalizedHash !== '#') {
    return null;
  }

  const exportRoot = resolveDocLinkExportRoot(docLinkMap, options.exportRoot);
  const wikiTarget = toObsidianWikiTarget(mapped, exportRoot);
  const alias = String(options.linkText || '').trim() || path.basename(mapped, path.extname(mapped));
  return buildObsidianWikiLink(wikiTarget, alias);
}

async function rewriteAssetUrl(rawUrl, kind, context, assetMeta = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return null;
  }

  if (kind === 'image' && !context.options.downloadImages) {
    return null;
  }

  if (kind === 'file' && !context.options.downloadAttachments) {
    return null;
  }

  if (kind === 'file' && isLikelyInternalDoc(parsed)) {
    return null;
  }

  if (kind === 'file' && !isLikelyAttachment(parsed)) {
    return null;
  }

  const localAssetPath = await context.downloadAsset(parsed.toString(), kind, {
    docName: context.docName,
    targetMdPath: context.targetMdPath,
    assetAlt: assetMeta.alt || '',
    imageOccurrence: Number.isFinite(Number(assetMeta.occurrence)) ? Number(assetMeta.occurrence) : -1,
  });
  if (!localAssetPath) {
    if (kind === 'image') {
      return {
        markdown: buildFailedImageExportNote(assetMeta.alt, rawUrl),
      };
    }
    return null;
  }

  return relativeMarkdownPath(context.targetMdPath, localAssetPath);
}

async function rewriteFileLink(rawUrl, text, context) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return null;
  }

  if (!context.options.downloadAttachments) {
    return null;
  }

  if (isLikelyInternalDoc(parsed) || !isLikelyAttachment(parsed)) {
    return null;
  }

  const localAssetPath = await context.downloadAsset(parsed.toString(), 'file', {
    docName: context.docName,
    targetMdPath: context.targetMdPath,
    fileNameHint: inferAttachmentFileName(parsed),
  });
  if (!localAssetPath) {
    return null;
  }

  const relativePath = relativeMarkdownPath(context.targetMdPath, localAssetPath);
  if (isMediaAttachment(parsed, localAssetPath)) {
    return `![${text}](${relativePath})`;
  }
  return `[${text}](${relativePath})`;
}

function resolveInternalDocTarget(parsed, docLinkMap) {
  const normalizedPath = normalizeDocLinkPathname(parsed.pathname);
  const [, userSlug = '', bookSlug = '', docSlug = ''] = normalizedPath.split('/');
  const bookDocKey = bookSlug && docSlug ? `${bookSlug}/${docSlug}` : '';
  const exactKey = `${parsed.origin}${normalizedPath}`;
  const candidateGroups = [];

  if (docLinkMap instanceof Map) {
    candidateGroups.push([docLinkMap.get(exactKey)]);
    candidateGroups.push([docLinkMap.get(normalizedPath)]);
    if (bookDocKey) {
      candidateGroups.push([docLinkMap.get(bookDocKey)]);
    }
    if (docSlug) {
      candidateGroups.push([docLinkMap.get(docSlug)]);
    }
  } else if (docLinkMap && typeof docLinkMap === 'object') {
    candidateGroups.push(resolveIndexCandidates(docLinkMap.exact, exactKey));
    candidateGroups.push(resolveIndexCandidates(docLinkMap.pathname, normalizedPath));
    if (bookDocKey) {
      candidateGroups.push(resolveIndexCandidates(docLinkMap.bookDoc, bookDocKey));
    }
    if (docSlug) {
      candidateGroups.push(resolveIndexCandidates(docLinkMap.docSlug, docSlug));
    }
    if (userSlug && bookSlug && docSlug) {
      candidateGroups.push(resolveIndexCandidates(docLinkMap.pathname, `/${userSlug}/${bookSlug}/${docSlug}`));
    }
  }

  for (const candidates of candidateGroups) {
    const resolved = pickUniqueCandidate(candidates);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function buildFailedImageExportNote(alt, rawUrl) {
  const normalizedAlt = String(alt ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalizedAlt) {
    return `> 注：图片“${normalizedAlt}”未能可靠导出到本地，请查看原图：[原图链接](${rawUrl})`;
  }
  return `> 注：这张图片未能可靠导出到本地，请查看原图：[原图链接](${rawUrl})`;
}

function resolveIndexCandidates(index, key) {
  if (!index || !key) {
    return [];
  }
  const value = index.get(key);
  if (Array.isArray(value)) {
    return value;
  }
  if (value instanceof Set) {
    return [...value];
  }
  return value ? [value] : [];
}

function pickUniqueCandidate(candidates) {
  const normalized = [...new Set((Array.isArray(candidates) ? candidates : []).filter(Boolean))];
  return normalized.length === 1 ? normalized[0] : null;
}

function normalizeDocLinkPathname(pathname) {
  return `/${String(pathname || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/')}`;
}

function resolveDocLinkExportRoot(docLinkMap, fallbackExportRoot = '') {
  const explicitRoot =
    typeof docLinkMap?.exportRoot === 'string' && docLinkMap.exportRoot.trim()
      ? docLinkMap.exportRoot.trim()
      : String(fallbackExportRoot || '').trim();
  return explicitRoot ? path.resolve(explicitRoot) : '';
}

function toObsidianWikiTarget(targetPath, exportRoot = '') {
  const absoluteTargetPath = path.resolve(String(targetPath || ''));
  const resolvedExportRoot = exportRoot ? path.resolve(exportRoot) : '';
  let wikiTarget = '';

  if (resolvedExportRoot) {
    const relativeToRoot = toPosixPath(path.relative(resolvedExportRoot, absoluteTargetPath));
    if (relativeToRoot && relativeToRoot !== '.' && !relativeToRoot.startsWith('../')) {
      wikiTarget = relativeToRoot;
    }
  }

  if (!wikiTarget) {
    wikiTarget = toPosixPath(path.basename(absoluteTargetPath));
  }

  return wikiTarget.replace(/\.md$/i, '');
}

function buildObsidianWikiLink(target, alias) {
  const safeTarget = escapeObsidianWikiValue(target);
  const safeAlias = escapeObsidianWikiValue(alias);
  return `[[${safeTarget}|${safeAlias}]]`;
}

function escapeObsidianWikiValue(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/]/g, '\\]');
}

function inferAttachmentFileName(parsed) {
  const pathname = String(parsed?.pathname || '').trim();
  const basename = pathname ? path.basename(pathname) : '';
  return basename || '';
}

function isMediaAttachment(parsed, localAssetPath = '') {
  const extension = inferAttachmentExtension(parsed, localAssetPath);
  return MEDIA_ATTACHMENT_EXTENSIONS.has(extension);
}

function inferAttachmentExtension(parsed, localAssetPath = '') {
  const localExtension = path.extname(String(localAssetPath || '')).replace(/^\./, '').toLowerCase();
  if (localExtension) {
    return localExtension;
  }

  const pathname = String(parsed?.pathname || '').toLowerCase();
  const match = pathname.match(/\.([a-z0-9]+)(?:$|[?#])/i);
  return match?.[1]?.toLowerCase?.() || '';
}

function expandBrokenLinkRuns(markdown) {
  const lines = markdown.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    while (true) {
      const repaired = splitFirstMalformedLinkLine(lines[index]);
      if (!repaired) {
        break;
      }

      lines[index] = repaired.current;
      lines.splice(index + 1, 0, repaired.next);
    }
  }

  return lines.join('\n');
}

function splitFirstMalformedLinkLine(line) {
  const match = RAW_HTTP_LINK_RE.exec(line);
  if (!match) {
    return null;
  }

  const [fullMatch, rawText, rawHref] = match;
  const textRepair = repairUrlFragment(rawText);
  const hrefRepair = repairUrlFragment(rawHref);
  const fragment = chooseCarryFragment(textRepair.fragment, hrefRepair.fragment);

  const malformed =
    textRepair.base !== rawText ||
    hrefRepair.base !== rawHref ||
    textRepair.trailingDelimiter ||
    hrefRepair.trailingDelimiter;

  if (!malformed || !fragment) {
    return null;
  }

  const before = line.slice(0, match.index);
  const after = line.slice(match.index + fullMatch.length).replace(/^\s+/u, '');
  const current = `${before}[${textRepair.base}](${hrefRepair.base})`;
  const next = `${fragment}${after}`.trimEnd();
  return next ? { current, next } : null;
}

function repairUrlFragment(rawValue) {
  const value = String(rawValue ?? '');
  const directMatch = value.match(URL_WITH_FRAGMENT_RE);
  if (directMatch) {
    return {
      base: stripTrailingSeparator(directMatch[1]),
      fragment: normalizeFragment(directMatch[2]),
      trailingDelimiter: false,
    };
  }

  const stripped = stripTrailingSeparator(value);
  return {
    base: stripped,
    fragment: value.slice(stripped.length),
    trailingDelimiter: stripped !== value,
  };
}

function mergeDanglingBulletLabels(markdown) {
  const lines = markdown.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].trim();
    if (!DANGLING_BULLET_RE.test(current)) {
      continue;
    }

    const nextIndex = findNextNonEmptyLine(lines, index + 1);
    if (nextIndex === -1) {
      continue;
    }

    if (!LABEL_LINE_RE.test(lines[nextIndex].trimStart())) {
      continue;
    }

    lines[nextIndex] = `${current} ${lines[nextIndex].trimStart()}`;
    lines[index] = '';
  }

  return lines.join('\n');
}

function expandPlainUrlRuns(markdown) {
  const expandedLines = [];
  for (const line of markdown.split('\n')) {
    expandedLines.push(...expandPlainUrlLine(line));
  }
  return expandedLines.join('\n');
}

function expandPlainUrlLine(line) {
  const matches = Array.from(line.matchAll(PLAIN_URL_PAIR_RE));
  if (matches.length === 0) {
    return [line];
  }

  const expanded = [];
  let cursor = 0;
  for (const match of matches) {
    const [fullMatch, rawLabel, rawUrl] = match;
    const before = line.slice(cursor, match.index).trim();
    if (before) {
      expanded.push(before);
    }

    const label = rawLabel.replace(/\s+/gu, ' ').trimEnd();
    const url = stripTrailingSeparator(rawUrl);
    expanded.push(`${label}:[${url}](${url})`);
    cursor = match.index + fullMatch.length;
  }

  const tail = line.slice(cursor).trim();
  if (tail) {
    expanded.push(tail);
  }

  return expanded.length > 0 ? expanded : [line];
}

function splitSectionAndFirstItem(markdown) {
  const lines = markdown.split('\n');
  const result = [];

  for (const line of lines) {
    const splitIndex = findSectionItemSplitIndex(line);
    if (splitIndex === -1) {
      result.push(line);
      continue;
    }

    result.push(line.slice(0, splitIndex).trimEnd());
    result.push(line.slice(splitIndex).trimStart());
  }

  return result.join('\n');
}

function splitCollapsedListItems(markdown) {
  return markdown.replace(/(\[[^\]]+\]\([^)]+\))(?=[●·][^\s])/gu, '$1\n');
}

function dropEmptyBulletFragments(markdown) {
  return markdown
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '·' && trimmed !== '●';
    })
    .join('\n');
}

function normalizeSpacedStrongEmphasis(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const output = [];
  let fenceMarker = '';

  for (const line of lines) {
    const fenceMatch = line.match(FENCED_BLOCK_RE);

    if (fenceMarker) {
      output.push(line);
      if (fenceMatch && startsFence(line, fenceMarker)) {
        fenceMarker = '';
      }
      continue;
    }

    if (fenceMatch) {
      fenceMarker = fenceMatch[1];
      output.push(line);
      continue;
    }

    output.push(
      line.replace(STRONG_RE, (match, content) => {
        const normalizedContent = trimStrongContent(content);
        if (!normalizedContent || normalizedContent === content) {
          return match;
        }
        return `**${normalizedContent}**`;
      }),
    );
  }

  return output.join('\n');
}

function normalizeQuotedLiteralAsterisks(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const output = [];
  let fenceMarker = '';

  for (const line of lines) {
    const fenceMatch = line.match(FENCED_BLOCK_RE);

    if (fenceMarker) {
      output.push(line);
      if (fenceMatch && startsFence(line, fenceMarker)) {
        fenceMarker = '';
      }
      continue;
    }

    if (fenceMatch) {
      fenceMarker = fenceMatch[1];
      output.push(line);
      continue;
    }

    output.push(
      line.replace(/([“"'‘’「『])(\s*)(\*+)(\s*)([”"'‘’」』])/gu, (match, openQuote, leftSpace, stars, rightSpace, closeQuote) => {
        const escapedStars = stars
          .split('')
          .map((star) => `\\${star}`)
          .join('');
        return `${openQuote}${leftSpace}${escapedStars}${rightSpace}${closeQuote}`;
      }),
    );
  }

  return output.join('\n');
}

function trimStrongContent(content) {
  let output = String(content ?? '').trim();
  let previous = '';

  while (output && output !== previous) {
    previous = output;
    output = output.replace(/^(<[^>]+>)\s+/u, '$1');
    output = output.replace(/\s+(<\/[^>]+>)$/u, '$1');
  }

  return output;
}

function chooseCarryFragment(...fragments) {
  return fragments
    .filter(Boolean)
    .sort((left, right) => fragmentScore(right) - fragmentScore(left))[0];
}

function fragmentScore(fragment) {
  return fragment.replace(/[·●()\s]+/gu, '').length;
}

function normalizeFragment(fragment) {
  return String(fragment ?? '').replace(/\s+/gu, ' ').trimEnd();
}

function stripTrailingSeparator(value) {
  return String(value ?? '').replace(/[·●]+$/gu, '');
}

function findNextNonEmptyLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      return index;
    }
  }
  return -1;
}

function findSectionItemSplitIndex(line) {
  if (!line.startsWith('●')) {
    return -1;
  }

  for (let index = 1; index < line.length; index += 1) {
    const char = line[index];
    if (char !== '●' && char !== '·') {
      continue;
    }

    const hasWhitespaceBefore = /\s/u.test(line[index - 1] ?? '');
    const hasWhitespaceAfter = /\s/u.test(line[index + 1] ?? '');
    if (!hasWhitespaceBefore && !hasWhitespaceAfter) {
      continue;
    }

    if (/^[·●]\s*[^:\n]+:\[https?:\/\/.*$/u.test(line.slice(index))) {
      return index;
    }
  }

  return -1;
}

function isLikelyInternalDoc(parsed) {
  const segments = parsed.pathname.split('/').filter(Boolean);
  return (parsed.hostname === 'www.yuque.com' || parsed.hostname === 'yuque.com') && segments.length >= 3;
}

export function isLikelyAttachment(parsed) {
  const pathname = parsed.pathname.toLowerCase();
  if (
    pathname.includes('/attachments/') ||
    pathname.includes('/docs/assets/') ||
    pathname.includes('/yuque/')
  ) {
    return true;
  }

  const extensionMatch = pathname.match(/\.([a-z0-9]{2,8})$/i);
  if (!extensionMatch) {
    return false;
  }

  const extension = String(extensionMatch[1] || '').toLowerCase();
  if (!extension || WEB_DOCUMENT_EXTENSIONS.has(extension)) {
    return false;
  }

  return ATTACHMENT_EXTENSIONS.has(extension);
}

function collectYuqueCalloutBody(lines, startIndex) {
  const bodyLines = [];
  let fenceMarker = '';

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(FENCED_BLOCK_RE);

    if (fenceMarker) {
      bodyLines.push(line);
      if (fenceMatch && startsFence(line, fenceMarker)) {
        fenceMarker = '';
      }
      continue;
    }

    if (fenceMatch) {
      fenceMarker = fenceMatch[1];
      bodyLines.push(line);
      continue;
    }

    if (YUQUE_CALLOUT_CLOSE_RE.test(line)) {
      return {
        bodyLines: trimCalloutBodyLines(bodyLines),
        closed: true,
        endIndex: index,
      };
    }

    const closeSuffixMatch = line.match(YUQUE_CALLOUT_CLOSE_SUFFIX_RE);
    if (closeSuffixMatch) {
      const trailingBody = closeSuffixMatch[1].trimEnd();
      if (trailingBody) {
        bodyLines.push(trailingBody);
      }
      return {
        bodyLines: trimCalloutBodyLines(bodyLines),
        closed: true,
        endIndex: index,
      };
    }

    bodyLines.push(line);
  }

  return {
    bodyLines: [],
    closed: false,
    endIndex: startIndex - 1,
  };
}

function renderYuqueCallout(rawType, bodyLines) {
  const calloutType = resolveObsidianCalloutType(rawType);
  const normalizedBodyLines = trimCalloutBodyLines(bodyLines);

  if (!calloutType) {
    return normalizedBodyLines.length > 0 ? normalizedBodyLines.map((line) => (line ? `> ${line}` : '>')) : ['>'];
  }

  const output = [`> [!${calloutType}]`];
  for (const line of normalizedBodyLines) {
    output.push(line ? `> ${line}` : '>');
  }
  return output;
}

function resolveObsidianCalloutType(rawType) {
  return YUQUE_TO_OBSIDIAN_CALLOUT_MAP.get(String(rawType || '').trim().toLowerCase()) || '';
}

function trimCalloutBodyLines(lines) {
  const output = Array.isArray(lines) ? [...lines] : [];
  while (output.length > 0 && !String(output[0] ?? '').trim()) {
    output.shift();
  }
  while (output.length > 0 && !String(output[output.length - 1] ?? '').trim()) {
    output.pop();
  }
  return output;
}

function startsFence(line, fenceMarker) {
  const trimmed = String(line || '').trimStart();
  const fenceChar = String(fenceMarker || '').charAt(0);
  if (!fenceChar) {
    return false;
  }
  const matched = trimmed.match(/^([`~]{3,})/);
  return Boolean(matched) && matched[1][0] === fenceChar && matched[1].length >= fenceMarker.length;
}

async function replaceAsync(text, regex, replacer) {
  const matches = Array.from(text.matchAll(regex));
  if (matches.length === 0) {
    return text;
  }

  let output = '';
  let lastIndex = 0;
  for (const match of matches) {
    output += text.slice(lastIndex, match.index);
    output += await replacer(...match);
    lastIndex = match.index + match[0].length;
  }
  output += text.slice(lastIndex);
  return output;
}
