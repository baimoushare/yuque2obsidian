import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// 运行真实 UI 函数，桥接与 DOM 使用脱敏固定对象，不连接账号。
const source = fs.readFileSync(new URL('../desktop/ui/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const makeNode = () => ({ value: '', checked: false, disabled: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return ''; }, addEventListener() {},
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); }, querySelectorAll() { return []; }, closest() { return null; } });
  const document = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); },
    querySelectorAll() { return []; }, createElement: makeNode };
  let tick;
  const calls = [];
  const context = vm.createContext({ document, console, Set, clearInterval() {},
    setInterval(callback) { tick = callback; return 1; },
    requestAnimationFrame() {}, window: { getComputedStyle: () => ({ lineHeight: '20', paddingTop: '0', paddingBottom: '0', borderTopWidth: '0', borderBottomWidth: '0' }), pywebview: { api: {
      saveSettings: async (config) => config,
      startNoteScan: async (config) => { calls.push(['scan', config]); return { jobId: 'scan-1' }; },
      startNoteExport: async (config) => { calls.push(['export', config]); return { jobId: 'export-1' }; },
      pauseExport: async () => {}, cancelExport: async () => {},
      startRetryExportFromFailureCsv: async () => ({ jobId: 'retry-1', noteRetry: true, selectedNoteKeys: [note().documentKey], noteAccountScope: 'account-a', documentCount: 1 }),
    } } } });
  vm.runInContext(source.replace('bootstrap();', '') + '\nglobalThis.ui = { state, elements, applyNoteScanResult, scanNotes, resetNotesForAccount, toggleCategorySelection, startNoteExport, onExportButtonClick, syncControls, syncProgress, applyCompletedExportProgress, pollJob, renderNotes, startRetryExportFromFailureCsv, groupNotesByTag, setNoteSelected, setNoteGroupSelection, toggleNoteGroupCollapse, syncCategorySelectionControls };', context);
  const ui = context.ui;
  ui.state.loginUser = { id: 'account-a' };
  return { ui, context, nodes, calls, tick: () => tick() };
}
const note = (id = '1', scope = 'account-a') => ({ documentKey: `yuque-note:${scope}:${id}`, noteId: id, accountScope: scope, summary: '', tags: [] });
const snapshot = (notes = [note()]) => ({ complete: true, cancelled: false, accountScope: 'account-a', notes, totalItems: notes.length, pageCount: 1 });

// 遍历脱敏 DOM 夹具，按类名或 dataset 定位节点；不依赖真实浏览器。
function walk(node, output = []) {
  if (!node) return output;
  output.push(node);
  for (const child of node.children || []) walk(child, output);
  return output;
}
const selectNodes = (root, predicate) => walk(root).filter(predicate);
const hasClass = (node, className) =>
  typeof node?.className === 'string' && node.className.split(/\s+/u).includes(className);
const noteRows = (ui) => selectNodes(ui.elements.noteRows, (node) => hasClass(node, 'note-row'));
const groupNodes = (ui) => selectNodes(ui.elements.noteRows, (node) => node.dataset?.noteGroup != null);
const groupCheckbox = (ui, index) =>
  selectNodes(ui.elements.noteRows, (node) => node.dataset?.noteGroupSelect === String(index))[0];
const groupBody = (ui, index) =>
  selectNodes(ui.elements.noteRows, (node) => node.dataset?.noteGroupBody === String(index))[0];
const categoryCheckbox = (fixture) => fixture.nodes.get('[data-category-select="notes"]');
const tagged = (id, tags, extra = {}) => ({ ...note(id), tags, ...extra });

