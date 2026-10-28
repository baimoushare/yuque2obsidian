import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildNotePlan } from '../src/note-plan.js';

const OUTPUT_DIR = path.join('test-output', 'note-export');

function note(overrides = {}) {
  return {
    accountScope: '101',
    noteId: '1234567890',
    documentKey: 'yuque-note:101:1234567890',
    createdAt: '2026-10-23T00:20:30Z',
    updatedAt: '2026-10-23T01:20:30Z',
    canonicalUrl: 'https://www.yuque.com/note/1234567890',
    summary: '第一条小记',
    ...overrides,
  };
}

test('首个标签归档正文，其余标签生成索引路径，无标签归入未分类', () => {
  const tagged = note({ tags: ['工作', '计划', '计划'] });
  const result = buildNotePlan([tagged], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: [tagged.documentKey],
    accountScope: '101',
  });
  const planned = result.notes[0];
  assert.equal(planned.primaryTag, '工作');
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), planned.targetMdPath), path.join('小记', '工作', '2026', '10', '2026-10-23_082030_第一条小记__1234567890__a101.md'));
  assert.deepEqual(planned.indexFiles.map((item) => item.tag), ['计划']);
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), planned.indexFiles[0].path), path.join('小记', '计划', '2026', '10', '2026-10-23_082030_第一条小记__1234567890__a101__索引.md'));

  const plain = buildNotePlan([note({ tags: [] })], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: ['yuque-note:101:1234567890'],
    accountScope: '101',
  });
  assert.equal(plain.notes[0].primaryTag, '未分类');
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), plain.notes[0].targetMdPath).split(path.sep)[1], '未分类');
});

test('按 Asia/Shanghai 创建时间归档，计划带有小记专属资源路径和源版本', () => {
  const item = note();
  const result = buildNotePlan([item], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: [item.documentKey],
    accountScope: '101',
  });

  assert.equal(result.notes.length, 1);
  const planned = result.notes[0];
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), planned.targetMdPath), path.join('小记', '未分类', '2026', '10', '2026-10-23_082030_第一条小记__1234567890__a101.md'));
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), planned.assetDir), path.join('小记', '_assets', '101', '1234567890'));
  assert.equal(planned.absoluteDocUrl, item.canonicalUrl);
  assert.equal(planned.sourceVersion, item.updatedAt);
});

test('缺少、无效或不含时区的时间归入日期未知，绝不使用当前日期或系统时区伪造创建时间', () => {
  const item = note({ createdAt: 'not-a-date' });
  const result = buildNotePlan([item], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: [item.documentKey],
    accountScope: '101',
  });

  assert.equal(path.relative(path.resolve(OUTPUT_DIR), result.notes[0].targetMdPath), path.join('小记', '未分类', '日期未知', '第一条小记__1234567890__a101.md'));
  const noOffset = buildNotePlan([note({ createdAt: '2026-10-23T08:20:30' })], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: ['yuque-note:101:1234567890'],
    accountScope: '101',
  });
  assert.match(path.relative(path.resolve(OUTPUT_DIR), noOffset.notes[0].targetMdPath), new RegExp(`^小记\\${path.sep}未分类\\${path.sep}日期未知\\${path.sep}`));
});

test('选项必须属于当前账号，空选择、缺少项和跨账号选择均明确失败', () => {
  const own = note();
  const foreign = note({
    accountScope: '202',
    noteId: '2',
    documentKey: 'yuque-note:202:2',
  });
  const options = { outputDir: OUTPUT_DIR, accountScope: '101' };

  assert.throws(() => buildNotePlan([own], { ...options, selectedNoteKeys: [] }), /空选择不会导出全部/);
  assert.throws(() => buildNotePlan([own], { ...options, selectedNoteKeys: ['yuque-note:101:missing'] }), /不存在的小记标识/);
  assert.throws(() => buildNotePlan([own, foreign], { ...options, selectedNoteKeys: [foreign.documentKey] }), /不属于当前账号/);
});

test('恶意摘要和资源目录名不能越出导出根目录，Windows 保留名得到安全文件名', () => {
  const item = note({ summary: '../CON: 私密?.md' });
  const result = buildNotePlan([item], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: [item.documentKey],
    accountScope: '101',
    assetDirectoryName: '../outside',
  });
  const planned = result.notes[0];

  assert.equal(path.relative(path.resolve(OUTPUT_DIR), planned.targetMdPath).startsWith('..'), false);
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), planned.assetDir).startsWith('..'), false);
  assert.equal(path.basename(path.dirname(path.dirname(planned.assetDir))), '_assets');
  assert.match(path.basename(planned.targetMdPath), /CON_/i);
});

test('短 ID 相同或同名同秒的小记检测冲突，旧状态不把已改标签的小记固定在旧路径', () => {
  const first = note({ noteId: '123456789011', documentKey: 'yuque-note:101:123456789011', summary: '同名' });
  const second = note({ noteId: '123456789022', documentKey: 'yuque-note:101:123456789022', summary: '同名' });
  assert.throws(() => buildNotePlan([first, second], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: [first.documentKey, second.documentKey],
    accountScope: '101',
  }), /短 ID 冲突/);

  const oldPath = path.resolve(OUTPUT_DIR, '小记', '2025', '旧名__1234567890__a101.md');
  const regrouped = buildNotePlan([note({ tags: ['工作', '计划'] })], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: ['yuque-note:101:1234567890'],
    accountScope: '101',
    previousRecords: {
      'yuque-note:101:1234567890': {
        status: 'exported',
        accountScope: '101',
        targetMdPath: oldPath,
      },
    },
  });
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), regrouped.notes[0].targetMdPath), path.join('小记', '工作', '2026', '10', '2026-10-23_082030_第一条小记__1234567890__a101.md'));
});

test('账号和小记 ID 必须是正整数字符串，摘要按 Unicode 字符截断', () => {
  assert.throws(() => buildNotePlan([note({ accountScope: 'alpha', documentKey: 'yuque-note:alpha:1234567890' })], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: ['yuque-note:alpha:1234567890'],
    accountScope: 'alpha',
  }), /正整数字符串/);

  const summary = `${'😀'.repeat(51)}末尾`;
  const result = buildNotePlan([note({ summary })], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: ['yuque-note:101:1234567890'],
    accountScope: '101',
  });
  const fileName = path.basename(result.notes[0].targetMdPath);
  assert.equal(Array.from(fileName.replace(/^\d{4}-\d{2}-\d{2}_\d{6}_/u, '').split('__')[0]).length, 50);
});

test('旧状态中的跨账号、越界路径不会被计划采用', () => {
  const item = note({ tags: ['工作'] });
  const result = buildNotePlan([item], {
    outputDir: OUTPUT_DIR,
    selectedNoteKeys: [item.documentKey],
    accountScope: '101',
    previousRecords: {
      [item.documentKey]: { status: 'exported', accountScope: 'account-2', targetMdPath: path.resolve(OUTPUT_DIR, '小记', 'bad.md') },
    },
  });
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), result.notes[0].targetMdPath).startsWith('..'), false);
  assert.equal(path.relative(path.resolve(OUTPUT_DIR), result.notes[0].targetMdPath).split(path.sep)[1], '工作');
});
