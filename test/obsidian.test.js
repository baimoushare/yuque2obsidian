import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObsidianConfigSummary,
  detectObsidianDiagramCapabilities,
  normalizeVaultExportSubdir,
  parseVaultListOutput,
  planObsidianSetupActions,
  resolveContentOutputDir,
} from '../src/obsidian.js';

test('normalizeVaultExportSubdir keeps empty values and removes invalid separators', () => {
  assert.equal(normalizeVaultExportSubdir(''), '');
  assert.equal(normalizeVaultExportSubdir('语雀导出/表格'), path.join('语雀导出', '表格'));
});

test('resolveContentOutputDir switches to vault subdir when direct-to-vault is enabled', () => {
  const root = path.join(os.tmpdir(), `yuque-obsidian-${Date.now()}`);
  const outputDir = path.join(root, 'output');
  const vaultPath = path.join(root, 'vault');

  const resolved = resolveContentOutputDir({
    outputDir,
    obsidianVaultPath: vaultPath,
    vaultExportLayout: 'direct-to-vault',
    vaultExportSubdir: '语雀导出/表格',
  });

  assert.equal(resolved, path.join(vaultPath, '语雀导出', '表格'));
});

test('resolveContentOutputDir uses vault root when direct-to-vault subdir is empty', () => {
  const root = path.join(os.tmpdir(), `yuque-obsidian-root-${Date.now()}`);
  const outputDir = path.join(root, 'output');
  const vaultPath = path.join(root, 'vault');

  const resolved = resolveContentOutputDir({
    outputDir,
    obsidianVaultPath: vaultPath,
    vaultExportLayout: 'direct-to-vault',
    vaultExportSubdir: '',
  });

  assert.equal(resolved, vaultPath);
});

test('planObsidianSetupActions enables Bases and optionally installs base-board', () => {
  const actions = planObsidianSetupActions({
    setupMode: 'bases+community',
    vaultName: 'Obs-个人',
  });

  assert.deepEqual(actions.map((action) => action.kind), [
    'enable-core-plugin',
    'install-community-plugin',
  ]);
  assert.match(actions[0].args.join(' '), /plugin:enable/);
  assert.match(actions[1].args.join(' '), /plugin:install/);
});

test('parseVaultListOutput reads Obsidian CLI verbose vault output', () => {
  const vaults = parseVaultListOutput([
    'Obsidian\tD:\\01. 个人创作\\笔记知识库\\Obsidian',
    'Obs-个人\tD:\\01. 个人创作\\笔记知识库\\Obs-个人',
  ].join('\n'));

  assert.deepEqual(vaults, [
    {
      name: 'Obsidian',
      path: 'D:\\01. 个人创作\\笔记知识库\\Obsidian',
    },
    {
      name: 'Obs-个人',
      path: 'D:\\01. 个人创作\\笔记知识库\\Obs-个人',
    },
  ]);
});

test('buildObsidianConfigSummary includes normalized vault settings', () => {
  const summary = buildObsidianConfigSummary({
    outputDir: 'D:/exports',
    obsidianVaultPath: 'D:/vault',
    obsidianSetupMode: 'bases+community',
    vaultExportLayout: 'direct-to-vault',
    vaultExportSubdir: '',
  }, 'D:/vault');

  assert.equal(summary.vaultPath, 'D:/vault');
  assert.equal(summary.setupMode, 'bases+community');
  assert.equal(summary.vaultExportLayout, 'direct-to-vault');
  assert.equal(summary.vaultExportSubdir, '');
  assert.equal(summary.contentOutputDir, path.resolve('D:/vault'));
});

test('detectObsidianDiagramCapabilities only reports enabled and installed diagram plugins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-obsidian-capabilities-'));
  const pluginsRoot = path.join(root, '.obsidian', 'plugins');
  fs.mkdirSync(path.join(pluginsRoot, 'obsidian-mindmap-nextgen'), { recursive: true });
  fs.mkdirSync(path.join(pluginsRoot, 'obsidian-excalidraw-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginsRoot, 'excalidraw-extras'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.obsidian', 'community-plugins.json'),
    JSON.stringify(['obsidian-mindmap-nextgen', 'obsidian-excalidraw-plugin']),
    'utf8',
  );

  const capabilities = detectObsidianDiagramCapabilities({ vaultPath: root, cliPath: path.join(root, 'missing-cli') });
  assert.equal(capabilities.obsidianCli, false);
  assert.equal(capabilities.markmap, true);
  assert.equal(capabilities.excalidraw, true);
  assert.equal(capabilities.excalidrawExtras, false);
});