test('小记分类默认折叠，点击扫描入口存在且没有新增主导出按钮', () => {
  assert.match(html, /data-category-toggle="notes"[^>]*aria-expanded="false"/u);
  assert.match(html, /data-category-select="notes"/u);
  assert.match(html, /id="note-rows"/u);
  assert.doesNotMatch(html, /id="note-export-btn"/u);
});
test('完整快照提交并保留仍存在的选择，空摘要使用兜底', () => {
  const { ui, nodes } = fixture();
  ui.state.selectedNoteKeys.add(note().documentKey);
  ui.applyNoteScanResult(snapshot());
  assert.equal(ui.state.notes.length, 1);
  assert.equal(ui.state.selectedNoteKeys.size, 1);
  assert.match(JSON.stringify(nodes.get('#note-rows').children), /无文字小记/u);
});
test('取消和不完整扫描均保留上次完整快照', () => {
  const { ui } = fixture();
  ui.applyNoteScanResult(snapshot());
  for (const result of [{ ...snapshot([]), cancelled: true }, { ...snapshot([]), complete: false }]) {
    ui.applyNoteScanResult(result);
    assert.equal(ui.state.notes.length, 1);
  }
});
test('错误结构不能覆盖快照，完整空列表可以提交', () => {
  const { ui } = fixture();
  ui.applyNoteScanResult(snapshot());
  assert.throws(() => ui.applyNoteScanResult({ ...snapshot(), notes: null }));
  assert.equal(ui.state.notes.length, 1);
  ui.applyNoteScanResult(snapshot([]));
  assert.equal(ui.state.notes.length, 0);
});
test('混入其他账号或不匹配稳定键的结果被拒绝', () => {
  const { ui } = fixture();
  assert.throws(() => ui.applyNoteScanResult(snapshot([note('2', 'other')])));
  assert.throws(() => ui.applyNoteScanResult(snapshot([{ ...note(), documentKey: 'wrong' }])));
});
test('账号切换清空列表与选择并使代次失效', () => {
  const { ui } = fixture();
  ui.applyNoteScanResult(snapshot());
  ui.state.selectedNoteKeys.add(note().documentKey);
  const generation = ui.state.noteGeneration;
  ui.resetNotesForAccount();
  assert.equal(ui.state.notes.length, 0);
  assert.equal(ui.state.selectedNoteKeys.size, 0);
  assert.ok(ui.state.noteGeneration > generation);
});
test('全选小记清除其他来源选择，取消全选清空小记', () => {
  const { ui } = fixture();
  ui.applyNoteScanResult(snapshot([note(), note('2')]));
  ui.state.selectedBooks.add('book');
  ui.state.selectedDocumentKeys.add('favorite');
  ui.toggleCategorySelection('notes', true);
  assert.equal(ui.state.selectedNoteKeys.size, 2);
  assert.equal(ui.state.selectedBooks.size + ui.state.selectedDocumentKeys.size, 0);
  ui.toggleCategorySelection('notes', false);
  assert.equal(ui.state.selectedNoteKeys.size, 0);
});
test('选择其他分类清除小记，收藏协作仍可合选', () => {
  const { ui } = fixture();
  ui.applyNoteScanResult(snapshot());
  ui.state.selectedNoteKeys.add(note().documentKey);
  ui.state.documentSources = ['favorite', 'collaboration'].map((sourceType) => ({ sourceType, documentType: 'Doc', documentKey: sourceType }));
  ui.toggleCategorySelection('favorite', true);
  ui.toggleCategorySelection('collaboration', true);
  assert.equal(ui.state.selectedNoteKeys.size, 0);
  assert.equal(ui.state.selectedDocumentKeys.size, 2);
});
test('已有导出按钮路由小记并传递账号和明确选择', async () => {
  const { ui, calls } = fixture();
  ui.applyNoteScanResult(snapshot());
  ui.toggleCategorySelection('notes', true);
  await ui.onExportButtonClick();
  assert.ok(calls.length, ui.state.lastStatusMessage);
  assert.equal(calls[0][0], 'export');
  assert.deepEqual([...calls[0][1].selectedNoteKeys], [note().documentKey]);
  assert.equal(calls[0][1].noteAccountScope, 'account-a');
  assert.equal(ui.state.currentExportSource, 'notes');
});
test('空选择不触发小记导出；扫描启动期间禁止重复任务', async () => {
  const { ui, calls } = fixture();
  await ui.startNoteExport();
  assert.equal(calls.length, 0);
  await Promise.all([ui.scanNotes(), ui.scanNotes()]);
  assert.equal(calls.filter(([kind]) => kind === 'scan').length, 1);
  assert.equal(ui.state.currentJobKind, 'note-scan');
  assert.equal(ui.state.currentJobStatus, 'running');
});
test('暂停后继续沿用原选择而非被修改的界面选择', async () => {
  const { ui, calls } = fixture();
  ui.applyNoteScanResult(snapshot());
  ui.toggleCategorySelection('notes', true);
  await ui.startNoteExport();
  ui.state.currentJobStatus = 'paused';
  ui.state.selectedNoteKeys.clear();
  await ui.onExportButtonClick();
  assert.equal(calls.length, 2);
  assert.deepEqual([...calls[1][1].selectedNoteKeys], [note().documentKey]);
});
test('扫描迟到响应和旧轮询异常不污染当前任务', async () => {
  const { ui, context, tick } = fixture();
  let resolve;
  context.window.pywebview.api.getJobStatus = () => new Promise((done) => { resolve = done; });
  ui.state.currentJobId = 'old';
  ui.pollJob('old');
  const pending = tick();
  ui.resetNotesForAccount();
  ui.state.currentJobId = 'new';
  resolve({ kind: 'note-scan', status: 'success', result: snapshot() });
  await pending;
  assert.equal(ui.state.notes.length, 0);
  assert.equal(ui.state.currentJobId, 'new');
});
test('小记进度使用项目数，不显示知识库；结果统计全部状态', () => {
  const { ui } = fixture();
  ui.state.currentExportSource = 'notes';
  ui.syncProgress({ kind: 'export', events: [{ phase: 'notes', percent: 50, completedItems: 1, totalItems: 2 }] });
  assert.match(ui.elements.progressStats.textContent, /小记 1\/2/u);
  assert.doesNotMatch(ui.elements.progressStats.textContent, /知识库/u);
  ui.applyCompletedExportProgress({ source: 'notes', totals: { planned: 6, exported: 1, skipped: 1, incomplete: 1, failed: 1, protected: 2 } }, 'notes');
  assert.match(ui.elements.progressStats.textContent, /小记 6\/6/u);
});
test('小记失败终态保留计数报告和CSV，不设置成功100%', async () => {
  const { ui, context, tick } = fixture();
  ui.state.currentJobId = 'failed-note';
  ui.state.currentExportSource = 'notes';
  ui.elements.progressBar.style.width = '33%';
  context.window.pywebview.api.getJobStatus = async () => ({ kind: 'export', status: 'error', result: { source: 'notes', status: 'failed', totals: { planned: 3, exported: 1, failed: 1 }, reportPath: 'report.json', failureCsvPath: 'failure.csv' } });
  ui.pollJob('failed-note');
  await tick();
  assert.match(ui.state.lastStatusMessage, /小记导出失败.*失败 1/u);
  assert.equal(ui.elements.failureCsvPath.value, 'failure.csv');
  assert.match(ui.elements.logs.textContent, /report.json/u);
  assert.equal(ui.elements.progressBar.style.width, '33%');
});
test('小记失败重试无需先扫描，暂停后仍按原身份继续', async () => {
  const { ui, calls } = fixture();
  ui.elements.failureCsvPath.value = 'fixture.csv';
  await ui.startRetryExportFromFailureCsv();
  assert.equal(ui.state.currentExportSource, 'notes');
  assert.equal(ui.state.lastExportConfig.noteAccountScope, 'account-a');
  assert.deepEqual([...ui.state.lastExportConfig.selectedNoteKeys], [note().documentKey]);
  ui.state.currentJobStatus = 'paused';
  await ui.onExportButtonClick();
  assert.equal(calls[0][0], 'export');
  assert.deepEqual([...calls[0][1].selectedNoteKeys], [note().documentKey]);
});
test('小记扫描未知总数显示读取条数和页数', () => {
  const { ui } = fixture();
  ui.syncProgress({ kind: 'note-scan', events: [{ phase: 'note-scan', completedItems: 20, totalItems: null, pageCount: 2 }] });
  assert.equal(ui.elements.progressMeta.hidden, false);
  assert.equal(ui.elements.progressStats.textContent, '小记 20/?');
  assert.equal(ui.elements.bookProgressStats.textContent, '已读取 2 页');
});
test('小记扫描运行时启用停止且禁用登录与失败重试', () => {
  const { ui } = fixture();
  ui.state.currentJobKind = 'note-scan';
  ui.state.currentJobStatus = 'running';
  ui.syncControls();
  assert.equal(ui.elements.stopBtn.disabled, false);
  assert.equal(ui.elements.loginBtn.disabled, true);
  assert.equal(ui.elements.retryFailuresBtn.disabled, true);
});

