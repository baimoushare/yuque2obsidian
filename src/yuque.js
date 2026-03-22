import axios from 'axios';
import puppeteer from 'puppeteer';
import { applyCookies, loadCookies, saveCookies, waitForManualLogin } from './login.js';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: '*/*',
};

export function cookiesToHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export function createHttpClient(cookiePath) {
  const cookies = loadCookies(cookiePath);
  if (cookies.length === 0) {
    throw new Error(`Cookie file not found or empty: ${cookiePath}`);
  }

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

export async function launchBrowser(options = {}) {
  const launchOptions = {
    headless: options.headless ?? false,
  };

  if (options.browserPath) {
    launchOptions.executablePath = options.browserPath;
  }

  return await puppeteer.launch(launchOptions);
}

export async function runManualLogin(options = {}, onEvent = () => {}) {
  const browser = await launchBrowser({
    browserPath: options.browserPath,
    headless: false,
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://www.yuque.com/login', {
      timeout: 120000,
      waitUntil: 'domcontentloaded',
    });
    onEvent({
      type: 'progress',
      phase: 'login',
      message: 'Browser opened. Please finish logging in to Yuque.',
    });

    const cookies = await waitForManualLogin(page, options.timeoutMs);
    saveCookies(options.cookiePath, cookies);
    let user = null;
    try {
      user = await fetchCurrentUser(createHttpClient(options.cookiePath));
    } catch {
      user = null;
    }
    onEvent({
      type: 'progress',
      phase: 'login',
      message: user?.name
        ? `Login successful. Cookies saved for ${user.name}.`
        : 'Login successful. Cookies saved.',
    });
    return { cookieCount: cookies.length, user };
  } finally {
    await browser.close();
  }
}

export async function openAuthenticatedPage(browser, cookiePath) {
  const page = await browser.newPage();
  await applyCookies(page, cookiePath);
  return page;
}

export async function fetchMarkdown(client, docUrl) {
  const url = `https://www.yuque.com/${docUrl}/markdown?attachment=true&latexcode=false&anchor=false&linebreak=false`;
  const response = await client.get(url, {
    responseType: 'text',
    responseEncoding: 'utf8',
    transformResponse: [(value) => value],
  });

  const body = String(response.data ?? '');
  if (!body.trim()) {
    throw new Error('Received empty markdown from Yuque.');
  }
  if (/<!doctype html/i.test(body) || /<html/i.test(body)) {
    throw new Error('Received HTML instead of markdown. Cookies may be expired.');
  }

  return body;
}
