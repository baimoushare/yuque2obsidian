import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBrowserCookies,
  normalizeStoredCookiesForPuppeteer,
  YUQUE_ROOT_URL,
} from '../src/login.js';

test('normalizeBrowserCookies preserves explicit cookie fields', () => {
  const cookies = normalizeBrowserCookies([
    {
      name: 'yuque_ctoken',
      value: 'abc',
      domain: '.www.yuque.com',
      path: '/workspace',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 1893456000,
    },
  ]);

  assert.deepEqual(cookies, [
    {
      name: 'yuque_ctoken',
      value: 'abc',
      domain: '.www.yuque.com',
      path: '/workspace',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 1893456000,
    },
  ]);
});

test('normalizeBrowserCookies uses default url for host-only cookies', () => {
  const cookies = normalizeBrowserCookies([
    {
      name: 'lang',
      value: 'zh-CN',
    },
  ]);

  assert.deepEqual(cookies, [
    {
      name: 'lang',
      value: 'zh-CN',
      url: YUQUE_ROOT_URL,
      path: '/',
      secure: false,
      httpOnly: false,
    },
  ]);
});

test('normalizeStoredCookiesForPuppeteer upgrades legacy partition-key shape', () => {
  const cookie = {
    name: 'partitioned',
    value: 'secret',
    partitionKey: {
      topLevelSite: 'https://www.yuque.com',
      hasCrossSiteAncestor: true,
    },
  };

  const [normalized] = normalizeStoredCookiesForPuppeteer([cookie]);

  assert.deepEqual(normalized.partitionKey, {
    sourceOrigin: 'https://www.yuque.com',
    hasCrossSiteAncestor: true,
  });
  assert.equal(cookie.partitionKey.topLevelSite, 'https://www.yuque.com');
});

test('normalizeStoredCookiesForPuppeteer preserves current and string partition keys', () => {
  const currentCookie = {
    name: 'current',
    value: 'secret',
    partitionKey: {
      sourceOrigin: 'https://www.yuque.com',
      hasCrossSiteAncestor: false,
    },
  };
  const stringCookie = {
    name: 'string',
    value: 'secret',
    partitionKey: 'https://www.yuque.com',
  };

  const normalized = normalizeStoredCookiesForPuppeteer([currentCookie, stringCookie]);

  assert.equal(normalized[0], currentCookie);
  assert.equal(normalized[1], stringCookie);
});
