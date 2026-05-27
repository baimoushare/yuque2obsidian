import axios from 'axios';
import fs from 'fs';
import puppeteer from 'puppeteer';
import { TABLE_RECORD_FETCH_LIMIT, isTableDocument as isStandaloneTableDocument, parseLaketableBody } from './table.js';
import {
  applyCookies,
  collectYuqueCookies,
  getLoginProfileDir,
  hasYuqueSessionCookie,
  loadCookies,
  saveCookies,
  waitForManualLogin,
  YUQUE_LOGIN_URL,
} from './login.js';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: '*/*',
};

const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function cookiesToHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function createHttpClient(cookiePath) {
  const cookies = loadCookies(cookiePath);
  return createHttpClientFromCookies(cookies);
}

export function createHttpClientFromCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error('Cookie collection is empty.');
  }

  const cookieMap = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
  const csrfToken = cookieMap.get('yuque_ctoken') || '';

  const instance = axios.create({
    headers: {
      ...DEFAULT_HEADERS,
      Cookie: cookiesToHeader(cookies),
      Referer: 'https://www.yuque.com/',
    },
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return {
    async getJson(url) {
      const response = await instance.get(url);
      return response.data;
    },
    async postJson(url, data, options = {}) {
      const response = await instance.post(url, data, {
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...(options.headers || {}),
        },
        ...options,
      });
      return response.data;
    },
    async request(options = {}) {
      const headers = {
        ...(options.headers || {}),
      };
      if (!headers['X-CSRF-Token'] && !headers['x-csrf-token'] && csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      if (!headers['X-Requested-With'] && !headers['x-requested-with']) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
      }
      return await instance.request({
        ...options,
        headers,
      });
    },
    async get(url, options = {}) {
      return await instance.get(url, options);
    },
  };
}

export async function fetchCurrentUser(client) {
  const payload = await client.getJson('https://www.yuque.com/api/mine');
  const user = payload?.data ?? payload ?? {};
  return {
    id: user.id ?? '',
    login: user.login ?? user.account ?? '',
    name: user.name ?? user.nickname ?? user.login ?? '',
    avatarUrl: user.avatar_url ?? user.avatar ?? '',
  };
}

async function tryFetchUserFromCookieFile(cookiePath) {
  const cookies = loadCookies(cookiePath);
  if (cookies.length === 0) {
    return null;
  }

  try {
    return await fetchCurrentUser(createHttpClientFromCookies(cookies));
  } catch {
    return null;
  }
}

async function tryFetchUserFromCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return null;
  }

  try {
    return await fetchCurrentUser(createHttpClientFromCookies(cookies));
  } catch {
    return null;
  }
}

async function persistCookiesAndReadUser(cookiePath, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0 || !hasYuqueSessionCookie(cookies)) {
    return null;
  }

  const user = await tryFetchUserFromCookies(cookies);
  if (!user) {
    return null;
  }

  saveCookies(cookiePath, cookies);
  return { cookies, user };
}

function isSameYuqueUser(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftId = String(left.id || '').trim();
  const rightId = String(right.id || '').trim();
  if (leftId && rightId && leftId === rightId) {
    return true;
  }

  const leftLogin = String(left.login || '').trim().toLowerCase();
  const rightLogin = String(right.login || '').trim().toLowerCase();
  return Boolean(leftLogin && rightLogin && leftLogin === rightLogin);
}

async function clearYuqueBrowserState(page, onEvent = () => {}) {
  // 强制切换账号时，需要清理当前浏览器页已加载的语雀会话数据。
  // 只删除磁盘上的 cookie / userDataDir 还不够；新页面可能已经从浏览器进程中恢复了旧状态。
  // 这里通过 CDP 同时清理 Cookie 与语雀 origin 下的本地存储，避免继续识别为旧账号。
  const client = await page.target().createCDPSession();
  try {
    await client.send('Network.clearBrowserCookies');
    for (const origin of ['https://www.yuque.com', 'https://yuque.com']) {
      await client.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers',
      });
    }
    emitAuthEvent(onEvent, '已清理当前浏览器页的语雀会话缓存。');
  } finally {
    await client.detach().catch(() => {});
  }
}

function emitAuthEvent(onEvent, message) {
  onEvent({
    type: 'progress',
    phase: 'login',
    message,
  });
}

