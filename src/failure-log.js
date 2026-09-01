import fs from 'fs';
import path from 'path';
import { ensureDir, escapeCsv, formatTimestamp } from './utils.js';

export const FAILURE_COLUMNS = [
  { key: 'timestamp', label: '记录时间' },
  { key: 'book_name', label: '知识库名称' },
  { key: 'doc_name', label: '笔记名称' },
  { key: 'yuque_path', label: '语雀路径' },
  { key: 'target_md_path', label: '本地导出路径' },
  { key: 'phase', label: '失败阶段' },
  { key: 'error_type', label: '错误类型' },
  { key: 'error_message', label: '错误原因' },
  { key: 'retry_count', label: '重试次数' },
];

export class FailureCsvLogger {
  constructor(outputDir) {
    ensureDir(outputDir);
    this.filePath = buildFailureCsvFilePath(outputDir);
    this.latestPath = '';
    const header = `${FAILURE_COLUMNS.map((column) => escapeCsv(column.label)).join(',')}\n`;
    fs.writeFileSync(this.filePath, `\ufeff${header}`, 'utf8');
  }

  append(record) {
    const localized = localizeFailureRecord(record);
    const line = FAILURE_COLUMNS.map((column) => escapeCsv(localized[column.key] ?? '')).join(',') + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
}

function buildFailureCsvFilePath(outputDir) {
  const now = new Date();
  const millis = String(now.getMilliseconds()).padStart(3, '0');
  const baseName = `export-failures-${formatTimestamp(now)}-${millis}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 8)}.csv`;
  let candidatePath = path.join(outputDir, baseName);
  let counter = 2;
  while (fs.existsSync(candidatePath)) {
    candidatePath = path.join(
      outputDir,
      baseName.replace(/\.csv$/i, `-${counter}.csv`),
    );
    counter += 1;
  }
  return candidatePath;
}

export function localizeFailureRecord(record) {
  return {
    ...record,
    phase: localizePhase(record.phase),
    error_type: localizeErrorType(record.error_type, record.error_message),
    error_message: localizeErrorMessage(record.error_message),
  };
}

function localizePhase(value) {
  const type = '';
  if (type === 'EncryptedBlockReencryptionSkipped') {
    return '加密块重新加密已回退';
  }
  if (type === 'EncryptedBlockReencryptionFailed') {
    return '加密块重新加密失败';
  }

  if (type === 'EncryptedBlockReencryptionSkipped') {
    return '加密块重新加密已回退';
  }
  if (type === 'EncryptedBlockReencryptionFailed') {
    return '加密块重新加密失败';
  }

  const map = {
    prepare: '准备导出',
    login: '登录',
    book: '知识库',
    document: '文档',
    'fetch-markdown': '拉取 Markdown',
    'rewrite-markdown': '改写链接与下载资源',
    'capture-artifacts': '提取表格与复杂块',
    'write-markdown': '写入 Markdown 文件',
    'fetch-table-records': '拉取数据表记录',
    'empty-document': '空文档判定',
    'encrypted-block-password-mismatch': '加密块密码校验失败',
    'document-export': '文档导出',
    'job-aborted': '任务中断',
    'artifact-warning': '复杂块处理警告',
    'asset-warning': '资源处理警告',
    'doc-detail-warning': '文档详情处理警告',
    'placeholder-warning': '占位内容警告',
    'obsidian-setup': 'Obsidian 设置',
    fatal: '致命错误',
  };
  return map[value] || value || '未知阶段';
}

function localizeErrorType(type, message) {
  const source = String(message || '');
  const map = {
    Error: '导出错误',
    TypeError: '类型错误',
    EmptyDocument: '空文档',
    EncryptedBlockLocked: '加密块未解锁',
    AssetDownloadSkipped: '资源下载已跳过',
    ImageResponseNotRenderable: '图片响应不可用',
    ImageFallbackRejected: '图片渲染兜底已拒绝',
    AssetRetainedRemote: '资源已保留远程链接',
    DocumentDetailSkipped: '文档详情已跳过',
    ArtifactCaptureSkipped: '复杂块提取已跳过',
    ArtifactCaptureCrashed: '复杂块子进程崩溃',
    ArtifactCaptureRetried: '复杂块提取重试后成功',
    ArtifactCaptureDegraded: '复杂块提取已降级',
    ArtifactCaptureSkippedAsUnneeded: '无需复杂块提取',
    ArtifactFallbackUsed: '复杂内容已降级导出',
    BoardExportLinked: '画板内容已导出为附加文件',
    BoardExportSidecarOnly: '画板内容已导出为附加文件',
    PartialDatatableExport: '数据表部分导出',
    MissingExportedAsset: '导出资源缺失',
    ExistingOutputBackedUp: '原文件已备份',
    StructuredTableApiFallback: '智能表已切换兜底导出',
    TableImageDownloadSkipped: '数据表图片下载已跳过',
    TableSnapshotSkipped: '数据表快照已跳过',
  };

  if (type === 'EncryptedBlockReencryptionSkipped') {
    return '加密块重新加密已回退';
  }
  if (type === 'EncryptedBlockReencryptionFailed') {
    return '加密块重新加密失败';
  }
  if (type && type !== 'Error' && map[type]) {
    return map[type];
  }

  if (/Received (?:an )?HTML (?:document )?instead of markdown/i.test(source)) {
    return '返回网页而非 Markdown';
  }
  if (/ENOTFOUND/i.test(source)) {
    return '网络解析错误';
  }
  if (/timeout|timed out/i.test(source)) {
    return '超时错误';
  }
  if (/404/.test(source)) {
    return '资源不存在';
  }
  if (/EPERM/i.test(source)) {
    return '文件被占用或权限不足';
  }
  if (/cookie/i.test(source) || /登录/i.test(source)) {
    return '登录状态错误';
  }

  if (map[type]) {
    return map[type];
  }
  return type || '导出错误';
}

function localizeErrorMessage(message) {
  const source = String(message ?? '').trim();
  if (!source) {
    return '未知错误';
  }

  const reencryptGlobalMissingMatch = source.match(
    /^Encrypted block re-encryption mode "global" could not run because no global password was configured\. (?:Falling back to plaintext|Encrypted content was replaced with privacy placeholders) for (\d+) block\(s\)\.$/i,
  );
  if (reencryptGlobalMissingMatch) {
    const [, count] = reencryptGlobalMissingMatch;
    return `已启用“全局密码重加密”，但当前未配置全局密码，因此 ${count || 0} 个加密块已替换为隐私占位符，未导出明文。`;
  }

  const reencryptMatchedPasswordMissingMatch = source.match(
    /^Encrypted block re-encryption mode "matched-block" could not find matched passwords for (\d+) block\(s\): (.+)\. Those blocks were (?:kept as plaintext|replaced with privacy placeholders)\.$/i,
  );
  if (reencryptMatchedPasswordMissingMatch) {
    const [, count, blockList] = reencryptMatchedPasswordMissingMatch;
    return `已启用“按内容块命中密码重加密”，但有 ${count || 0} 个加密块未找到对应命中密码（${blockList}），因此这些内容块已替换为隐私占位符，未导出明文。`;
  }

  const reencryptFailureMatch = source.match(
    /^Encrypted block re-encryption mode "(.+)" failed for (\d+) block\(s\): (.+)\. Those blocks were (?:kept as plaintext|replaced with privacy placeholders)\. First error: (.+)$/i,
  );
  if (reencryptFailureMatch) {
    const [, mode, count, blockList, reason] = reencryptFailureMatch;
    return `加密块重加密在模式 ${mode || 'unknown'} 下失败，涉及 ${count || 0} 个内容块（${blockList}），这些内容块已替换为隐私占位符，未导出明文。首个错误：${localizeNestedErrorReason(
      reason,
    )}`;
  }

  if (/getaddrinfo ENOTFOUND\s+www\.yuque\.com/i.test(source) || /getaddrinfo ENOTFOUND\s+yuque\.com/i.test(source)) {
    return '无法解析语雀域名，通常是网络异常、DNS 解析失败，或浏览器代理环境临时无法连接语雀。';
  }

  const renderedFallbackRejectedGenericMatch = source.match(
    /^Skipped downloading image asset (.+?) because The original image download failed \((.+?)\), and the matching Yuque-rendered image fallback was rejected because (.+?)\. The original remote link will be kept in markdown\.$/i,
  );
  if (
    renderedFallbackRejectedGenericMatch &&
    !/the image never finished loading \(natural size:/i.test(renderedFallbackRejectedGenericMatch[3] || '')
  ) {
    const [, url, originalReason, fallbackReason] = renderedFallbackRejectedGenericMatch;
    return `图片原始链接下载失败，且语雀页面里的对应图片兜底最终也没有恢复成功，所以保留原始远程链接：${url}。原始下载错误：${localizeNestedErrorReason(
      originalReason,
    )}。兜底失败原因：${localizeRenderedImageFallbackReason(fallbackReason)}。`;
  }

  const renderedFallbackRejectedMatch = source.match(
    /^Skipped downloading image asset (.+?) because The original image download failed \((.+?)\), and the matching Yuque-rendered image fallback was rejected because the image never finished loading \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)\)\. The original remote link will be kept in markdown\.$/i,
  );
  if (renderedFallbackRejectedMatch) {
    const [, url, originalReason, naturalWidth, naturalHeight, clientWidth, clientHeight, complete] =
      renderedFallbackRejectedMatch;
    return `图片原始链接下载失败，且语雀页面中的对应图片并未真正加载完成，因此已拒绝使用白图/空图作为兜底，并在 Markdown 中保留原始链接：${url}。原始下载错误：${localizeNestedErrorReason(
      originalReason,
    )}。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}。`;
  }

