#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHttpClient, fetchCurrentUser, fetchDocDetail, fetchMarkdown } from '../src/yuque.js';
import { processMarkdown } from '../src/markdown.js';

const ALLOWED_ORIGIN = 'https://www.yuque.com';
const ALLOWED_IMAGE_HOSTS = new Set(['cdn.nlark.com']);
const MAX_DOCUMENTS = 1;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function parseArgs(args) {
  const cookieIndex = args.indexOf('--cookie-path');
  const urlIndex = args.indexOf('--url');
  const outputIndex = args.indexOf('--output-dir');
  const titleIndex = args.indexOf('--expected-title');
  const snippetIndex = args.indexOf('--expected-snippet');
  const bookIdIndex = args.indexOf('--book-id');
  const localizeImages = args.includes('--localize-images');
  const cookiePath = cookieIndex >= 0 ? args[cookieIndex + 1] : '';
  const documentUrl = urlIndex >= 0 ? args[urlIndex + 1] : '';
  const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : '';
  const expectedTitle = titleIndex >= 0 ? args[titleIndex + 1] : '';
  const expectedSnippet = snippetIndex >= 0 ? args[snippetIndex + 1] : '';
  const bookId = bookIdIndex >= 0 ? args[bookIdIndex + 1] : '';

  if (!cookiePath || cookiePath.startsWith('--')) {
    throw new Error('请通过 --cookie-path 指定导出软件当前使用的凭据文件。');
  }
  if (!documentUrl || documentUrl.startsWith('--')) {
    throw new Error('请通过 --url 指定一篇已确认可访问的语雀文档地址。');
  }

  return {
    cookiePath: path.resolve(cookiePath),
    documentUrl,
    expectedTitle: expectedTitle && !expectedTitle.startsWith('--') ? expectedTitle : '',
    // 语雀 Markdown 导出不一定包含文档标题，额外接受一个用户选定的片段作为内容指纹。
    expectedSnippet: expectedSnippet && !expectedSnippet.startsWith('--') ? expectedSnippet : '',
    // 收藏项自带 target.book_id 时可直接传给详情接口；缺省时保留身份解析缺口，不回扫知识库。
    bookId: bookId && !bookId.startsWith('--') ? bookId : '',
    localizeImages,
    outputDir: outputDir
      ? path.resolve(outputDir)
      : path.resolve('runtime-validation', new Date().toISOString().slice(0, 10), 'single-document'),
  };
}

function parseDocumentUrl(value) {
  const url = new URL(value);
  if (url.origin !== ALLOWED_ORIGIN) {
    throw new Error('文档地址必须位于 www.yuque.com。');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 3) {
    // 首轮只接受本次已确认的 /用户空间/知识库/文档 路径，不接受短链接或外部路径。
    throw new Error('首轮探针只接受 /用户空间/知识库/文档 的语雀地址。');
  }

  const [userSlug, bookSlug, documentSlug] = segments;
  return {
    relativeUrl: `${userSlug}/${bookSlug}/${documentSlug}`,
    documentSlug,
  };
}

export function imageExtension(contentType) {
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return {
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
  }[mime] || '';
}

export async function downloadProbeImage(rawUrl, targetPath, fetchImpl = fetch) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.port || !ALLOWED_IMAGE_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error('image-host-not-allowed');
  }

  // 图片 CDN 请求不带语雀 Cookie；禁用重定向以免把资源请求引向其他主机。
  const response = await fetchImpl(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`image-http-${response.status}`);

  const extension = imageExtension(response.headers.get('content-type'));
  if (!extension) throw new Error('response-is-not-an-image');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    throw new Error('image-size-out-of-range');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('image-size-out-of-range');
  }

  let safeTargetPath = `${targetPath}${extension}`;
  for (let suffix = 2; fs.existsSync(safeTargetPath); suffix += 1) {
    safeTargetPath = `${targetPath}-${suffix}${extension}`;
  }
  fs.mkdirSync(path.dirname(safeTargetPath), { recursive: true });
  fs.writeFileSync(safeTargetPath, bytes, { flag: 'wx' });
  return safeTargetPath;
}

