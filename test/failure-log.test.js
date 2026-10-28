import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureCsvLogger, localizeFailureRecord } from '../src/failure-log.js';

test('FailureCsvLogger writes BOM csv and appends escaped rows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-03-21T12:00:00.000Z',
    book_name: 'AI"',
    doc_name: 'Failed Doc',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'document-export',
    error_type: 'Error',
    error_message: 'something "bad" happened',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /^\ufeff/);
  assert.match(csv, /"知识库名称"/);
  assert.match(csv, /"AI"""/);
  assert.match(csv, /"文档导出"/);
  assert.match(csv, /"导出错误"/);
  assert.match(csv, /"something ""bad"" happened"/);
});

test('FailureCsvLogger localizes common network errors to Chinese', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-03-21T12:00:00.000Z',
    book_name: 'AI',
    doc_name: 'Model List',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'capture-artifacts',
    error_type: 'Error',
    error_message: 'getaddrinfo ENOTFOUND www.yuque.com',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /"提取表格与复杂块"/);
  assert.match(csv, /"网络解析错误"/);
  assert.match(csv, /无法解析语雀域名/);
});

test('FailureCsvLogger localizes empty documents to Chinese', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-03-21T12:00:00.000Z',
    book_name: 'AI',
    doc_name: 'Blank Note',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'empty-document',
    error_type: 'EmptyDocument',
    error_message: 'Document "Blank Note" only contains the title and has no body content.',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /"空文档判定"/);
  assert.match(csv, /"空文档"/);
  assert.match(csv, /该文档只有标题/);
});

test('FailureCsvLogger localizes HTML page responses without blaming cookies only', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-03-21T12:00:00.000Z',
    book_name: 'AI',
    doc_name: 'Architecture',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'fetch-markdown',
    error_type: 'Error',
    error_message: 'Received an HTML document instead of markdown. Yuque may have returned a sign-in, permission, or error page.',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /"拉取 Markdown"/);
  assert.match(csv, /"返回网页而非 Markdown"/);
  assert.match(csv, /这不一定是 Cookie 失效/);
});

test('FailureCsvLogger localizes encrypted block password mismatch to Chinese', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-03-21T12:00:00.000Z',
    book_name: 'AI',
    doc_name: 'Encrypted Note',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'encrypted-block-password-mismatch',
    error_type: 'EncryptedBlockLocked',
    error_message: 'Tried 3 preset passwords, but none could unlock the encrypted block.',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /"加密块密码校验失败"/);
  assert.match(csv, /"加密块未解锁"/);
  assert.match(csv, /已依次尝试 3 个预设密码/);
});

test('FailureCsvLogger localizes skipped asset downloads without failing the whole document', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-04-04T04:04:04.000Z',
    book_name: 'AI',
    doc_name: 'ComfyUI',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'rewrite-markdown',
    error_type: 'AssetDownloadSkipped',
    error_message:
      'Skipped downloading image asset https://camo.githubusercontent.com/demo because Request failed with status code 403. The original remote link will be kept in markdown.',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /"改写链接与下载资源"/);
  assert.match(csv, /"资源下载已跳过"/);
  assert.match(
    csv,
    /图片资源下载失败，已跳过并在 Markdown 中保留原始链接：https:\/\/camo\.githubusercontent\.com\/demo。原始错误：服务器返回 403/,
  );
});

test('FailureCsvLogger localizes missing exported asset references for partial export auditing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-failure-'));
  const logger = new FailureCsvLogger(tempDir);
  logger.append({
    timestamp: '2026-04-04T04:04:05.000Z',
    book_name: 'AI',
    doc_name: 'ComfyUI',
    yuque_path: 'https://www.yuque.com/demo/book/doc',
    target_md_path: 'D:/vault/book/doc.md',
    phase: 'write-markdown',
    error_type: 'MissingExportedAsset',
    error_message:
      'Markdown references missing exported image asset _assets/images/missing.png (resolved path: D:\\vault\\book\\_assets\\images\\missing.png).',
    retry_count: 0,
  });

  const csv = fs.readFileSync(logger.filePath, 'utf8');
  assert.match(csv, /"写入 Markdown 文件"/);
  assert.match(csv, /"导出资源缺失"/);
  assert.match(
    csv,
    /Markdown 中引用的本地图片文件不存在：_assets\/images\/missing\.png。解析后的路径：D:\\vault\\book\\_assets\\images\\missing\.png。/,
  );
});

test('localizeFailureRecord marks unrepaired missing assets as remote-retained warnings', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'AssetRetainedRemote',
    error_message:
      'Kept remote image asset https://img-blog.csdnimg.cn/demo.png because the broken local export reference _assets/images/demo.png could not be recovered as a local file.',
  });

  assert.equal(localized.phase, '改写链接与下载资源');
  assert.equal(localized.error_type, '资源已保留远程链接');
  assert.match(localized.error_message, /无法补救为本地文件/);
  assert.match(localized.error_message, /https:\/\/img-blog\.csdnimg\.cn\/demo\.png/);
  assert.match(localized.error_message, /_assets\/images\/demo\.png/);
});

test('localizeFailureRecord explains rejected rendered image fallbacks as white-image prevention', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because the image never finished loading (natural size: 0x0, client size: 659x0, complete: true). The original remote link will be kept in markdown.',
  });

  assert.equal(localized.phase, '改写链接与下载资源');
  assert.equal(localized.error_type, '图片渲染兜底已拒绝');
  assert.match(localized.error_message, /已拒绝使用白图\/空图作为兜底/);
  assert.match(localized.error_message, /原始下载错误：语雀返回 404/);
  assert.match(localized.error_message, /原始尺寸=0x0/);
  assert.match(localized.error_message, /是否完成=是/);
});