  const nonRenderableImageHtmlMatch = source.match(
    /^Skipped downloading image asset (.+?) because Received an HTML document instead of image bytes while downloading image asset .+?\. The original remote link will be kept in markdown\.$/i,
  );
  if (nonRenderableImageHtmlMatch) {
    const [, url] = nonRenderableImageHtmlMatch;
    return `图片下载返回的是 HTML 页面而不是图片内容，因此已跳过本地导出，并在 Markdown 中保留原始链接：${url}。这通常意味着远程地址失效、被重定向到错误页，或访问被拦截。`;
  }

  const nonRenderableImageResponseMatch = source.match(
    /^Skipped downloading image asset (.+?) because Received a non-image response while downloading image asset .+?(?: \(content-type: (.+?)\))?\. The original remote link will be kept in markdown\.$/i,
  );
  if (nonRenderableImageResponseMatch) {
    const [, url, contentType] = nonRenderableImageResponseMatch;
    return `图片下载返回的不是有效图片内容，因此已跳过本地导出，并在 Markdown 中保留原始链接：${url}。${
      contentType ? `响应类型：${contentType}。` : ''
    }`;
  }

  const emptyImageResponseMatch = source.match(
    /^Skipped downloading image asset (.+?) because Downloaded image asset .+? was empty\. The original remote link will be kept in markdown\.$/i,
  );
  if (emptyImageResponseMatch) {
    const [, url] = emptyImageResponseMatch;
    return `图片下载结果为空，因此已跳过本地导出，并在 Markdown 中保留原始链接：${url}。`;
  }

