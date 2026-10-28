#!/usr/bin/env node
// 小记只读探针：不迁移凭据、不保存账号响应，仅报告契约结构。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient, fetchCurrentUser } from '../src/yuque.js';

const ROOT = 'https://www.yuque.com/api/modules/note/notes/NoteController';
export function assertReadOnlyCredential(file, platform = process.platform) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (platform === 'win32' && envelope?.format !== 'yuque-exporter-dpapi-v1') {
    throw new Error('探针拒绝读取会触发迁移的旧凭据，请先通过软件登录。');
  }
}
export function summarizeNote(note) {
  const content = note?.content;
  return {
    fields: Object.keys(note || {}).sort(),
    contentFields: content && typeof content === 'object' ? Object.keys(content).sort() : [],
    format: ['markdown', 'lake', 'html'].includes(content?.format) ? content.format : 'other-or-missing',
    sourceLength: typeof content?.source === 'string' ? content.source.length : null,
    htmlLength: typeof content?.html === 'string' ? content.html.length : null,
    hasAbstract: typeof content?.abstract === 'string',
    hasCreatedAt: Boolean(note?.created_at),
    hasUpdatedAt: Boolean(note?.updated_at || content?.updated_at),
    hasTags: Array.isArray(note?.tags),
  };
}
export async function probeNotes(client, { allPages = false, detailLimit = 3 } = {}) {
  if (!Number.isInteger(detailLimit) || detailLimit < 0 || detailLimit > 3) throw new Error('最多采样三条详情。');
  const user = await fetchCurrentUser(client);
  if (!user.id) throw new Error('无法识别当前账号。');
  const pages = [];
  const notes = new Map();
  let offset = 0;
  for (let page = 0; page < (allPages ? 1000 : 1); page += 1) {
    const payload = await client.getJson(`${ROOT}/index?limit=10&offset=${offset}`);
    if (!payload || !Array.isArray(payload.notes) || !Array.isArray(payload.pin_notes) || typeof payload.has_more !== 'boolean') {
      throw new Error('小记列表响应与已核实契约不符。');
    }
    const before = notes.size;
    for (const note of [...payload.pin_notes, ...payload.notes]) {
      if (note?.id == null) throw new Error('小记列表缺少身份。');
      notes.set(String(note.id), note);
    }
    pages.push({ fields: Object.keys(payload).sort(), count: payload.notes.length, pinnedCount: payload.pin_notes.length, hasMore: payload.has_more, sample: payload.notes[0] ? summarizeNote(payload.notes[0]) : null });
    if (!payload.has_more || !allPages) break;
    if (payload.notes.length === 0 || notes.size === before) throw new Error('分页未前进，已停止。');
    offset += payload.notes.length;
    if (page === 999) throw new Error('超过安全分页上限。');
  }
  const details = [];
  for (const note of [...notes.values()].slice(0, detailLimit)) {
    const payload = await client.getJson(`${ROOT}/show?id=${encodeURIComponent(note.id)}`);
    if (String(payload?.id) !== String(note.id)) throw new Error('详情身份不匹配。');
    details.push(summarizeNote(payload));
  }
  return { status: 'success', source: 'cookie-notes', complete: pages.at(-1)?.hasMore === false, pagination: allPages ? 'all-pages' : 'one-page', pages, distinctNotes: notes.size, details, personalContentPrinted: false };
}
async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--cookie-path');
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('必须指定 --cookie-path。');
  const file = path.resolve(args[i + 1]);
  assertReadOnlyCredential(file);
  const result = await probeNotes(createHttpClient(file), { allPages: args.includes('--all-pages') });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const status = Number(error?.response?.status) || null;
    console.error(JSON.stringify({ status: 'error', statusCode: status, category: status === 401 || status === 403 ? 'authentication-or-permission' : status === 429 ? 'rate-limited' : status ? 'http-error' : 'input-or-contract-error', message: '只读探针未完成；未输出请求、凭据或响应正文。' }));
    process.exitCode = 1;
  });
}
