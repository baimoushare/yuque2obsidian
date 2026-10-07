import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadProbeImage, imageExtension } from '../tools/probe-single-document.js';

function mockResponse({ status = 200, contentType = 'image/png', bytes = [1, 2, 3], contentLength } = {}) {
  const headers = new Map([['content-type', contentType]]);
  if (contentLength != null) headers.set('content-length', String(contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers.get(name.toLowerCase()) ?? null; } },
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
  };
}

test('本地图片探针只接受无端口的 HTTPS 语雀 CDN 地址', async () => {
  for (const url of [
    'http://cdn.nlark.com/image.png',
    'https://cdn.nlark.com:8443/image.png',
    'https://cdn.example.com/image.png',
    'https://user:secret@cdn.nlark.com/image.png',
  ]) {
    await assert.rejects(downloadProbeImage(url, path.join(os.tmpdir(), 'unused-image')), /image-host-not-allowed/);
  }
});

test('本地图片探针不跟随重定向、不携带凭据并按图片 MIME 保存', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-image-probe-'));
  const target = path.join(directory, 'image-001');
  let requestOptions;
  try {
    const savedPath = await downloadProbeImage(
      'https://cdn.nlark.com/image.png',
      target,
      async (_url, options) => {
        requestOptions = options;
        return mockResponse();
      },
    );
    assert.equal(savedPath, `${target}.png`);
    assert.equal(fs.readFileSync(savedPath).length, 3);
    assert.equal(requestOptions.credentials, 'omit');
    assert.equal(requestOptions.redirect, 'error');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('本地图片探针拒绝非图片、HTTP 错误和超限资源', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-image-probe-'));
  try {
    await assert.rejects(
      downloadProbeImage('https://cdn.nlark.com/image.png', path.join(directory, 'html'), async () =>
        mockResponse({ contentType: 'text/html' })),
      /response-is-not-an-image/,
    );
    await assert.rejects(
      downloadProbeImage('https://cdn.nlark.com/image.png', path.join(directory, 'error'), async () =>
        mockResponse({ status: 403 })),
      /image-http-403/,
    );
    await assert.rejects(
      downloadProbeImage('https://cdn.nlark.com/image.png', path.join(directory, 'large'), async () =>
        mockResponse({ contentLength: 30 * 1024 * 1024 })),
      /image-size-out-of-range/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('本地图片探针只映射明确支持的图片 MIME', () => {
  assert.equal(imageExtension('image/jpeg; charset=binary'), '.jpg');
  assert.equal(imageExtension('image/webp'), '.webp');
  assert.equal(imageExtension('text/html'), '');
});
