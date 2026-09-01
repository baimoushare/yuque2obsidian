import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserLaunchOptions } from '../src/yuque.js';
import { buildAssetDownloadCandidateUrls } from '../src/exporter.js';

test('browser launch keeps Chromium sandbox enabled by default', () => {
  const options = buildBrowserLaunchOptions({ headless: true });
  assert.equal(options.args.includes('--no-sandbox'), false);
  assert.equal(options.args.includes('--disable-setuid-sandbox'), false);
});

test('asset candidates reject local and credential-bearing URLs', () => {
  assert.deepEqual(buildAssetDownloadCandidateUrls('http://127.0.0.1/private'), []);
  assert.deepEqual(buildAssetDownloadCandidateUrls('http://user:pass@example.com/file.png'), []);
  assert.deepEqual(buildAssetDownloadCandidateUrls('https://example.com/file.png'), ['https://example.com/file.png']);
});
