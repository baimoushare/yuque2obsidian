import { relativeMarkdownPath } from './utils.js';

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export async function processMarkdown(markdown, context) {
  let output = await replaceAsync(markdown, IMAGE_RE, async (match, alt, rawUrl) => {
    const rewritten = await rewriteAssetUrl(rawUrl, 'image', context);
    return `![${alt}](${rewritten ?? rawUrl})`;
  });

  output = await replaceAsync(output, LINK_RE, async (match, text, rawUrl) => {
    const internal = rewriteInternalLink(rawUrl, context.docLinkMap, context.targetMdPath);
    if (internal) {
      return `[${text}](${internal})`;
    }

    const rewritten = await rewriteAssetUrl(rawUrl, 'file', context);
    return `[${text}](${rewritten ?? rawUrl})`;
  });

  return output;
}

export function rewriteInternalLink(rawUrl, docLinkMap, targetMdPath) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'www.yuque.com' && parsed.hostname !== 'yuque.com') {
    return null;
  }

  const normalizedKey = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
  const mapped = docLinkMap.get(normalizedKey);
  if (!mapped) {
    return null;
  }

  let value = relativeMarkdownPath(targetMdPath, mapped);
  if (parsed.hash) {
    value += parsed.hash;
  }
  return value;
}

async function rewriteAssetUrl(rawUrl, kind, context) {
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
  });
  if (!localAssetPath) {
    return null;
  }

  return relativeMarkdownPath(context.targetMdPath, localAssetPath);
}

function isLikelyInternalDoc(parsed) {
  const segments = parsed.pathname.split('/').filter(Boolean);
  return (parsed.hostname === 'www.yuque.com' || parsed.hostname === 'yuque.com') && segments.length >= 3;
}

function isLikelyAttachment(parsed) {
  const pathname = parsed.pathname.toLowerCase();
  return (
    /\.[a-z0-9]{2,8}$/i.test(pathname) ||
    pathname.includes('/attachments/') ||
    pathname.includes('/docs/assets/') ||
    pathname.includes('/yuque/')
  );
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
