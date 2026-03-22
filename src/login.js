import fs from 'fs';
import { sleep } from './utils.js';

export function loadCookies(cookiePath = './cookies.json') {
  if (!fs.existsSync(cookiePath)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
}

export function saveCookies(cookiePath, cookies) {
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2), 'utf8');
}

export async function applyCookies(page, cookiePath) {
  const cookies = loadCookies(cookiePath);
  if (cookies.length > 0) {
    await page.setCookie(...cookies);
  }
  return cookies;
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

export async function waitForManualLogin(page, timeoutMs = 10 * 60 * 1000, pollMs = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await page.cookies();
    const hasSession = cookies.some((cookie) => /session/i.test(cookie.name));
    const currentUrl = page.url();
    if (hasSession && !currentUrl.includes('/login')) {
      await sleep(2000);
      return await page.cookies();
    }
    await sleep(pollMs);
  }

  throw new Error('Timed out while waiting for Yuque login.');
}
