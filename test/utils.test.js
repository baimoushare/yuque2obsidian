import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeMarkdownPath, sanitizeFileName } from '../src/utils.js';

test('sanitizeFileName removes invalid Windows characters', () => {
  assert.equal(sanitizeFileName('项目:规划/第一版?'), '项目_规划_第一版_');
});

test('relativeMarkdownPath returns obsidian-friendly relative path', () => {
  const from = path.join('vault', 'Book', 'Folder', 'Note.md');
  const to = path.join('vault', 'Book', '_assets', 'images', 'cover.png');
  assert.equal(relativeMarkdownPath(from, to), '../_assets/images/cover.png');
});