// —— 标签分组回归：多标签同步、组内全选、无标签归组、取消与账号清理 ——
test('多标签小记出现在多个标签组，取消勾选按documentKey全局同步', () => {
  const { ui } = fixture();
  const workNote = tagged('1', ['工作', '生活']);
  const workOnly = tagged('2', ['工作']);
  ui.applyNoteScanResult(snapshot([workNote, workOnly]));

  const groups = ui.groupNotesByTag(ui.state.notes);
  assert.deepEqual(Array.from(groups, (group) => group.label), ['工作', '生活']);
  assert.deepEqual(
    Array.from(groups, (group) => Array.from(group.notes, (entry) => entry.noteId)),
    [['1', '2'], ['1']],
  );
  assert.equal(noteRows(ui).length, 3, '多标签小记应在多个组重复显示');
  assert.equal(ui.state.selectedNoteKeys.size, 0);

  ui.setNoteSelected(workNote.documentKey, true);
  assert.deepEqual([...ui.state.selectedNoteKeys], [workNote.documentKey]);
  const lifeIndex = groups.findIndex((group) => group.label === '生活');
  assert.equal(groupCheckbox(ui, lifeIndex).checked, true, '另一标签组应同步已勾选状态');
  assert.equal(groupCheckbox(ui, groups.findIndex((group) => group.label === '工作')).indeterminate, true);

  ui.setNoteSelected(workNote.documentKey, false);
  assert.equal(ui.state.selectedNoteKeys.size, 0);
  assert.equal(groupCheckbox(ui, lifeIndex).checked, false);
  assert.equal(groupCheckbox(ui, groups.findIndex((group) => group.label === '工作')).checked, false);
});