function buildLoginRequiredError() {
  return 'No usable Yuque login session was found. Click "Login Yuque" and finish the sign-in flow in your browser.';
}

export async function ensureAuthenticatedCookieFile(options = {}) {
  const cookiePath = options.cookiePath;
  const existingUser = await tryFetchUserFromCookieFile(cookiePath);

  if (!existingUser) {
    throw new Error(buildLoginRequiredError());
  }

  return {
    source: 'cookie-file',
    cookieCount: loadCookies(cookiePath).length,
    user: existingUser,
  };
}

export function resolveBrowserProfileDir(options = {}) {
  const explicit = String(options.loginProfileDir || '').trim();
  if (explicit) {
    return explicit;
  }

  const cookiePath = String(options.cookiePath || '').trim();
  if (!cookiePath) {
    return '';
  }

  return getLoginProfileDir(cookiePath);
}

function clearLoginSessionArtifacts(options = {}, onEvent = () => {}) {
  const cookiePath = String(options.cookiePath || '').trim();
  const profileDir = resolveBrowserProfileDir(options);

  // 切换账号时不能只删除 cookies.json：
  // 登录浏览器使用独立 userDataDir 保存语雀会话；如果保留该目录，
  // Puppeteer 打开后会立刻复用旧账号，表现为“点击切换账号没有反应”。
  if (cookiePath && fs.existsSync(cookiePath)) {
    fs.rmSync(cookiePath, { force: true });
    emitAuthEvent(onEvent, '已清除旧登录 Cookie。');
  }

  if (profileDir && fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    emitAuthEvent(onEvent, '已清除旧登录浏览器会话，准备重新登录。');
  }
}

export function buildBrowserLaunchOptions(options = {}) {
  const requestedHeadless = options.headless ?? false;
  const launchOptions = {
    headless: requestedHeadless === true ? 'new' : requestedHeadless,
  };

  if (options.browserPath) {
    launchOptions.executablePath = options.browserPath;
  } else {
    const detectedBrowser = resolveSystemBrowserExecutable();
    if (detectedBrowser) {
      launchOptions.executablePath = detectedBrowser;
    }
  }

  const launchArgs = [
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-accelerated-2d-canvas',
    '--disable-accelerated-video-decode',
    '--disable-extensions',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-breakpad',
    '--no-first-run',
    '--no-sandbox',
    '--disable-setuid-sandbox',
  ];

  const profileDir = resolveBrowserProfileDir(options);
  if (profileDir) {
    launchOptions.userDataDir = profileDir;
  }

  if (launchOptions.headless === false) {
    launchOptions.defaultViewport = null;
    launchArgs.unshift('--start-maximized');
  }

  launchOptions.args = launchArgs;
  return launchOptions;
}

export async function launchBrowser(options = {}) {
  return await puppeteer.launch(buildBrowserLaunchOptions(options));
}

function resolveSystemBrowserExecutable() {
  if (process.platform !== 'win32') {
    return '';
  }

  return WINDOWS_BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || '';
}

async function prepareLoginPage(page) {
  await page.setUserAgent(DEFAULT_HEADERS['User-Agent']);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    Object.defineProperty(window, 'chrome', {
      value: { runtime: {} },
      configurable: true,
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4],
    });
  });
}

async function openLoginPage(page) {
  await page.goto(YUQUE_LOGIN_URL, {
    timeout: 120000,
    waitUntil: 'domcontentloaded',
  });
}

async function readBrowserLoginState(page, cookiePath) {
  const cookies = await collectYuqueCookies(page);
  return await persistCookiesAndReadUser(cookiePath, cookies);
}

async function tryReuseBrowserSession(page, options = {}) {
  await applyCookies(page, options.cookiePath);

  try {
    await page.goto('https://www.yuque.com/dashboard', {
      timeout: 120000,
      waitUntil: 'domcontentloaded',
    });
  } catch {
    // Ignore redirect and transient navigation failures; cookie verification below is authoritative.
  }

  return await readBrowserLoginState(page, options.cookiePath);
}

