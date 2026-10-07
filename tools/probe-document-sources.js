#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from '../src/yuque.js';
import {
  fetchAllMarks,
  fetchMarksPage,
  findMissingTargetActionIds,
  summarizeMarksPayload,
} from '../src/document-sources.js';

function parseCookiePath(args) {
  const index = args.indexOf('--cookie-path');
  const cookiePath = index >= 0 ? args[index + 1] : '';
  if (!cookiePath || cookiePath.startsWith('--')) {
    throw new Error('请通过 --cookie-path 指定导出软件当前使用的凭据文件。');
  }
  return path.resolve(cookiePath);
}

function assertNoLegacyCookieMigration(cookiePath) {
  if (process.platform !== 'win32') return;
  const envelope = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  if (envelope?.format !== 'yuque-exporter-dpapi-v1') {
    throw new Error('检测到非 DPAPI 凭据格式；读取会自动迁移并写回文件，探针已停止以避免未确认的本地改写。');
  }
}

async function main() {
  const cookiePath = parseCookiePath(process.argv.slice(2));
  const allPages = process.argv.includes('--all-pages');
  if (!fs.existsSync(cookiePath)) {
    throw new Error('指定的凭据文件不存在；没有发出网络请求。');
  }
  assertNoLegacyCookieMigration(cookiePath);

  const client = createHttpClient(cookiePath);
  let pageCount = 0;
  let summary;
  let missingTargetActionCount = null;
  if (allPages) {
    // 按 offset 读取收藏列表，保持只读和不展开知识库的边界。
    const originalGetJson = client.getJson.bind(client);
    client.getJson = async (...args) => {
      pageCount += 1;
      return originalGetJson(...args);
    };
    const result = await fetchAllMarks(client);
    summary = summarizeMarksPayload({ data: result });
    missingTargetActionCount = findMissingTargetActionIds({ data: result }).length;
  } else {
    // 默认只请求已在浏览器中观察到的收藏第一页。
    const originalGetJson = client.getJson.bind(client);
    let payload = null;
    client.getJson = async (...args) => {
      payload = await originalGetJson(...args);
      return payload;
    };
    summary = await fetchMarksPage(client);
    missingTargetActionCount = findMissingTargetActionIds(payload).length;
    pageCount = 1;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'success',
    source: 'favorites',
    pagination: allPages ? 'complete' : 'not-tested',
    pageCount,
    missingTargetActionCount,
    summary,
  }, null, 2)}\n`);
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entryPath) {
  main().catch((error) => {
    // Axios 错误可能含完整 URL；仅报告错误类别和 HTTP 状态，不回显请求配置或响应正文。
    const status = error?.response?.status;
    const category = status === 401 || status === 403
      ? 'authentication-or-permission'
      : status === 429
        ? 'rate-limited'
        : status
          ? 'http-error'
          : 'request-or-input-error';
    process.stderr.write(`${JSON.stringify({
      status: 'error',
      category,
      statusCode: status || null,
      message: status === 401 || status === 403
        ? '凭据无效或当前账号无权访问；探针未重试。'
        : status === 429
          ? '接口返回限流；探针已停止。'
          : status
            ? '收藏接口请求失败；未记录响应正文。'
            : '输入或请求失败；为保护隐私未输出详细异常。',
    })}\n`);
    process.exitCode = 1;
  });
}