  const skippedAssetMatch = source.match(
    /^Skipped downloading (image|file) asset (.+?) because (.+?)\. The original remote link will be kept in markdown\.$/i,
  );
  if (skippedAssetMatch) {
    const [, kind, url, reason] = skippedAssetMatch;
    const assetLabel = String(kind).toLowerCase() === 'image' ? '图片' : '附件';
    return `${assetLabel}资源下载失败，已跳过并在 Markdown 中保留原始链接：${url}。原始错误：${localizeNestedErrorReason(
      reason,
    )}`;
  }

  const remoteRetainedMatch = source.match(
    /^Kept remote (image|file) asset (.+?) because the broken local export reference (.+?) could not be recovered as a local file\.$/i,
  );
  if (remoteRetainedMatch) {
    const [, kind, url, brokenReference] = remoteRetainedMatch;
    const assetLabel = String(kind).toLowerCase() === 'image' ? '图片' : '附件';
    return `${assetLabel}原本已改写成本地路径，但对应文件缺失，且无法补救为本地文件，因此改为保留远程链接：${url}。失效的本地引用：${brokenReference}`;
  }

  const detailSkippedMatch = source.match(/^Document detail fetch skipped: (.+)$/i);
  if (detailSkippedMatch) {
    const [, reason] = detailSkippedMatch;
    return `文档详情接口拉取失败，已跳过详情增强并继续导出正文。原始错误：${localizeNestedErrorReason(reason || source)}`;
  }

  const captureSkippedMatch = source.match(/^Complex block capture skipped: (.+)$/i);
  if (captureSkippedMatch) {
    const [, reason] = captureSkippedMatch;
    return `复杂块提取失败，已跳过该步骤并继续导出正文。原始错误：${localizeNestedErrorReason(reason || source)}`;
  }

