import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliConfig } from '../src/cli.js';

test('parseCliConfig preserves legacy configs and defaults re-encryption to off', () => {
  const config = parseCliConfig(
    JSON.stringify({
      outputDir: 'D:/export',
      encryptedBlockPasswords: ['first', 'second'],
      encryptedBlockPassword: 'legacy-first',
    }),
  );

  assert.equal(config.outputDir, 'D:/export');
  assert.deepEqual(config.encryptedBlockPasswords, ['first', 'second']);
  assert.equal(config.encryptedBlockPassword, 'first');
  assert.equal(config.reencryptEncryptedBlocksMode, 'off');
  assert.equal(config.reencryptGlobalPassword, '');
});

test('parseCliConfig normalizes re-encryption settings from modern configs', () => {
  const config = parseCliConfig(
    JSON.stringify({
      reencryptEncryptedBlocksMode: 'GLOBAL',
      reencryptGlobalPassword: 'vault-secret',
      encryptedBlockPassword: 'legacy-first',
    }),
  );

  assert.equal(config.reencryptEncryptedBlocksMode, 'global');
  assert.equal(config.reencryptGlobalPassword, 'vault-secret');
  assert.deepEqual(config.encryptedBlockPasswords, ['legacy-first']);
});

test('parseCliConfig preserves explicit document-source selections without defaulting to all', () => {
  const config = parseCliConfig(JSON.stringify({
    selectedDocumentKeys: ['yuque:book-1:doc-1'],
  }));

  assert.deepEqual(config.selectedDocumentKeys, ['yuque:book-1:doc-1']);
  assert.deepEqual(parseCliConfig(JSON.stringify({})).selectedDocumentKeys, []);
});

test('parseCliConfig preserves a safe custom asset directory and rejects path traversal', () => {
  assert.equal(
    parseCliConfig(JSON.stringify({ assetDirectoryName: 'media files' })).assetDirectoryName,
    'media files',
  );
  assert.equal(
    parseCliConfig(JSON.stringify({ assetDirectoryName: '../outside' })).assetDirectoryName,
    '_assets',
  );
});