test('分组全选只增删本组，计数按documentKey去重且清除其他来源', () => {
  const fixtureInstance = fixture();
  const { ui } = fixtureInstance;
  const workNote = tagged('1', ['工作', '生活']);
  const workOnly = tagged('2', ['工作']);
  const lifeOnly = tagged('3', ['生活']);
  ui.applyNoteScanResult(snapshot([workNote, workOnly, lifeOnly]));
  ui.state.selectedBooks.add('book');
  ui.state.selectedDocumentKeys.add('favorite');

  ui.setNoteGroupSelection('工作', true);
  assert.equal(ui.state.selectedNoteKeys.size, 2);
  assert.equal(ui.state.selectedBooks.size, 0);
  assert.equal(ui.state.selectedDocumentKeys.size, 0);
  assert.equal(ui.elements.noteCount.textContent, '2/3');
  const category = categoryCheckbox(fixtureInstance);
  assert.equal(category.checked, false);
  assert.equal(category.indeterminate, true);

  ui.setNoteGroupSelection('生活', true);
  assert.equal(ui.state.selectedNoteKeys.size, 3, '跨组重复 note 只能计一次');
  assert.equal(ui.elements.noteCount.textContent, '3/3');
  assert.equal(category.checked, true);

  // 取消勾选“工作”会按 documentKey 全局移除该组小记（含同时属于“生活”的那条）。
  ui.setNoteGroupSelection('工作', false);
  assert.deepEqual([...ui.state.selectedNoteKeys], [lifeOnly.documentKey]);
  assert.equal(ui.elements.noteCount.textContent, '1/3');
});