test('localizeFailureRecord explains placeholder-only rendered image fallbacks in Chinese', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because the recovery browser only showed a rejected-image placeholder instead of the real image (natural size: 0x0, client size: 905x0, complete: true, visible text: "该图片可能违规或链接失效"). The original remote link will be kept in markdown.',
  });

  assert.notEqual(localized.error_type, 'ImageFallbackRejected');
  assert.match(localized.error_message, /404/);
  assert.match(localized.error_message, /兜底失败原因|占位|placeholder/i);
  assert.match(localized.error_message, /图片失效|违规|可见文字|visible text/i);
});

test('localizeFailureRecord explains blank capture containers in Chinese', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because the recovery browser only found a blank capture container for the image slot (natural size: 0x0, client size: 905x449, complete: true). The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /空白图片容器|空白容器|blank/i);
  assert.match(localized.error_message, /905x449/);
});

test('localizeFailureRecord explains blank captures rejected as false success in Chinese', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because the recovery browser screenshot was nearly blank and was rejected as a blank capture (natural size: 0x0, client size: 905x449, complete: true, screenshot bytes: 2301). The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /空白图|白图|blank/i);
  assert.match(localized.error_message, /2301/);
});

test('localizeFailureRecord explains missing edit entry in Chinese', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because the recovery browser could not find a visible document edit entry button. The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /编辑|edit/i);
  assert.match(localized.error_message, /404/);
  assert.doesNotMatch(localized.error_message, /visible document edit entry button/i);
});

test('localizeFailureRecord explains edit mode not entered without treating comment editors as success', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because clicking the document edit entry did not enter document edit mode (visible document editors: 0, visible toolbars: 0, visible minor editors: 1, max editor area: 0). The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /编辑态|编辑/i);
  assert.match(localized.error_message, /评论区|小编辑器|次级编辑器|minor/i);
  assert.match(localized.error_message, /0/);
  assert.doesNotMatch(localized.error_message, /document edit mode/i);
});

test('localizeFailureRecord explains blank edit-mode screenshots in Chinese', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageFallbackRejected',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because The original image download failed (Request failed with status code 404), and the matching Yuque-rendered image fallback was rejected because the edit-mode recovery screenshot was nearly blank and was rejected as a blank capture (natural size: 0x0, client size: 905x449, complete: true, screenshot bytes: 2301). The original remote link will be kept in markdown.',
  });

  assert.match(localized.error_message, /编辑态|编辑/i);
  assert.match(localized.error_message, /空白|白图|blank/i);
  assert.match(localized.error_message, /2301/);
  assert.doesNotMatch(localized.error_message, /edit-mode recovery screenshot was nearly blank/i);
});

test('localizeFailureRecord explains non-image download responses for images', () => {
  const localized = localizeFailureRecord({
    phase: 'rewrite-markdown',
    error_type: 'ImageResponseNotRenderable',
    error_message:
      'Skipped downloading image asset https://img.example.com/demo.png because Received an HTML document instead of image bytes while downloading image asset https://img.example.com/demo.png. The original remote link will be kept in markdown.',
  });

  assert.equal(localized.phase, '改写链接与下载资源');
  assert.equal(localized.error_type, '图片响应不可用');
  assert.match(localized.error_message, /返回的是 HTML 页面而不是图片内容/);
  assert.match(localized.error_message, /https:\/\/img\.example\.com\/demo\.png/);
});

test('localizeFailureRecord uses board sidecar wording for freeform board exports', () => {
  const localized = localizeFailureRecord({
    phase: 'capture-artifacts',
    error_type: 'BoardExportSidecarOnly',
    error_message:
      'Detected Yuque board content with freeform elements. The export kept Yuque JSON/PNG sidecars instead of a markdown outline. Reasons: unsupported-node-type:sticky-note, unsupported-root-type:shape.',
  });

  assert.equal(localized.phase, '提取表格与复杂块');
  assert.equal(localized.error_type, '画板内容已导出为附加文件');
  assert.match(localized.error_message, /Yuque JSON\/PNG sidecars/);
  assert.match(localized.error_message, /unsupported-node-type:sticky-note/);
  assert.doesNotMatch(localized.error_message, /原文链接/);
});

test('localizeFailureRecord explains crashed complex-block workers as document-level degradation', () => {
  const localized = localizeFailureRecord({
    phase: 'capture-artifacts',
    error_type: 'ArtifactCaptureCrashed',
    error_message:
      'Complex block worker crashed with exit code 3221226505 (0xC0000409). Complex artifact worker crashed with exit code 3221226505 (0xC0000409).',
  });

  assert.equal(localized.phase, '提取表格与复杂块');
  assert.equal(localized.error_type, '复杂块子进程崩溃');
  assert.match(localized.error_message, /退出码为 3221226505 \(0xC0000409\)/);
  assert.match(localized.error_message, /跳过复杂块补充并继续导出/);
});

test('localizeFailureRecord explains degraded complex-block capture without failing the whole export', () => {
  const localized = localizeFailureRecord({
    phase: 'capture-artifacts',
    error_type: 'ArtifactCaptureDegraded',
    error_message: 'Complex block capture degraded for this document: Target closed',
  });

  assert.equal(localized.phase, '提取表格与复杂块');
  assert.equal(localized.error_type, '复杂块提取已降级');
  assert.match(localized.error_message, /正文导出会继续完成/);
  assert.match(localized.error_message, /Target closed/);
});
