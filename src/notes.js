import { extractNoteSummary } from './note-markdown.js';

// 小记仅使用调用方注入的已鉴权 client，不读取凭据，也不猜测未验证的接口。
const NOTE_ENDPOINT = 'https://www.yuque.com/api/modules/note/notes/NoteController';
// 实际接口仅验证 limit=10；更大的分页值已有422证据，不作为默认或允许上限。
const MAX_PAGE_SIZE = 10;
const MAX_PAGES = 10000;
const RATE_LIMIT_RETRIES = 2;
const RETRY_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 5000;

function normalizeId(value, field) {
  // 字符串保留超出 JS 安全整数范围的服务端 ID；数字则必须能无损表示。
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  throw new Error(`小记 ${field} 必须是正整数 ID。`);
}

function assertClient(client) {
  if (!client || typeof client.getJson !== 'function') throw new Error('小记 client 必须提供 getJson。');
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  // 只读取明确的标签名，未知对象不转成 [object Object]，也不按猜测递归展开。
  return [...new Set(tags.map((tag) => {
    const name = typeof tag === 'string' ? tag : tag?.name;
    return typeof name === 'string' ? name.trim() : '';
  }).filter(Boolean))];
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 列表与详情共用身份契约，但列表始终剥离全文，防止接口变化将正文带到扫描结果。
 * fullContentAvailable 表示详情确实包含源文或 HTML（允许合法空正文），不表示转换无损。
 */
export function normalizeNote(raw, accountScope, { detail = false } = {}) {
  const scope = normalizeId(accountScope, 'accountScope');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('小记响应必须是对象。');
  const noteId = normalizeId(raw.id, 'noteId');
  if (raw.user_id !== undefined && raw.user_id !== null) {
    const userId = normalizeId(raw.user_id, 'user_id');
    if (userId !== scope) throw new Error('小记账号身份与 accountScope 不匹配。');
  }
  const content = raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content) ? raw.content : {};
  const source = detail ? text(content.source) : '';
  const html = detail ? text(content.html) : '';
  // 服务端摘要可能是 Lake/HTML 源码；列表和文件名都必须使用可读文字。
  const summary = extractNoteSummary(content.abstract)
    || (raw.has_image ? '图片小记' : raw.has_attachment ? '附件小记' : '未命名小记');
  return {
    accountScope: scope,
    noteId,
    documentKey: `yuque-note:${scope}:${noteId}`,
    createdAt: text(raw.created_at),
    updatedAt: text(content.updated_at) || text(raw.updated_at),
    // 尚未验证小记的稳定网页路由，不用 API 地址冒充用户可打开的规范地址。
    canonicalUrl: '',
    summary,
    tags: normalizeTags(raw.tags),
    body: source,
    bodyFormat: detail ? text(content.format) : '',
    html,
    fullContentAvailable: detail && (typeof content.source === 'string' || typeof content.html === 'string'),
    rawSource: source,
  };
}

function isStopped(control) {
  return control?.getAction?.() === 'stop' || control?.signal?.aborted === true;
}

function cancelledError() {
  const error = new Error('小记读取已取消。');
  error.code = 'NOTE_CANCELLED';
  return error;
}

async function waitForRetry(milliseconds, control) {
  // 分段等待使限流退避期间也能响应现有 ExportControl，不改变共享控制模块。
  let remaining = milliseconds;
  while (remaining > 0) {
    if (isStopped(control)) throw cancelledError();
    const interval = Math.min(remaining, 50);
    await new Promise((resolve) => setTimeout(resolve, interval));
    remaining -= interval;
  }
  if (isStopped(control)) throw cancelledError();
}

function retryDelay(error, attempt) {
  const headers = error?.response?.headers;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'] ?? headers?.get?.('retry-after');
  const value = typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
  let delay = RETRY_BASE_MS * (2 ** attempt);
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    delay = Number(value) * 1000;
  } else if (value) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) delay = Math.max(0, timestamp - Date.now());
  }
  // 不能把服务端要求的长等待截短后提前请求；超过本地等待预算应明确停止。
  return Number.isFinite(delay) && delay <= MAX_RETRY_WAIT_MS ? delay : null;
}

