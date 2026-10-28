#!/usr/bin/env node
// 实际账号验收仅写入新建的隔离目录；报告不打印正文、账号或资源地址。
import fs from 'node:fs';
import path from 'node:path';
import { createHttpClient, fetchCurrentUser } from '../src/yuque.js';
import { exportNotes, scanNotes } from '../src/note-exporter.js';
import { fetchNoteDetail } from '../src/notes.js';
import { convertNoteToMarkdown } from '../src/note-markdown.js';
const file = process.argv[2];
if (!file) throw new Error('请指定加密Cookie路径。');
const client = createHttpClient(file);
try {
  const user = await fetchCurrentUser(client);
  const scope = String(user.id);
  const scan = await scanNotes({ cookiePath: file }, { client });
  // 已验证单页大小为10；逐页只检查资源标记，不打印列表内容。
  const candidates = [];
  for (let offset = 0; ; offset += 10) {
    const page = await client.getJson(`https://www.yuque.com/api/modules/note/notes/NoteController/index?limit=10&offset=${offset}`);
    candidates.push(...page.pin_notes, ...page.notes);
    if (!page.has_more) break;
  }
  const selected = [candidates[0], candidates.find(n => n.has_image), candidates.find(n => n.has_attachment), candidates.find(n => n.tags?.length)].filter(Boolean);
  const sample = [...new Map(selected.map(n => [String(n.id), n])).values()].slice(0, 4);
  const root = path.resolve('runtime-validation', `notes-${Date.now()}`);
  fs.mkdirSync(root, { recursive: false });
  const config = { cookiePath: file, outputDir: root, selectedNoteKeys: sample.map(n => `yuque-note:${scope}:${n.id}`), noteAccountScope: scope, downloadImages: true, downloadAttachments: true };
  const details = [];
  for (const item of sample) {
    const note = await fetchNoteDetail(client, item.id, scope);
    const converted = convertNoteToMarkdown(note);
    details.push({ hasImage: item.has_image, hasAttachment: item.has_attachment, tagCount: note.tags.length, warningCount: converted.warnings.length, incomplete: converted.incomplete });
  }
  const first = await exportNotes(config, () => {}, { client });
  const second = await exportNotes(config, () => {}, { client });
  const target = first.notes.find(n => n.path && fs.existsSync(n.path));
  let protection = null;
  if (target) {
    fs.appendFileSync(target.path, '\n<!-- 本地修改保护验收标记 -->\n');
    const protectedResult = await exportNotes({ ...config, selectedNoteKeys: [target.documentKey] }, () => {}, { client });
    protection = protectedResult.totals.protected === 1;
  }
  const state = JSON.parse(fs.readFileSync(path.join(root, '.yuque-export-state.json'), 'utf8'));
  const assetRecords = Object.values(state.documents).flatMap(n => n.noteAssets || []);
  const offlineAssetsPresent = assetRecords.every(n => fs.existsSync(n.path));
  const summary = { scanComplete: scan.complete, scanCount: scan.totalItems, sampleCount: sample.length, details, first: first.totals, second: second.totals, localProtection: protection, assetCount: assetRecords.length, offlineAssetsPresent, outputDirectory: path.basename(root), privateContentPrinted: false };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', statusCode: error?.status || error?.response?.status || null, message: '运行验收未完成；未打印正文与凭据。' }));
  process.exitCode = 1;
}
