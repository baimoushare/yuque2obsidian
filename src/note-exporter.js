import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHttpClient, fetchCurrentUser } from './yuque.js';
import { fetchAllNotes, fetchNoteDetail } from './notes.js';
import { buildNotePlan } from './note-plan.js';
import { convertNoteToMarkdown, renderNoteMarkdown } from './note-markdown.js';
import { processMarkdown } from './markdown.js';
import { ExportStateStore, ExportControl } from './export-state.js';
import { FailureCsvLogger } from './failure-log.js';
import { resolveContentOutputDir } from './obsidian.js';
import { downloadBinaryAsset } from './exporter.js';
import { ensureDir, sanitizeFileName, writeJson } from './utils.js';

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
// 错误日志只保留稳定分类，不能回显 Axios 请求配置或带签名的资源地址。
export function noteErrorCategory(error) {
  const status = Number(error?.response?.status || error?.statusCode || error?.status);
  return status === 401 || status === 403 ? 'authentication-required'
    : status === 429 ? 'rate-limited'
      : status === 404 || status === 410 ? 'unavailable' : 'export-failed';
}
export async function scanNotes(config, options = {}) {
  const client = options.client || createHttpClient(config.cookiePath);
  const user = await fetchCurrentUser(client);
  const accountScope = String(user.id || '');
  if (!/^\d+$/.test(accountScope)) throw new Error('无法确认小记账号。');
  if (config.noteAccountScope && String(config.noteAccountScope) !== accountScope) throw new Error('小记列表属于其他账号，请重新扫描。');
  return fetchAllNotes(client, { ...options, accountScope });
}
// 写入前拒绝路径上的链接/junction，避免词法位于根内、实际却写到根外。
function assertNoLinkedPath(root, file) {
  if (!isInside(root, file)) throw new Error('小记路径越界。');
  let current = path.resolve(file);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('小记输出路径包含链接，已保护。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function writeAtomic(file, data, root) {
  assertNoLinkedPath(root, file);
  ensureDir(path.dirname(file));
  assertNoLinkedPath(root, file);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.backup-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, fs.constants.COPYFILE_EXCL);
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function assetsPresent(record, root) {
  return Array.isArray(record?.noteAssets) && record.noteAssets.every((entry) => {
    const file = path.resolve(String(entry.path || ''));
    try { assertNoLinkedPath(root, file); } catch { return false; }
    return isInside(root, file) && fs.existsSync(file) && digest(fs.readFileSync(file)) === entry.hash;
  });
}
function renderIndexMarkdown(note, bodyPath, indexPath) {
  const relative = path.relative(path.dirname(indexPath), bodyPath).split(path.sep).join('/');
  return [
    '---',
    `title: ${JSON.stringify(String(note.summary || '未命名小记'))}`,
    'type: note-index',
    `yuque_note_key: ${JSON.stringify(String(note.documentKey || ''))}`,
    `yuque_note_id: ${JSON.stringify(String(note.noteId || ''))}`,
    `yuque_account_scope: ${JSON.stringify(String(note.accountScope || ''))}`,
    'tags:',
    ...(note.tags || []).map((tag) => `  - ${JSON.stringify(String(tag))}`),
    '---',
    '',
    `[打开小记正文](<${relative}>)`,
    '',
  ].join('\n');
}
function indexesPresent(record, indexFiles, root) {
  const recorded = Array.isArray(record?.noteIndexes) ? record.noteIndexes : [];
  if (recorded.length !== indexFiles.length) return false;
  return indexFiles.every((entry) => {
    const file = path.resolve(entry.path);
    const known = recorded.find((item) => path.resolve(String(item.path || '')) === file);
    try { assertNoLinkedPath(root, file); } catch { return false; }
    return known
      && isInside(root, file)
      && fs.existsSync(file)
      && digest(fs.readFileSync(file)) === known.hash;
  });
}
export async function exportNotes(config, emit = () => {}, options = {}) {
  const keys = [...new Set((config.selectedNoteKeys || []).map(String))];
  if (!keys.length) throw new Error('请先选择至少一条小记。');
  const client = options.client || createHttpClient(config.cookiePath);
  const control = options.control || new ExportControl(config.jobControlPath);
  const user = await fetchCurrentUser(client);
  const accountScope = String(user.id || '');
  if (!/^\d+$/.test(accountScope) || String(config.noteAccountScope || '') !== accountScope || keys.some((key) => !key.startsWith(`yuque-note:${accountScope}:`) || !/^\d+$/.test(key.split(':')[2] || ''))) throw new Error('小记选择与当前登录账号不一致，请重新扫描。');
  const contentRoot = path.resolve(resolveContentOutputDir(config));
  const outputDir = path.resolve(config.outputDir);
  ensureDir(outputDir);
  assertNoLinkedPath(outputDir, path.join(outputDir, '.yuque-export-state.json'));
  const store = new ExportStateStore(outputDir);
  const logger = new FailureCsvLogger(outputDir);
  const report = { source: 'notes', accountScope, startedAt: new Date().toISOString(), outputDir, contentOutputDir: contentRoot, totals: { planned: keys.length, exported: 0, skipped: 0, incomplete: 0, failed: 0, protected: 0 }, notes: [] };
  const getDetail = options.fetchNoteDetail || fetchNoteDetail;
  const download = options.downloadBinaryAsset || downloadBinaryAsset;
  let status = 'success';
  for (const [index, key] of keys.entries()) {
    const action = control.getAction();
    if (action === 'pause' || action === 'stop') { status = action === 'pause' ? 'paused' : 'cancelled'; break; }
    const noteId = key.split(':')[2];
    let plan;
    emit({ type: 'progress', phase: 'notes', source: 'notes', status: 'running', completedDocuments: index, totalDocuments: keys.length, percent: Math.round(index / keys.length * 100), message: `正在导出小记 ${index + 1}/${keys.length}` });
    try {
      // 不信任前端正文或重试数据；始终按当前账号读取选定身份的完整详情。
      const note = await getDetail(client, noteId, accountScope);
      if (note.documentKey !== key || !note.fullContentAvailable) throw new Error('小记详情身份或完整性不符。');
      const prior = store.getRecord(key);
      plan = buildNotePlan([note], { outputDir: contentRoot, selectedNoteKeys: [key], accountScope, assetDirectoryName: config.assetDirectoryName, previousRecords: { [key]: prior } }).notes[0];
      assertNoLinkedPath(contentRoot, plan.targetMdPath);
      assertNoLinkedPath(contentRoot, path.join(plan.assetDir, 'check'));
      // 标签或日期导致目标目录变化时，仅在旧文件未被修改且新位置空闲时移动，
      // 避免留下多份正文，也绝不覆盖用户手写内容。
      const priorPath = String(prior?.targetMdPath || prior?.outputPath || '');
      let movedPrior = false;
      if (priorPath && path.resolve(priorPath) !== path.resolve(plan.targetMdPath) && fs.existsSync(priorPath)) {
        if (store.isLocalOutputModified({ ...plan, targetMdPath: priorPath }) || fs.existsSync(plan.targetMdPath)) {
          report.totals.protected += 1;
          report.notes.push({ documentKey: key, accountScope, noteId, status: 'protected', path: priorPath });
          continue;
        }
        assertNoLinkedPath(contentRoot, priorPath);
        ensureDir(path.dirname(plan.targetMdPath));
        assertNoLinkedPath(contentRoot, plan.targetMdPath);
        fs.renameSync(priorPath, plan.targetMdPath);
        movedPrior = true;
      }
      const existingPath = String(prior?.targetMdPath || '');
      if (!movedPrior && ((fs.existsSync(plan.targetMdPath) && (!prior || path.resolve(existingPath) !== path.resolve(plan.targetMdPath))) || store.isLocalOutputModified(plan))) {
        report.totals.protected += 1;
        report.notes.push({ documentKey: key, accountScope, noteId, status: 'protected', path: plan.targetMdPath });
        continue;
      }
      const sourceVersion = digest(JSON.stringify([note.bodyFormat, note.body, note.html, note.tags, note.updatedAt, config.downloadImages !== false, config.downloadAttachments !== false]));
      plan.sourceVersion = sourceVersion;
      if (config.incrementalExport !== false && store.shouldSkip(plan) && assetsPresent(prior, contentRoot) && indexesPresent(prior, plan.indexFiles || [], contentRoot)) {
        report.totals.skipped += 1;
        report.notes.push({ documentKey: key, accountScope, noteId, status: 'skipped', path: plan.targetMdPath });
        continue;
      }
      store.markQueued(plan);
      const conversion = await convertNoteToMarkdown(note);
      const issues = [...(conversion.warnings || [])];
      const assets = [];
      const cache = new Map();
      const markdown = await processMarkdown(conversion.markdown, {
        docName: '小记', targetMdPath: plan.targetMdPath, exportRoot: contentRoot, docLinkMap: new Map(),
        options: { downloadImages: config.downloadImages !== false, downloadAttachments: config.downloadAttachments !== false },
        async downloadAsset(url, kind) {
          if (cache.has(url)) return cache.get(url);
          try {
            const { response } = await download(client, url, { kind, strictNetwork: true });
            const buffer = Buffer.from(response.data);
            const parsed = new URL(url);
            let ext = path.extname(parsed.pathname).slice(0, 12);
            if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) ext = kind === 'image' ? ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[String(response.headers?.['content-type'] || '').split(';')[0]] || '.bin') : '.bin';
            const name = sanitizeFileName(`${digest(url).slice(0, 20)}${ext}`);
            const file = path.join(plan.assetDir, kind === 'image' ? 'images' : 'files', name);
            assertNoLinkedPath(contentRoot, file);
            const hash = digest(buffer);
            const owned = prior?.noteAssets?.find((item) => path.resolve(item.path) === path.resolve(file));
            if (fs.existsSync(file) && digest(fs.readFileSync(file)) !== hash && (!owned || digest(fs.readFileSync(file)) !== owned.hash)) throw new Error('本地资源被修改。');
            if (!fs.existsSync(file) || digest(fs.readFileSync(file)) !== hash) writeAtomic(file, buffer, contentRoot);
            assets.push({ path: file, hash }); cache.set(url, file); return file;
          } catch { issues.push('资源下载或本地资源保护检查未完成。'); cache.set(url, null); return null; }
        },
      });
      const raw = conversion.rawSource;
      if (raw) {
        const rawFile = path.join(plan.assetDir, `source-${digest(String(raw)).slice(0, 16)}.txt`);
        assertNoLinkedPath(contentRoot, rawFile);
        if (!fs.existsSync(rawFile)) writeAtomic(rawFile, String(raw), contentRoot);
        assets.push({ path: rawFile, hash: digest(fs.readFileSync(rawFile)) });
      }
      const priorIndexes = new Map(
        (Array.isArray(prior?.noteIndexes) ? prior.noteIndexes : [])
          .map((entry) => [path.resolve(String(entry.path || '')), String(entry.hash || '')]),
      );
      const noteIndexes = [];
      for (const indexFile of plan.indexFiles || []) {
        const file = path.resolve(indexFile.path);
        assertNoLinkedPath(contentRoot, file);
        const content = renderIndexMarkdown(note, plan.targetMdPath, file);
        const contentHash = digest(content);
        if (fs.existsSync(file)) {
          const existingHash = digest(fs.readFileSync(file));
          const knownHash = priorIndexes.get(file);
          if (!knownHash || knownHash !== existingHash) {
            // 未受本工具跟踪或被本地修改的索引保留原样，并明确标记不完整。
            issues.push(`标签「${indexFile.tag}」的索引疑似被本地修改，未覆盖。`);
            continue;
          }
          if (existingHash === contentHash) {
            noteIndexes.push({ path: file, hash: contentHash });
            continue;
          }
        }
        writeAtomic(file, content, contentRoot);
        noteIndexes.push({ path: file, hash: contentHash });
      }
      const incomplete = Boolean(conversion.incomplete || issues.length);
      const output = renderNoteMarkdown(note, markdown) + (issues.length ? `\n\n> 导出提示：${[...new Set(issues)].join('；')}\n` : '');
      writeAtomic(plan.targetMdPath, output, contentRoot);
      if (incomplete) store.markIncomplete(plan, '内容或资源未完整导出。', { outputHash: digest(output) });
      else store.markExported(plan, { outputHash: digest(output) });
      Object.assign(store.state.documents[key], { accountScope, noteId, noteAssets: assets, noteIndexes, noteSource: true, yuquePath: key }); store.flush();
      const itemStatus = incomplete ? 'incomplete' : 'exported';
      report.totals[itemStatus] += 1;
      report.notes.push({ documentKey: key, accountScope, noteId, status: itemStatus, path: plan.targetMdPath });
      if (incomplete) logger.append({ doc_name: '小记', yuque_path: key, target_md_path: plan.targetMdPath, phase: 'notes', error_type: 'NoteIncomplete', error_message: '内容或资源未完整导出。' });
    } catch (error) {
      const category = noteErrorCategory(error);
      if (plan) store.markFailed(plan, category);
      report.totals.failed += 1;
      report.notes.push({ documentKey: key, accountScope, noteId, status: 'failed', category, ...(plan ? { path: plan.targetMdPath } : {}) });
      logger.append({ doc_name: '小记', yuque_path: key, target_md_path: plan?.targetMdPath || '', phase: 'notes', error_type: category, error_message: '小记未导出，按稳定身份重试。' });
      if (category === 'authentication-required' || category === 'rate-limited') {
        // 停止请求不等于丢弃剩余选择；日志保留每个未尝试身份供精确重试。
        for (const pendingKey of keys.slice(index + 1)) {
          report.totals.failed += 1;
          report.notes.push({ documentKey: pendingKey, accountScope, noteId: pendingKey.split(':')[2], status: 'failed', category: 'not-attempted' });
          logger.append({ doc_name: '小记', yuque_path: pendingKey, phase: 'notes', error_type: 'NoteNotAttempted', error_message: '任务因鉴权或限流停止，此条尚未尝试，请重试。' });
        }
        status = 'failed'; break;
      }
    }
  }
  if (status === 'success' && (report.totals.failed || report.totals.incomplete || report.totals.protected)) status = 'partial';
  report.status = status; report.finishedAt = new Date().toISOString();
  const reportPath = path.join(outputDir, `notes-report-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
  writeJson(reportPath, report);
  control.clear();
  const result = { type: 'result', ...report, reportPath, failureCsvPath: logger.recordCount ? logger.filePath : '', totalDocuments: keys.length, completedDocuments: report.notes.length };
  emit(result); return result;
}
