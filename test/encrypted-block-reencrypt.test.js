import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEncryptedBlockRenderPlan, emptyArtifacts, mergeMarkdownWithArtifacts } from '../src/exporter.js';
import { decryptMeldBlock } from '../src/meld-encrypt.js';

const CARD_PLACEHOLDER =
  '[此处为语雀卡片，点击链接查看](https://www.yuque.com/docs/262416420#scf1R)';

test('buildEncryptedBlockRenderPlan encrypts all blocks with the global password', async () => {
  const artifacts = {
    ...emptyArtifacts(),
    encryptedBlocks: [
      {
        text: '第一段加密内容',
        matchedPassword: 'wrong-block-password',
        order: 0,
      },
    ],
  };

  const renderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
    reencryptEncryptedBlocksMode: 'global',
    reencryptGlobalPassword: 'vault-secret',
  });

  assert.equal(renderPlan.mode, 'global');
  assert.equal(renderPlan.summary.encryptedBlockCount, 1);
  assert.equal(renderPlan.warnings.length, 0);
  assert.match(renderPlan.blocks[0], /^🔐β /);

  const decrypted = await decryptMeldBlock(renderPlan.blocks[0], 'vault-secret');
  assert.equal(decrypted.text, '第一段加密内容');
});

test('buildEncryptedBlockRenderPlan uses per-block matched passwords in matched-block mode', async () => {
  const artifacts = {
    ...emptyArtifacts(),
    encryptedBlocks: [
      {
        text: '块 A',
        matchedPassword: 'pass-a',
        order: 0,
      },
      {
        text: '块 B',
        matchedPassword: 'pass-b',
        order: 1,
      },
    ],
  };

  const renderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
    reencryptEncryptedBlocksMode: 'matched-block',
  });

  assert.equal(renderPlan.summary.encryptedBlockCount, 2);
  assert.equal(renderPlan.warnings.length, 0);

  const decryptedA = await decryptMeldBlock(renderPlan.blocks[0], 'pass-a');
  const decryptedB = await decryptMeldBlock(renderPlan.blocks[1], 'pass-b');
  assert.equal(decryptedA.text, '块 A');
  assert.equal(decryptedB.text, '块 B');
});

test('buildEncryptedBlockRenderPlan uses a privacy placeholder when matched passwords are missing', async () => {
  const artifacts = {
    ...emptyArtifacts(),
    encryptedBlocks: [
      {
        text: '没有命中密码的块',
        matchedPassword: '',
        order: 0,
      },
    ],
  };

  const renderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
    reencryptEncryptedBlocksMode: 'matched-block',
  });

  assert.equal(renderPlan.summary.encryptedBlockCount, 0);
  assert.deepEqual(renderPlan.summary.missingPasswordBlockOrders, [1]);
  assert.equal(renderPlan.warnings.length, 1);
  assert.match(renderPlan.warnings[0].errorMessage, /matched passwords/i);
  assert.match(renderPlan.blocks[0], /已为保护隐私跳过明文导出/);
});

test('mergeMarkdownWithArtifacts does not dedupe identical encrypted blocks during re-encryption', async () => {
  const markdown = ['# Demo', '', CARD_PLACEHOLDER, '', CARD_PLACEHOLDER, '', 'tail'].join('\n');
  const artifacts = {
    ...emptyArtifacts(),
    encryptedBlocks: [
      {
        text: '重复内容',
        matchedPassword: 'same-secret',
        order: 0,
      },
      {
        text: '重复内容',
        matchedPassword: 'same-secret',
        order: 1,
      },
    ],
  };

  const renderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
    reencryptEncryptedBlocksMode: 'global',
    reencryptGlobalPassword: 'vault-secret',
  });
  const merged = mergeMarkdownWithArtifacts(markdown, artifacts, path.join('vault', 'Demo.md'), '', {
    encryptedBlockRenderPlan: renderPlan,
  });

  assert.equal(renderPlan.blocks.length, 2);
  assert.notEqual(renderPlan.blocks[0], renderPlan.blocks[1]);
  assert.equal((merged.match(/🔐β /g) || []).length, 2);
});

test('mergeMarkdownWithArtifacts appends Meld-compatible ciphertext when placeholders are unavailable', async () => {
  const artifacts = {
    ...emptyArtifacts(),
    encryptedBlocks: [
      {
        text: '尾部加密块',
        matchedPassword: 'tail-secret',
        order: 0,
      },
    ],
  };

  const renderPlan = await buildEncryptedBlockRenderPlan(artifacts, {
    reencryptEncryptedBlocksMode: 'matched-block',
  });
  const merged = mergeMarkdownWithArtifacts('# Demo\n\nbody', artifacts, path.join('vault', 'Demo.md'), '', {
    encryptedBlockRenderPlan: renderPlan,
  });

  assert.match(merged, /## 加密文本块导出/);
  assert.match(merged, /🔐β /);
  assert.doesNotMatch(merged, /> 尾部加密块/);
});