  const captureRetriedMatch = source.match(
    /^Complex block worker attempt (\d+) failed and will retry with a fresh browser on attempt (\d+): (.+)$/i,
  );
  if (captureRetriedMatch) {
    const [, attempt, nextAttempt, reason] = captureRetriedMatch;
    return `复杂块子进程第 ${attempt} 次执行失败，程序会在全新浏览器环境下进行第 ${nextAttempt} 次重试。原始错误：${localizeNestedErrorReason(
      reason,
    )}`;
  }

  const captureRetriedSuccessMatch = source.match(/^Complex block capture succeeded after (\d+) retry attempt\(s\)\.$/i);
  if (captureRetriedSuccessMatch) {
    const [, retryCount] = captureRetriedSuccessMatch;
    return `复杂块提取在重试 ${retryCount} 次后成功完成，本次导出已自动恢复。`;
  }

  const captureCrashedMatch = source.match(/^Complex block worker crashed with exit code (.+?)\.\s*(.+)?$/i);
  if (captureCrashedMatch) {
    const [, exitCode, reason] = captureCrashedMatch;
    return `复杂块子进程发生崩溃，退出码为 ${exitCode}。当前文档已跳过复杂块补充并继续导出。${
      reason ? ` 原始错误：${localizeNestedErrorReason(reason)}` : ''
    }`;
  }

  const captureDegradedMatch = source.match(/^Complex block capture degraded for this document: (.+)$/i);
  if (captureDegradedMatch) {
    const [, reason] = captureDegradedMatch;
    return `复杂块提取已对当前文档降级处理，正文导出会继续完成，但复杂块补充可能缺失。原始错误：${localizeNestedErrorReason(
      reason,
    )}`;
  }

  const fallbackSnapshotMatch = source.match(
    /^Used fallback snapshot export for (.+?) content\. Snapshot files kept: (\d+)\.$/i,
  );
  if (fallbackSnapshotMatch) {
    const [, kind, count] = fallbackSnapshotMatch;
    return `检测到 ${kind || '复杂'} 内容未能完整结构化导出，已保留 ${count || 0} 个快照文件作为兜底。`;
  }

  const embeddedBoardSidecarMatch = source.match(
    /^Detected embedded Yuque board card content inside a regular document\. The main markdown\/text content was exported normally, and the embedded board content was kept as Yuque JSON\/PNG sidecar files instead of a markdown outline(?:\. Reasons: (.+))?\.$/i,
  );
  if (embeddedBoardSidecarMatch) {
    const reasons = String(embeddedBoardSidecarMatch[1] || '').trim();
    if (reasons) {
      return `检测到普通文档中内嵌了语雀画板卡片。正文文本已正常导出，内嵌画板则保留为 Yuque JSON/PNG 附加文件，而不是强行改写成 Markdown 大纲。原因：${reasons}`;
    }
    return '检测到普通文档中内嵌了语雀画板卡片。正文文本已正常导出，内嵌画板则保留为 Yuque JSON/PNG 附加文件，而不是强行改写成 Markdown 大纲。';
  }

  const standaloneBoardSidecarMatch = source.match(
    /^Detected a standalone Yuque board document that could not be linearized into a markdown outline\. The export kept Yuque JSON\/PNG sidecar files instead(?:\. Reasons: (.+))?\.$/i,
  );
  if (standaloneBoardSidecarMatch) {
    const reasons = String(standaloneBoardSidecarMatch[1] || '').trim();
    if (reasons) {
      return `检测到这是一篇独立的语雀画板文档，当前无法可靠线性化为 Markdown 大纲，因此保留了 Yuque JSON/PNG 附加文件。原因：${reasons}`;
    }
    return '检测到这是一篇独立的语雀画板文档，当前无法可靠线性化为 Markdown 大纲，因此保留了 Yuque JSON/PNG 附加文件。';
  }

  if (
    /^Detected Yuque board content\. The export preserved a source-document link instead of converting the board body into standard markdown\.$/i.test(
      source,
    )
  ) {
    return '检测到语雀画板内容，旧版导出仅保留了原文链接，没有成功导出画板正文结构。';
  }

  const datatableWarningMatch = source.match(
    /^Datatable "(.+?)" exported with warnings: (.+?)(?:\. Structured success rate: (\d+)%)?\.$/i,
  );
  if (datatableWarningMatch) {
    const [, title, details, successRate] = datatableWarningMatch;
    return `数据表“${title || '未命名数据表'}”未完全导出：${details || '存在部分字段缺失'}${
      successRate ? `，结构化成功率约 ${successRate}%` : ''
    }。`;
  }

