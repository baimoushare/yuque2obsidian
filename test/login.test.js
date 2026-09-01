import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrowserCookies, YUQUE_ROOT_URL } from '../src/login.js';

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