function summarizeError(error) {
  const status = error?.response?.status;
  return {
    category: status === 401 || status === 403
      ? 'authentication-or-permission'
      : status === 429
        ? 'rate-limited'
        : status
          ? 'http-error'
          : 'request-or-content-error',
    statusCode: status || null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const parsed = parseDocumentUrl(options.documentUrl);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const calls = [];
  const client = createHttpClient(options.cookiePath);
  const originalGetJson = client.getJson.bind(client);
  const originalGet = client.get.bind(client);

  // 记录请求类别而不是完整 URL，避免把私有查询参数或凭据带入报告。
  client.getJson = async (url, ...args) => {
    const parsedUrl = new URL(url, ALLOWED_ORIGIN);
    calls.push({ method: 'GET', path: parsedUrl.pathname });
    if (/\/api\/(?:mine\/book_stacks|catalog_nodes|docs\/)/.test(parsedUrl.pathname)
      && !parsedUrl.pathname.endsWith(`/api/docs/${parsed.documentSlug}`)) {
      throw new Error('探针拒绝名单外的发现或文档请求。');
    }
    return originalGetJson(url, ...args);
  };
  client.get = async (url, ...args) => {
    const parsedUrl = new URL(url, ALLOWED_ORIGIN);
    calls.push({ method: 'GET', path: parsedUrl.pathname });
    if (parsedUrl.pathname !== `/${parsed.relativeUrl}/markdown`) {
      throw new Error('探针拒绝名单外的正文请求。');
    }
    return originalGet(url, ...args);
  };

  const result = {
    status: 'success',
    source: 'explicit-document',
    documentCount: MAX_DOCUMENTS,
    requestedPath: parsed.relativeUrl,
    calls,
  };

  try {
    const user = await fetchCurrentUser(client);
    result.authenticated = Boolean(user?.id);

    try {
      const detail = await fetchDocDetail(client, parsed.documentSlug, options.bookId);
      result.detail = {
        available: Boolean(detail?.id),
        hasBookId: detail?.book_id != null,
        bookIdProvided: Boolean(options.bookId),
        fieldCount: Object.keys(detail || {}).length,
      };
    } catch (error) {
      result.detail = {
        available: false,
        ...summarizeError(error),
      };
    }

    const markdown = await fetchMarkdown(client, parsed.relativeUrl);
    const outputPath = path.join(options.outputDir, 'sample-01.md');
    fs.writeFileSync(outputPath, markdown, 'utf8');
    const titleFound = options.expectedTitle ? markdown.includes(options.expectedTitle) : null;
    const snippetFound = options.expectedSnippet ? markdown.includes(options.expectedSnippet) : null;
    const expectationChecked = Boolean(options.expectedTitle || options.expectedSnippet);
    const contentVerified = !expectationChecked || titleFound === true || snippetFound === true;
    result.markdown = {
      available: true,
      byteCount: Buffer.byteLength(markdown, 'utf8'),
      matchesExpectedTitle: titleFound,
      matchesExpectedSnippet: snippetFound,
      hasMarkdownHeading: /^#\s+\S+/m.test(markdown),
      imageReferenceCount: (markdown.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length,
      attachmentReferenceCount: (markdown.match(/\[[^\]]+\]\([^)]*\)/g) || []).length,
      outputFile: outputPath,
    };
    if (options.localizeImages) {
      const localizedPath = path.join(options.outputDir, 'sample-01-localized.md');
      const stats = { downloaded: 0, failed: 0 };
      const localizedMarkdown = await processMarkdown(markdown, {
        docName: 'sample-01',
        targetMdPath: localizedPath,
        exportRoot: options.outputDir,
        docLinkMap: new Map(),
        options: { downloadImages: true, downloadAttachments: false },
        async downloadAsset(url, kind, assetOptions = {}) {
          if (kind !== 'image') return null;
          const imageIndex = Math.max(0, Number(assetOptions.imageOccurrence) || 0) + 1;
          const targetPath = path.join(options.outputDir, '_assets', 'images', `image-${String(imageIndex).padStart(3, '0')}`);
          try {
            const downloadedPath = await downloadProbeImage(url, targetPath);
            stats.downloaded += 1;
            return downloadedPath;
          } catch {
            stats.failed += 1;
            return null;
          }
        },
      });
      fs.writeFileSync(localizedPath, localizedMarkdown, 'utf8');
      result.localizedImages = {
        downloaded: stats.downloaded,
        failed: stats.failed,
        localizedMarkdown: path.basename(localizedPath),
        remainingRemoteReferences: (localizedMarkdown.match(/!\[[^\]]*\]\(https?:\/\//g) || []).length,
        relativeImageReferences: (localizedMarkdown.match(/!\[[^\]]*\]\((?!https?:\/\/)[^)]+\)/g) || []).length,
      };
    }
    if (!contentVerified) {
      result.status = 'error';
      result.contentStatus = 'unexpected-document-content';
    }
  } catch (error) {
    result.status = 'error';
    Object.assign(result, summarizeError(error));
  }

  result.calls = calls;
  const reportPath = path.join(options.outputDir, 'summary.json');
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify({ ...result, reportFile: reportPath })}\n`);
  if (result.status !== 'success') process.exitCode = 1;
}

const entryPath = new URL(import.meta.url).pathname;
const normalizedEntryPath = path.resolve(decodeURIComponent(entryPath.replace(/^\/([A-Za-z]:)/, '$1')));
if (process.argv[1] && path.resolve(process.argv[1]) === normalizedEntryPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'error', ...summarizeError(error) })}\n`);
    process.exitCode = 1;
  });
}