  const missingAssetMatch = source.match(
    /^Markdown references missing exported (image|file) asset (.+?) \(resolved path: (.+)\)\.$/i,
  );
  if (missingAssetMatch) {
    const [, kind, rawUrl, resolvedPath] = missingAssetMatch;
    const assetLabel = String(kind).toLowerCase() === 'image' ? '图片' : '附件';
    return `Markdown 中引用的本地${assetLabel}文件不存在：${rawUrl}。解析后的路径：${resolvedPath}。`;
  }

  const tableApiFallbackMatch = source.match(
    /^Structured Yuque table API export failed and fell back to table-view DOM parsing: (.+)$/i,
  );
  if (tableApiFallbackMatch) {
    const [, reason] = tableApiFallbackMatch;
    return `智能表的结构化 API 导出失败，已自动切换到“表格视图”页面解析兜底。原始错误：${localizeNestedErrorReason(
      reason,
    )}`;
  }

  const tableImageSkippedMatch = source.match(/^Skipped downloading Yuque table image (.+?) because (.+?)\.$/i);
  if (tableImageSkippedMatch) {
    const [, url, reason] = tableImageSkippedMatch;
    return `智能表中的图片下载失败，已跳过该图片：${url}。原始错误：${localizeNestedErrorReason(reason)}`;
  }

  const tableSnapshotSkippedMatch = source.match(
    /^Structured table export completed, but the PNG snapshot could not be captured: (.+)$/i,
  );
  if (tableSnapshotSkippedMatch) {
    const [, reason] = tableSnapshotSkippedMatch;
    return `智能表结构化导出已完成，但 PNG 快照生成失败。原始错误：${localizeNestedErrorReason(reason)}`;
  }

  if (/Request failed with status code 404/i.test(source)) {
    return '语雀返回 404，当前文档或资源地址不存在，或该内容已被删除 / 无权限访问。';
  }

  if (/Request failed with status code 403/i.test(source)) {
    return '服务器返回 403，通常表示当前资源拒绝访问，可能是外链防盗链、资源权限限制，或链接已失效。';
  }

  if (/Received empty markdown from Yuque\./i.test(source)) {
    return '语雀返回了空的 Markdown 内容，通常表示该文档导出结果为空，或该内容不支持直接按 Markdown 导出。';
  }

  if (
    /Received HTML instead of markdown\. Cookies may be expired\./i.test(source) ||
    /Received an HTML document instead of markdown\. Yuque may have returned a sign-in, permission, or error page\./i.test(
      source,
    )
  ) {
    return '语雀返回的是网页而不是 Markdown，请求可能被重定向到了登录页、权限页或错误页。这不一定是 Cookie 失效，也可能是当前文档权限或接口返回异常。';
  }

  const fetchMarkdownTimeoutMatch = source.match(/Timed out while fetching markdown for (.+)\./i);
  if (fetchMarkdownTimeoutMatch) {
    const [, docName] = fetchMarkdownTimeoutMatch;
    return `拉取 Markdown 超时${docName ? `：${docName}` : ''}。通常是网络较慢、语雀响应超时，或该文档导出接口返回异常。`;
  }

  const captureArtifactsTimeoutMatch = source.match(/Timed out while capturing complex blocks for (.+)\./i);
  if (captureArtifactsTimeoutMatch) {
    const [, docName] = captureArtifactsTimeoutMatch;
    return `提取表格或复杂块超时${docName ? `：${docName}` : ''}。正文通常仍可导出，但复杂内容可能未完整捕获。`;
  }

  if (/No books selected for export\./i.test(source)) {
    return '当前没有选中任何知识库，无法开始导出。';
  }

  if (/only contains the title and has no body content\./i.test(source)) {
    return '该文档只有标题，没有任何正文内容，因此已自动跳过导出。';
  }

  const passwordMismatchMatch = source.match(
    /Tried (\d+) preset passwords, but none could unlock the encrypted block\./i,
  );
  if (passwordMismatchMatch) {
    const [, count] = passwordMismatchMatch;
    return `已依次尝试 ${count || 0} 个预设密码，但都无法解锁该加密文本块，因此已跳过加密内容，并在正文中保留说明或快照。`;
  }

  if (/Encrypted block detected, but no preset password was configured\./i.test(source)) {
    return '检测到加密文本块，但当前没有配置任何预设密码，因此已跳过加密内容，并在正文中保留说明或快照。';
  }