export async function runManualLogin(options = {}, onEvent = () => {}, runOptions = {}) {
  const previousCookies = loadCookies(options.cookiePath);
  const previousUser = await tryFetchUserFromCookies(previousCookies);

  // forceReauth 表示用户明确点击“切换账号”。
  // 此时不能复用旧 cookie 或浏览器会话，必须走完整重新登录流程。
  if (runOptions.forceReauth) {
    clearLoginSessionArtifacts(options, onEvent);
  } else if (previousUser) {
    return {
      cookieCount: previousCookies.length,
      user: previousUser,
      source: 'cookie-file',
    };
  }

  const restorePreviousSessionAfterCancel = () => {
    // 切换账号时如果用户直接关闭登录浏览器，需要恢复原 cookies.json。
    // 否则一次取消操作会让当前账号也变成不可用状态。
    if (runOptions.forceReauth && previousCookies.length > 0) {
      saveCookies(options.cookiePath, previousCookies);
      emitAuthEvent(onEvent, '已恢复原登录会话，可继续使用当前账号。');
    }
  };

  const resolvedBrowserPath = options.browserPath || resolveSystemBrowserExecutable();
  emitAuthEvent(
    onEvent,
    resolvedBrowserPath
      ? `Launching login browser: ${resolvedBrowserPath}`
      : 'Launching login browser with Puppeteer default executable.',
  );

  const browser = await launchBrowser({
    browserPath: resolvedBrowserPath,
    headless: false,
    cookiePath: options.cookiePath,
    loginProfileDir: resolveBrowserProfileDir(options),
  });

  try {
    emitAuthEvent(onEvent, 'Browser process launched. Creating login tab...');
    const page = await browser.newPage();
    emitAuthEvent(onEvent, 'Login tab created. Preparing browser page...');
    await prepareLoginPage(page);
    await page.bringToFront();

    if (runOptions.forceReauth) {
      await clearYuqueBrowserState(page, onEvent);
    }

    emitAuthEvent(onEvent, 'Login browser opened. Please finish signing in to Yuque there.');

    if (!runOptions.forceReauth) {
      emitAuthEvent(onEvent, 'Checking whether an existing Yuque session can be reused...');
      const reused = await tryReuseBrowserSession(page, options);
      if (reused?.user) {
        emitAuthEvent(onEvent, `Reused the existing browser session for ${reused.user.name}.`);
        return {
          cookieCount: reused.cookies.length,
          user: reused.user,
          source: 'browser-session',
        };
      }
    }

    emitAuthEvent(onEvent, 'Opening the Yuque login page...');
    await openLoginPage(page);
    emitAuthEvent(onEvent, 'Yuque login page opened. Waiting for sign-in to finish...');

    let hasIgnoredPreviousUserSession = false;
    const loginWait = waitForManualLogin(page, {
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      validateLogin: async (nextCookies) => {
        const nextUser = await tryFetchUserFromCookies(nextCookies);
        if (!nextUser) {
          return null;
        }

        // 如果强制切换账号时仍检测到旧账号，说明页面自动恢复了历史会话。
        // 这里忽略这次结果，继续等待用户完成真正的新账号登录。
        if (runOptions.forceReauth && previousUser && isSameYuqueUser(previousUser, nextUser)) {
          if (!hasIgnoredPreviousUserSession) {
            hasIgnoredPreviousUserSession = true;
            emitAuthEvent(onEvent, `仍检测到旧账号 ${nextUser.name || nextUser.login}，请在登录页完成切换账号。`);
          }
          return null;
        }

        saveCookies(options.cookiePath, nextCookies);
        return { ok: true, cookies: nextCookies, user: nextUser };
      },
    }).then(
      (cookies) => ({ status: 'success', cookies }),
      (error) => {
        const message = String(error?.message || error || '');
        const closedByUser = /Target closed|Session closed|Protocol error|browser has disconnected|Connection closed/i.test(message);
        if (closedByUser) {
          return { status: 'cancelled', message: '已取消切换账号，可继续使用当前账号。' };
        }
        throw error;
      },
    );

    const browserClosed = new Promise((resolve) => {
      browser.once('disconnected', () => {
        resolve({ status: 'cancelled', message: '已取消切换账号，可继续使用当前账号。' });
      });
    });

    const loginResult = await Promise.race([loginWait, browserClosed]);
    if (loginResult.status === 'cancelled') {
      restorePreviousSessionAfterCancel();
      return {
        type: 'result',
        status: 'cancelled',
        cancelled: true,
        restoredPreviousSession: Boolean(previousUser),
        user: previousUser || null,
        message: loginResult.message,
        source: 'browser-cancelled',
      };
    }

    const cookies = loginResult.cookies;
    const validated = await persistCookiesAndReadUser(options.cookiePath, cookies);
    const user = validated?.user ?? (await tryFetchUserFromCookieFile(options.cookiePath));
    if (!user) {
      throw new Error('Yuque sign-in completed in the browser, but the app could not verify the final login session.');
    }

    emitAuthEvent(onEvent, `Login succeeded. Saved the Yuque session for ${user.name}.`);
    return {
      cookieCount: validated?.cookies.length ?? cookies.length,
      user,
      source: 'browser-login',
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function openAuthenticatedPage(browser, cookiePath) {
  const page = await browser.newPage();
  await applyCookies(page, cookiePath);
  return page;
}

function looksLikeHtmlDocument(body) {
  const trimmed = String(body ?? '').trimStart();
  return /^<!doctype html\b/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /^<head[\s>]/i.test(trimmed);
}

export async function fetchMarkdown(client, docUrl) {
  const url = `https://www.yuque.com/${docUrl}/markdown?attachment=true&latexcode=false&anchor=false&linebreak=true`;
  const response = await client.get(url, {
    responseType: 'text',
    responseEncoding: 'utf8',
    transformResponse: [(value) => value],
  });

  const body = String(response.data ?? '');
  if (!body.trim()) {
    throw new Error('Received empty markdown from Yuque.');
  }
  if (looksLikeHtmlDocument(body)) {
    throw new Error('Received an HTML document instead of markdown. Yuque may have returned a sign-in, permission, or error page.');
  }

  return body;
}

export async function fetchDocDetail(client, docSlug, bookId) {
  const slug = String(docSlug ?? '').trim();
  if (!slug) {
    throw new Error('Document slug is required when fetching Yuque doc details.');
  }

  const query = new URLSearchParams({
    include_contributors: 'true',
    include_like: 'true',
    include_hits: 'true',
    merge_dynamic_data: 'false',
  });

  if (bookId != null && String(bookId).trim()) {
    query.set('book_id', String(bookId).trim());
  }

  const payload = await client.getJson(`https://www.yuque.com/api/docs/${encodeURIComponent(slug)}?${query.toString()}`);
  return payload?.data ?? payload ?? {};
}

export function isTableDocument(docDetail = {}) {
  return isStandaloneTableDocument(docDetail);
}

export function parseTableDocumentBody(docDetail = {}) {
  return parseLaketableBody(docDetail?.body ?? docDetail?.content ?? '');
}

export async function fetchTableRecords(client, options = {}) {
  const docId = Number(options.docId || 0);
  const sheetId = String(options.sheetId || '').trim();
  if (!docId || !sheetId) {
    throw new Error('docId and sheetId are required when fetching Yuque table records.');
  }

  const query = new URLSearchParams({
    docId: String(docId),
    docType: String(options.docType || 'Doc'),
    sheetId,
    limit: String(options.limit || TABLE_RECORD_FETCH_LIMIT),
    offset: String(options.offset || 0),
  });

  const payload = await client.getJson(
    `https://www.yuque.com/api/modules/table/doc/TableRecordController/show?${query.toString()}`,
  );
  return payload ?? {};
}

export async function fetchAllTableRecords(client, options = {}) {
  const limit = Number(options.limit || TABLE_RECORD_FETCH_LIMIT) || TABLE_RECORD_FETCH_LIMIT;
  let offset = Number(options.offset || 0) || 0;
  const records = [];
  let hasMore = true;

  while (hasMore) {
    const payload = await fetchTableRecords(client, {
      ...options,
      offset,
      limit,
    });
    const batch = Array.isArray(payload?.records) ? payload.records : [];
    records.push(...batch);

    hasMore = Boolean(payload?.hasMore) && batch.length > 0;
    offset += batch.length;
    if (batch.length === 0) {
      hasMore = false;
    }
  }

  return records;
}

export async function fetchTableRecordContent(client, options = {}) {
  const docId = Number(options.docId || 0);
  const sheetId = String(options.sheetId || '').trim();
  const recordIds = Array.isArray(options.recordIds)
    ? options.recordIds.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!docId || !sheetId || recordIds.length === 0) {
    return {};
  }

  const payload = await client.postJson(
    'https://www.yuque.com/api/modules/table/doc/TableRecordController/getContent',
    {
      docId,
      docType: String(options.docType || 'Doc'),
      sheetId,
      recordIds,
    },
  );
  return payload?.content ?? payload ?? {};
}
