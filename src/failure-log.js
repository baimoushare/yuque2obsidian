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
    const stamp = formatTimestamp();
    this.filePath = path.join(outputDir, `export-failures-${stamp}.csv`);
    this.latestPath = '';
    const legacyLatestPath = path.join(outputDir, 'export-failures-latest.csv');
    if (fs.existsSync(legacyLatestPath)) {
      fs.unlinkSync(legacyLatestPath);
    }
    const header = `${FAILURE_COLUMNS.map((column) => escapeCsv(column.label)).join(',')}\n`;
    fs.writeFileSync(this.filePath, `\ufeff${header}`, 'utf8');
  }

  append(record) {
    const localized = localizeFailureRecord(record);
    const line = FAILURE_COLUMNS.map((column) => escapeCsv(localized[column.key] ?? '')).join(',') + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }
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
  const map = {
    'fetch-markdown': '拉取 Markdown',
    'rewrite-markdown': '改写链接与下载资源',
    'capture-artifacts': '提取表格与复杂块',
    'write-markdown': '写入 Markdown 文件',
    'empty-document': '空文档判定',
    'encrypted-block-password-mismatch': '加密块密码校验失败',
    'document-export': '文档导出',
    'job-aborted': '任务中断',
    'artifact-warning': '复杂块处理警告',
  };
  return map[value] || value || '未知阶段';
}

function localizeErrorType(type, message) {
  if (/ENOTFOUND/i.test(message || '')) {
    return '网络解析错误';
  }
  if (/timeout|timed out/i.test(message || '')) {
    return '超时错误';
  }
  if (/404/.test(message || '')) {
    return '资源不存在';
  }
  if (/cookie/i.test(message || '') || /登录/i.test(message || '')) {
    return '登录状态错误';
  }

  const map = {
    Error: '导出错误',
    TypeError: '类型错误',
    EmptyDocument: '空文档',
    EncryptedBlockLocked: '加密块未解锁',
  };
  return map[type] || type || '导出错误';
}

function localizeErrorMessage(message) {
  const source = String(message ?? '').trim();
  if (!source) {
    return '未知错误';
  }

  if (/getaddrinfo ENOTFOUND\s+www\.yuque\.com/i.test(source) || /getaddrinfo ENOTFOUND\s+yuque\.com/i.test(source)) {
    return '无法解析语雀域名，通常是网络异常、DNS 解析失败，或浏览器快照阶段临时无法连接语雀。';
  }

  if (/Request failed with status code 404/i.test(source)) {
    return '语雀返回 404，当前文档或资源地址不存在，或该内容已被删除/无权限访问。';
  }

  if (/Received empty markdown from Yuque\./i.test(source)) {
    return '语雀返回了空的 Markdown 内容，通常表示该文档导出结果为空，或该内容不支持直接按 Markdown 导出。';
  }

  if (/Received HTML instead of markdown\. Cookies may be expired\./i.test(source)) {
    return '语雀返回的是网页而不是 Markdown，通常表示登录 Cookie 已失效，需要重新登录。';
  }

  if (/Timed out while fetching markdown for (.+)\./i.test(source)) {
    const [, docName] = source.match(/Timed out while fetching markdown for (.+)\./i) || [];
    return `拉取 Markdown 超时${docName ? `：${docName}` : ''}。通常是网络较慢、语雀响应超时，或该文档导出接口返回异常。`;
  }

  if (/Timed out while capturing complex blocks for (.+)\./i.test(source)) {
    const [, docName] = source.match(/Timed out while capturing complex blocks for (.+)\./i) || [];
    return `提取表格或复杂块超时${docName ? `：${docName}` : ''}。正文通常可以导出，但复杂内容可能未完整捕获。`;
  }

  if (/No books selected for export\./i.test(source)) {
    return '当前没有选中任何知识库，无法开始导出。';
  }

  if (/only contains the title and has no body content\./i.test(source)) {
    return '该文档只有标题，没有任何正文内容，因此已自动跳过导出，只在日志中记录说明。';
  }

  if (/Tried (\d+) preset passwords, but none could unlock the encrypted block\./i.test(source)) {
    const [, count] = source.match(/Tried (\d+) preset passwords, but none could unlock the encrypted block\./i) || [];
    return `已依次尝试 ${count || 0} 个预设密码，但都无法解锁该加密文本块，因此已跳过加密内容，并在正文中保留说明或快照。`;
  }

  if (/Encrypted block detected, but no preset password was configured\./i.test(source)) {
    return '检测到加密文本块，但当前没有配置任何预设密码，因此已跳过加密内容，并在正文中保留说明或快照。';
  }

  return source;
}