test('无标签小记归入未分类且排在最后，组DOM标识不使用标签拼接', () => {
  const { ui } = fixture();
  const noTag = note('1');
  const withTag = tagged('2', [' 工作 ', '工作', '']);
  const quotedTag = tagged('3', ['a"b']);
  ui.applyNoteScanResult(snapshot([noTag, withTag, quotedTag]));

  const groups = ui.groupNotesByTag(ui.state.notes);
  // zh 排序把中文标签排在拉丁字符前；未分类始终最后。
  assert.deepEqual(Array.from(groups, (group) => group.label), ['工作', 'a"b', '未分类']);
  assert.deepEqual(Array.from(groups.at(-1).notes, (entry) => entry.noteId), ['1']);

  const nodes = groupNodes(ui);
  assert.deepEqual(Array.from(nodes, (node) => node.dataset.noteGroup), ['0', '1', '2']);
  assert.deepEqual(Array.from(nodes, (node) => node.id), ['note-group-0', 'note-group-1', 'note-group-2']);
  for (const node of nodes) assert.doesNotMatch(String(node.id), /工作|a"b|未分类/u);
  const untaggedTitle = selectNodes(nodes.at(-1), (node) => hasClass(node, 'note-group-title'))[0];
  assert.equal(untaggedTitle.textContent, '未分类');
});

test('远端标签只以textContent渲染，不生成HTML节点', () => {
  const { ui } = fixture();
  const hostileTag = '<img src=x onerror="alert(1)">';
  ui.applyNoteScanResult(snapshot([tagged('1', [hostileTag])]));
  const group = groupNodes(ui)[0];
  const title = selectNodes(group, (node) => hasClass(node, 'note-group-title'))[0];
  assert.equal(title.textContent, hostileTag);
  assert.equal(title.children.length, 0);
  assert.doesNotMatch(JSON.stringify(noteRows(ui)), /<img src=x/u);
});

test('标签组标题可折叠，取消扫描保留分组和折叠状态', () => {
  const { ui } = fixture();
  const workNote = tagged('1', ['工作']);
  const workOnly = tagged('2', ['工作']);
  ui.applyNoteScanResult(snapshot([workNote, workOnly]));
  ui.toggleNoteGroupCollapse('工作');
  assert.ok(ui.state.collapsedNoteGroups.has('工作'));
  assert.equal(groupBody(ui, 0).hidden, true);

  for (const result of [{ ...snapshot([]), cancelled: true }, { ...snapshot([]), complete: false }]) {
    ui.applyNoteScanResult(result);
    assert.equal(ui.state.notes.length, 2);
    assert.equal(groupNodes(ui).length, 1);
    assert.equal(groupBody(ui, 0).hidden, true);
  }

  ui.toggleNoteGroupCollapse('工作');
  assert.equal(groupBody(ui, 0).hidden, false);
});

test('账号切换清空分组、勾选与折叠状态', () => {
  const { ui } = fixture();
  ui.applyNoteScanResult(snapshot([tagged('1', ['工作']), note('2')]));
  ui.toggleNoteGroupCollapse('未分类');
  ui.setNoteGroupSelection('工作', true);
  assert.equal(ui.state.selectedNoteKeys.size, 1);
  const generation = ui.state.noteGeneration;

  ui.resetNotesForAccount();
  assert.equal(ui.state.notes.length, 0);
  assert.equal(ui.state.selectedNoteKeys.size, 0);
  assert.equal(ui.state.collapsedNoteGroups.size, 0);
  assert.equal(ui.state.noteAccountScope, '');
  assert.ok(ui.state.noteGeneration > generation);
  assert.equal(groupNodes(ui).length, 0);
});
