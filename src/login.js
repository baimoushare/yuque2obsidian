import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getCookies } from '@steipete/sweet-cookie';
import { sleep } from './utils.js';

export const YUQUE_ROOT_URL = 'https://www.yuque.com/';
export const YUQUE_LOGIN_URL = 'https://www.yuque.com/login';

const YUQUE_COOKIE_ORIGINS = [YUQUE_ROOT_URL, 'https://yuque.com/'];
const DEFAULT_BROWSER_SOURCES = ['edge', 'chrome'];

export function loadCookies(cookiePath = './cookies.json') {
  if (!fs.existsSync(cookiePath)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
}

export function saveCookies(cookiePath, cookies) {
  const directory = path.dirname(cookiePath);
  if (directory && directory !== '.') {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2), 'utf8');
}

export async function applyCookies(page, cookiePath) {
  const cookies = loadCookies(cookiePath);
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }
  return cookies;
}

export function getLoginProfileDir(cookiePath = './cookies.json') {
  const absoluteCookiePath = path.resolve(cookiePath);
  return path.join(path.dirname(absoluteCookiePath), '.yuque-login-profile');
}

export function hasYuqueSessionCookie(cookies) {
  return Array.isArray(cookies) && cookies.some((cookie) => /session|ctoken|token/i.test(cookie?.name || ''));
}

export async function collectYuqueCookies(page) {
  const urls = [YUQUE_ROOT_URL, YUQUE_LOGIN_URL, 'https://www.yuque.com/dashboard'];
  const all = [];

  for (const url of urls) {
    try {
      const cookies = await page.cookies(url);
      all.push(...cookies);
    } catch {
      // Ignore transient cookie read failures while the login page is redirecting.
    }
  }

  const deduped = new Map();
  for (const cookie of all) {
    const key = `${cookie.name}|${cookie.domain || ''}|${cookie.path || '/'}`;
    if (!deduped.has(key)) {
      deduped.set(key, cookie);
    }
  }

  return [...deduped.values()];
}

export function normalizeBrowserCookies(cookies, defaultUrl = YUQUE_ROOT_URL) {
  return cookies
    .filter((cookie) => cookie?.name && typeof cookie.value === 'string')
    .map((cookie) => {
      const normalized = {
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      };

      if (cookie.domain) {
        normalized.domain = cookie.domain;
      } else {
        normalized.url = cookie.url || defaultUrl;
      }

      if (cookie.sameSite) {
        normalized.sameSite = cookie.sameSite;
      }

      if (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires > 0) {
        normalized.expires = cookie.expires;
      }

      return normalized;
    });
}

export async function importSystemBrowserCookies(cookiePath, options = {}) {
  const result = await getCookies({
    url: YUQUE_ROOT_URL,
    origins: YUQUE_COOKIE_ORIGINS,
    browsers: DEFAULT_BROWSER_SOURCES,
    mode: 'merge',
    timeoutMs: options.cookieReadTimeoutMs ?? 5000,
    profile: options.profile,
    edgeProfile: options.edgeProfile,
    chromeProfile: options.chromeProfile,
  });

  const cookies = normalizeBrowserCookies(result.cookies);
  if (cookiePath && cookies.length > 0) {
    saveCookies(cookiePath, cookies);
  }

  return {
    cookies,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [],
  };
}

export function openUrlInDefaultBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', [url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const child = spawn('xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export async function autoLogin(page, cookiePath = './cookies.json') {
  const cookies = loadCookies(cookiePath);

  if (cookies.length > 0) {
    await page.setCookie(...cookies);
    await page.goto('https://www.yuque.com/dashboard', {
      timeout: 120000,
      waitUntil: 'networkidle2',
    });
    return cookies;
  }

  await page.goto('https://www.yuque.com/login', {
    timeout: 120000,
    waitUntil: 'domcontentloaded',
  });

  const sessionCookies = await waitForManualLogin(page);
  saveCookies(cookiePath, sessionCookies);
  return sessionCookies;
}

export async function waitForManualLogin(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const pollMs = options.pollMs ?? 1500;
  const validateLogin = options.validateLogin;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await collectYuqueCookies(page);
    const hasSession = hasYuqueSessionCookie(cookies);
    const currentUrl = page.url();

    if (hasSession) {
      if (typeof validateLogin === 'function') {
        const result = await validateLogin(cookies, currentUrl);
        if (result?.ok) {
          await sleep(1200);
          return result.cookies || cookies;
        }
      } else if (!currentUrl.includes('/login')) {
        await sleep(1200);
        return cookies;
      }
    }

    await sleep(pollMs);
  }

  throw new Error('Timed out while waiting for Yuque login.');
}
