import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptMeldBlock, encryptMeldBlock, normalizeReencryptMode, parseMeldBlock } from '../src/meld-encrypt.js';

test('normalizeReencryptMode falls back to off for unknown values', () => {
  assert.equal(normalizeReencryptMode('global'), 'global');
  assert.equal(normalizeReencryptMode('matched-block'), 'matched-block');
  assert.equal(normalizeReencryptMode('unknown'), 'off');
  assert.equal(normalizeReencryptMode(''), 'off');
});

test('encryptMeldBlock and decryptMeldBlock round-trip multiline Chinese text', async () => {
  const source = '第一行秘密\n第二行秘密\n第三行秘密';
  const encrypted = await encryptMeldBlock(source, 'vault-secret');
  const parsed = parseMeldBlock(encrypted);

  assert.ok(parsed);
  assert.equal(parsed?.showInReadingView, true);
  assert.match(encrypted, /^🔐β /);
  assert.match(encrypted, / 🔐$/);

  const decrypted = await decryptMeldBlock(encrypted, 'vault-secret');
  assert.equal(decrypted.text, source);
});

test('encryptMeldBlock preserves optional hints in Meld payloads', async () => {
  const encrypted = await encryptMeldBlock('hinted secret', 'vault-secret', {
    hint: 'my-hint',
    showInReadingView: false,
  });
  const parsed = parseMeldBlock(encrypted);

  assert.ok(parsed);
  assert.equal(parsed?.hint, 'my-hint');
  assert.equal(parsed?.showInReadingView, false);

  const decrypted = await decryptMeldBlock(encrypted, 'vault-secret');
  assert.equal(decrypted.text, 'hinted secret');
  assert.equal(decrypted.hint, 'my-hint');
});
