import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeFailureRecord } from '../src/failure-log.js';

test('localizeFailureRecord explains skipped encrypted block re-encryption warnings', () => {
  const localized = localizeFailureRecord({
    timestamp: new Date().toISOString(),
    book_name: 'Book',
    doc_name: 'Doc',
    yuque_path: 'https://www.yuque.com/demo/book/doc-a',
    target_md_path: 'D:/vault/Doc.md',
    phase: 'write-markdown',
    error_type: 'EncryptedBlockReencryptionSkipped',
    error_message:
      'Encrypted block re-encryption mode "matched-block" could not find matched passwords for 2 block(s): #1, #3. Those blocks were kept as plaintext.',
    retry_count: 0,
  });

  assert.equal(localized.error_type, '加密块重新加密已回退');
  assert.match(localized.error_message, /2 个加密块/);
  assert.match(localized.error_message, /#1, #3/);
});

test('localizeFailureRecord explains failed encrypted block re-encryption warnings', () => {
  const localized = localizeFailureRecord({
    timestamp: new Date().toISOString(),
    book_name: 'Book',
    doc_name: 'Doc',
    yuque_path: 'https://www.yuque.com/demo/book/doc-a',
    target_md_path: 'D:/vault/Doc.md',
    phase: 'write-markdown',
    error_type: 'EncryptedBlockReencryptionFailed',
    error_message:
      'Encrypted block re-encryption mode "global" failed for 1 block(s): #2. Those blocks were kept as plaintext. First error: crypto exploded',
    retry_count: 0,
  });

  assert.equal(localized.error_type, '加密块重新加密失败');
  assert.match(localized.error_message, /模式 global/);
  assert.match(localized.error_message, /#2/);
  assert.match(localized.error_message, /crypto exploded/);
});
