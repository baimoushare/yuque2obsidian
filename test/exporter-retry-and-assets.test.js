import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  applyComplexArtifactRetryStrategy,
  buildAssetDownloadCandidateUrls,
  isRenderedImageFallbackUsable,
  validateBinaryAssetResponse,
} from '../src/exporter.js';

test('applyComplexArtifactRetryStrategy enables safe mode and disables board PNG capture on retry', () => {
  const nextTask = applyComplexArtifactRetryStrategy(
    {
      requestedTasks: {
        captureGenericArtifacts: true,
        captureDatatables: true,
        captureEncryptedTexts: true,
        captureBoardPngs: true,
      },
    },
    2,
  );

  assert.equal(nextTask.safeMode, true);
  assert.equal(nextTask.retryAttempt, 2);
  assert.equal(nextTask.requestedTasks.captureBoardPngs, false);
  assert.equal(nextTask.requestedTasks.captureDatatables, true);
});

test('buildAssetDownloadCandidateUrls unwraps proxied asset URLs and GitHub blob downloads', () => {
  const baiduProxy = buildAssetDownloadCandidateUrls(
    'https://gimg0.baidu.com/gimg/src=https%3A%2F%2Fimg.example.com%2Fdemo.png&refer=http%3A%2F%2Fwww.baidu.com',
  );
  assert.deepEqual(baiduProxy.slice(0, 2), [
    'https://gimg0.baidu.com/gimg/src=https%3A%2F%2Fimg.example.com%2Fdemo.png&refer=http%3A%2F%2Fwww.baidu.com',
    'https://img.example.com/demo.png',
  ]);

  const githubBlob = buildAssetDownloadCandidateUrls(
    'https://github.com/siyuan-note/oceanpress/blob/main/docs/guide.png',
  );
  assert.deepEqual(githubBlob, [
    'https://github.com/siyuan-note/oceanpress/blob/main/docs/guide.png',
    'https://raw.githubusercontent.com/siyuan-note/oceanpress/main/docs/guide.png',
  ]);
});

test('validateBinaryAssetResponse rejects html payloads for image downloads', () => {
  assert.throws(
    () =>
      validateBinaryAssetResponse(
        {
          data: Buffer.from('<!doctype html><html><body>missing</body></html>', 'utf8'),
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
        },
        {
          assetUrl: 'https://img.example.com/demo.png',
          kind: 'image',
        },
      ),
    /HTML document instead of image bytes/i,
  );
});

test('validateBinaryAssetResponse rejects known placeholder image payloads before saving them as local assets', () => {
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==',
    'base64',
  );
  const placeholderHash = createHash('sha256').update(pngBuffer).digest('hex');

  assert.throws(
    () =>
      validateBinaryAssetResponse(
        {
          data: pngBuffer,
          headers: {
            'content-type': 'image/png',
          },
        },
        {
          assetUrl: 'https://cdn.example.com/fake-success.png',
          kind: 'image',
          rejectedImagePlaceholderHashes: [placeholderHash],
        },
      ),
    /matched a known placeholder image/i,
  );
});

test('isRenderedImageFallbackUsable requires real decoded image dimensions', () => {
  assert.equal(
    isRenderedImageFallbackUsable({
      naturalWidth: 905,
      naturalHeight: 449,
      clientWidth: 659,
      clientHeight: 327,
    }),
    true,
  );
  assert.equal(
    isRenderedImageFallbackUsable({
      naturalWidth: 0,
      naturalHeight: 0,
      clientWidth: 659,
      clientHeight: 0,
      complete: true,
    }),
    false,
  );
});