async function requestNoteJson(client, url, control = null) {
  for (let attempt = 0; ; attempt += 1) {
    if (isStopped(control)) throw cancelledError();
    try {
      const payload = await client.getJson(url);
      if (isStopped(control)) throw cancelledError();
      return payload;
    } catch (error) {
      if (error?.code === 'NOTE_CANCELLED' || isStopped(control)) throw cancelledError();
      const status = Number(error?.response?.status ?? error?.status) || null;
      // 仅对限流有限重试；401/403 或网络错误不能以无限重试掩盖账号/权限异常。
      if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const delay = retryDelay(error, attempt);
        if (delay !== null) {
          await waitForRetry(delay, control);
          continue;
        }
      }
      // axios 错误常携带 Cookie、请求头和响应正文，禁止原样向上游日志传播。
      const failure = new Error(status === 401 || status === 403
        ? '小记鉴权或权限校验失败，请重新登录后重试。'
        : status === 429 ? '小记读取触发限流，有限重试后仍未恢复。' : '小记请求失败，未提交不完整结果。');
      failure.code = status === 401 || status === 403 ? 'NOTE_AUTH_FAILED' : status === 429 ? 'NOTE_RATE_LIMITED' : 'NOTE_REQUEST_FAILED';
      failure.status = status;
      throw failure;
    }
  }
}

/** 详情接口返回根 note；请求 ID、响应 ID 和已认证账号必须一致。 */
export async function fetchNoteDetail(client, noteId, accountScope) {
  assertClient(client);
  const id = normalizeId(noteId, 'noteId');
  const scope = normalizeId(accountScope, 'accountScope');
  const payload = await requestNoteJson(client, `${NOTE_ENDPOINT}/show?id=${id}`);
  const note = normalizeNote(payload, scope, { detail: true });
  if (note.noteId !== id) throw new Error('小记详情身份与请求 noteId 不匹配。');
  return note;
}

/**
 * 按已验证的 notes.length 增加 offset；pin_notes 不参与分页偏移。
 * 扫描原子提交：取消或异常均不能把部分列表误当作本账号的完整清单。
 */
export async function fetchAllNotes(client, {
  accountScope,
  control = null,
  onProgress = null,
  pageSize = MAX_PAGE_SIZE,
} = {}) {
  assertClient(client);
  const scope = normalizeId(accountScope, 'accountScope');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`小记 pageSize 必须在 1 到 ${MAX_PAGE_SIZE} 之间。`);
  }
  const notes = new Map();
  const ordinaryIds = new Set();
  let offset = 0;
  let pageCount = 0;
  const cancelled = () => ({ complete: false, cancelled: true, accountScope: scope, notes: [], totalItems: 0, pageCount });
  try {
    for (;;) {
      if (isStopped(control)) return cancelled();
      if (pageCount >= MAX_PAGES) throw new Error('小记分页超过安全页数上限，未提交不完整结果。');
      const payload = await requestNoteJson(client, `${NOTE_ENDPOINT}/index?limit=${pageSize}&offset=${offset}`, control);
      if (!payload || !Array.isArray(payload.notes) || !Array.isArray(payload.pin_notes) || typeof payload.has_more !== 'boolean') {
        throw new Error('小记列表响应与已验证的分页契约不符。');
      }
      const pinned = payload.pin_notes.map((raw) => normalizeNote(raw, scope));
      const ordinary = payload.notes.map((raw) => normalizeNote(raw, scope));
      // 用普通列表独立判断前进，避免服务端重复旧页但不断返回新置顶掩盖分页异常。
      const newIds = ordinary.filter((note) => !ordinaryIds.has(note.noteId));
      if ((payload.has_more && ordinary.length === 0) || (ordinary.length > 0 && newIds.length === 0)) {
        throw new Error('小记分页重复或未前进，未提交不完整结果。');
      }
      for (const note of [...pinned, ...ordinary]) notes.set(note.noteId, note);
      for (const note of ordinary) ordinaryIds.add(note.noteId);
      pageCount += 1;
      if (typeof onProgress === 'function') {
        await onProgress({ completedItems: notes.size, totalItems: payload.has_more ? null : notes.size, pageCount });
      }
      if (isStopped(control)) return cancelled();
      if (!payload.has_more) {
        return { complete: true, cancelled: false, accountScope: scope, notes: [...notes.values()], totalItems: notes.size, pageCount };
      }
      offset += ordinary.length;
    }
  } catch (error) {
    if (error?.code === 'NOTE_CANCELLED' || isStopped(control)) return cancelled();
    throw error;
  }
}