  if (/EPERM/i.test(source) && /rename/i.test(source)) {
    return '目标目录正在被其他程序占用，通常是 Obsidian 或索引器正在读取文件，导致重命名失败。';
  }

  return source;
}

function localizeNestedErrorReason(reason) {
  const source = String(reason ?? '').trim();
  if (!source) {
    return '未知错误';
  }
  const localized = localizeErrorMessage(source);
  return localized && localized !== source ? localized : source;
}

function localizeRenderedImageFallbackReason(reason) {
  const source = String(reason ?? '').trim();
  if (!source) {
    return '恢复浏览器没有拿到可用图片';
  }

  if (/^the recovery browser could not find a visible document edit entry button$/i.test(source)) {
    return '恢复浏览器没有找到页面顶部可见的“编辑”按钮，因此无法进入文档编辑态继续恢复这张图片。';
  }

  const editModeNotEnteredMatch = source.match(
    /^clicking the document edit entry did not enter document edit mode \(visible document editors: (\d+), visible toolbars: (\d+), visible minor editors: (\d+), max editor area: (\d+)\)$/i,
  );
  if (editModeNotEnteredMatch) {
    const [, visibleDocumentEditors, visibleToolbars, visibleMinorEditors, maxEditorArea] = editModeNotEnteredMatch;
    return `恢复浏览器已经尝试点击页面顶部的“编辑”按钮，但没有真正进入文档编辑态。这种情况会继续拒绝把评论区小编辑器误判成正文编辑器。页面状态：可见文档编辑器=${visibleDocumentEditors}，可见工具栏=${visibleToolbars}，可见次级编辑器=${visibleMinorEditors}，最大编辑区面积=${maxEditorArea}`;
  }

  if (/^the edit-mode recovery could not locate the original image slot$/i.test(source)) {
    return '恢复浏览器已经进入编辑态，但在文档编辑器中仍没有找到这张图片对应的位置。';
  }

  const editIdentityMismatchMatch = source.match(
    /^the edit-mode recovery matched a different image than the requested slot and was rejected to avoid saving the wrong export image \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, actual current src: "(.+?)")?(?:, actual alt: "(.+?)")?\)$/i,
  );
  if (editIdentityMismatchMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, currentSrc, actualAlt] =
      editIdentityMismatchMatch;
    return `\u6062\u590d\u6d4f\u89c8\u5668\u867d\u7136\u5df2\u7ecf\u8fdb\u5165\u7f16\u8f91\u6001\uff0c\u4f46\u5f53\u524d\u547d\u4e2d\u7684\u56fe\u7247\u8eab\u4efd\u4e0e\u76ee\u6807\u56fe\u7247\u4e0d\u4e00\u81f4\uff0c\u6240\u4ee5\u62d2\u7edd\u4fdd\u5b58\u8fd9\u6b21\u622a\u56fe\uff0c\u907f\u514d\u9519\u8bef\u5730\u7528\u9519\u56fe\u8986\u76d6\u5bfc\u51fa\u7ed3\u679c\u3002\u6e32\u67d3\u72b6\u6001\uff1a\u539f\u59cb\u5c3a\u5bf8=${naturalWidth}x${naturalHeight}\uff0c\u663e\u793a\u5c3a\u5bf8=${clientWidth}x${clientHeight}\uff0c\u662f\u5426\u5b8c\u6210=${localizeBooleanWord(
      complete,
    )}${currentSrc ? `\uff0c\u5b9e\u9645 currentSrc=${currentSrc}` : ''}${actualAlt ? `\uff0c\u5b9e\u9645 alt=${actualAlt}` : ''}`;
  }

  const editDuplicateImageMatch = source.match(
    /^the edit-mode recovery screenshot matched a previously exported image with different identity and was rejected to avoid silently saving the wrong first image \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, screenshot bytes: (\d+))?(?:, content hash: "(.+?)")?(?:, actual current src: "(.+?)")?(?:, actual alt: "(.+?)")?(?:, duplicate target path: "(.+?)")?\)$/i,
  );
  if (editDuplicateImageMatch) {
    const [
      ,
      naturalWidth,
      naturalHeight,
      clientWidth,
      clientHeight,
      complete,
      captureBytes,
      contentHash,
      currentSrc,
      actualAlt,
      duplicateTargetPath,
    ] = editDuplicateImageMatch;
    return `\u6062\u590d\u6d4f\u89c8\u5668\u5728\u7f16\u8f91\u6001\u4e0b\u867d\u7136\u622a\u5230\u4e86\u56fe\u7247\uff0c\u4f46\u8fd9\u4efd\u622a\u56fe\u4e0e\u672c\u6587\u6863\u91cc\u5148\u524d\u5df2\u5bfc\u51fa\u7684\u53e6\u4e00\u5f20\u56fe\u7247\u5185\u5bb9\u5b8c\u5168\u76f8\u540c\uff0c\u800c\u4e24\u8005\u7684\u56fe\u7247\u8eab\u4efd\u5e76\u4e0d\u4e00\u81f4\uff0c\u6240\u4ee5\u5df2\u62d2\u7edd\u4fdd\u5b58\uff0c\u907f\u514d\u6574\u7bc7\u6587\u6863\u9759\u9ed8\u5730\u91cd\u590d\u6210\u7b2c\u4e00\u5f20\u56fe\u3002\u6e32\u67d3\u72b6\u6001\uff1a\u539f\u59cb\u5c3a\u5bf8=${naturalWidth}x${naturalHeight}\uff0c\u663e\u793a\u5c3a\u5bf8=${clientWidth}x${clientHeight}\uff0c\u662f\u5426\u5b8c\u6210=${localizeBooleanWord(
      complete,
    )}${captureBytes ? `\uff0c\u622a\u56fe\u5927\u5c0f=${captureBytes} \u5b57\u8282` : ''}${contentHash ? `\uff0c\u5185\u5bb9\u54c8\u5e0c=${contentHash}` : ''}${currentSrc ? `\uff0c\u5b9e\u9645 currentSrc=${currentSrc}` : ''}${actualAlt ? `\uff0c\u5b9e\u9645 alt=${actualAlt}` : ''}${duplicateTargetPath ? `\uff0c\u91cd\u590d\u76ee\u6807=${duplicateTargetPath}` : ''}`;
  }

  const editCaptureTargetAmbiguousMatch = source.match(
    /^the edit-mode recovery found only oversized or shared capture containers for the image slot and rejected them to avoid saving the wrong screenshot region \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (editCaptureTargetAmbiguousMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] =
      editCaptureTargetAmbiguousMatch;
    return `\u6062\u590d\u6d4f\u89c8\u5668\u5728\u7f16\u8f91\u6001\u4e0b\u53ea\u627e\u5230\u4e86\u8fc7\u5927\u6216\u5171\u4eab\u7684\u622a\u56fe\u5bb9\u5668\uff0c\u5f88\u53ef\u80fd\u628a\u5176\u5b83\u56fe\u7247\u4e00\u8d77\u622a\u8fdb\u6765\uff0c\u6240\u4ee5\u5df2\u62d2\u7edd\u4fdd\u5b58\uff0c\u907f\u514d\u9519\u56fe\u3002\u6e32\u67d3\u72b6\u6001\uff1a\u539f\u59cb\u5c3a\u5bf8=${naturalWidth}x${naturalHeight}\uff0c\u663e\u793a\u5c3a\u5bf8=${clientWidth}x${clientHeight}\uff0c\u662f\u5426\u5b8c\u6210=${localizeBooleanWord(
      complete,
    )}${visibleText ? `\uff0c\u53ef\u89c1\u6587\u5b57=${visibleText}` : ''}`;
  }

  const editCaptureTargetMissingMatch = source.match(
    /^the edit-mode recovery could not locate a visible capture container for the image slot \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (editCaptureTargetMissingMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] =
      editCaptureTargetMissingMatch;
    return `恢复浏览器虽然在编辑态找到了对应图片，但没有找到稳定可截图的可见容器，因此已拒绝把这次恢复当作成功。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const editPlaceholderOnlyMatch = source.match(
    /^the edit-mode recovery only showed a rejected-image placeholder instead of the real image \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (editPlaceholderOnlyMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] = editPlaceholderOnlyMatch;
    return `恢复浏览器在编辑态下这个位置只显示了“图片失效/违规”的占位内容，没有拿到真实图片。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const editBlankContainerMatch = source.match(
    /^the edit-mode recovery only found a blank capture container for the image slot \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (editBlankContainerMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] = editBlankContainerMatch;
    return `恢复浏览器在编辑态下只找到了一个有尺寸的空白图片容器，里面没有真正可导出的图片内容，所以已拒绝把这个空白容器当作成功结果。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const editBlankCaptureMatch = source.match(
    /^the edit-mode recovery screenshot was nearly blank and was rejected as a blank capture \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, screenshot bytes: (\d+))?(?:, visible text: "(.+?)")?\)$/i,
  );
  if (editBlankCaptureMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, captureBytes, visibleText] =
      editBlankCaptureMatch;
    return `恢复浏览器虽然在编辑态截到了对应图片位置，但截图结果几乎是空白图，因此已继续拒绝把这张白图当作成功图片。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${captureBytes ? `，截图大小=${captureBytes} 字节` : ''}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const editScreenshotFailedMatch = source.match(
    /^the edit-mode recovery found the image slot but could not save a screenshot \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (editScreenshotFailedMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] =
      editScreenshotFailedMatch;
    return `恢复浏览器虽然在编辑态找到了对应图片位置，但截图保存失败。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const blankContainerMatch = source.match(
    /^the recovery browser only found a blank capture container for the image slot \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (blankContainerMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] = blankContainerMatch;
    return `恢复浏览器只找到了一个有尺寸的空白图片容器，里面没有真正可导出的图片内容，所以已拒绝把这个空白容器当作成功结果。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const blankCaptureMatch = source.match(
    /^the recovery browser screenshot was nearly blank and was rejected as a blank capture \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, screenshot bytes: (\d+))?(?:, visible text: "(.+?)")?\)$/i,
  );
  if (blankCaptureMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, captureBytes, visibleText] =
      blankCaptureMatch;
    return `恢复浏览器虽然截到了图片位置，但截图结果几乎是空白图，所以已拒绝把这张白图当作成功图片。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${captureBytes ? `，截图大小=${captureBytes} 字节` : ''}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const placeholderOnlyMatch = source.match(
    /^the recovery browser only showed a rejected-image placeholder instead of the real image \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (placeholderOnlyMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] = placeholderOnlyMatch;
    return `恢复浏览器里这个位置只显示了“图片失效/违规”的占位内容，没有拿到真实图片。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const loadingMatch = source.match(
    /^the image never finished loading in the recovery browser \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)(?:, visible text: "(.+?)")?\)$/i,
  );
  if (loadingMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete, visibleText] = loadingMatch;
    return `恢复浏览器里对应图片始终没有真正加载成功。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}${visibleText ? `，可见文字=${visibleText}` : ''}`;
  }

  const captureTargetMissingMatch = source.match(
    /^the recovery browser could not locate a visible capture container for the image slot \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)\)$/i,
  );
  if (captureTargetMissingMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete] = captureTargetMissingMatch;
    return `恢复浏览器虽然找到了图片位置，但没有找到稳定可截图的可见容器。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}`;
  }

  const screenshotFailedMatch = source.match(
    /^the recovery browser found the image slot but could not save a screenshot \(natural size: (\d+)x(\d+), client size: (\d+)x(\d+), complete: (true|false)\)$/i,
  );
  if (screenshotFailedMatch) {
    const [, naturalWidth, naturalHeight, clientWidth, clientHeight, complete] = screenshotFailedMatch;
    return `恢复浏览器找到了图片位置，但截图保存失败。渲染状态：原始尺寸=${naturalWidth}x${naturalHeight}，显示尺寸=${clientWidth}x${clientHeight}，是否完成=${localizeBooleanWord(
      complete,
    )}`;
  }

  if (/the visible recovery browser could not be launched/i.test(source)) {
    return '可见恢复浏览器启动失败，因此无法继续做原位截图恢复';
  }
  if (/the recovery browser could not open the yuque document/i.test(source)) {
    return '恢复浏览器没能正常打开这篇语雀文档';
  }
  if (/the recovery browser could not locate the original image slot/i.test(source)) {
    return '恢复浏览器里已经找不到这张图片在正文中的原始位置';
  }
  if (/the edit-mode recovery failed while capturing the image slot/i.test(source)) {
    return '恢复浏览器在编辑态恢复这个图片时发生了异常，因此无法继续使用编辑态兜底。';
  }
  if (/the recovery browser failed while opening or capturing the yuque image slot/i.test(source)) {
    return '恢复浏览器在打开页面或截图这个图片位置时发生了异常';
  }

  return source;
}

function localizeBooleanWord(value) {
  const source = String(value ?? '').trim();
  if (/^true$/i.test(source)) {
    return '是';
  }
  if (/^false$/i.test(source)) {
    return '否';
  }
  return source || '未知';
}
