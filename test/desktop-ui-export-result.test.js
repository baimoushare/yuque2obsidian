import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// 执行实际轮询收尾代码，但不启动桌面、不请求语雀、不写入任何仓库。
const source = fs.readFileSync(new URL('../desktop/ui/app.js', import.meta.url), 'utf8');
const pollSource = source.slice(source.indexOf('function pollJob('), source.indexOf('function finalizeJobState('));
const html = fs.readFileSync(new URL('../desktop/ui/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../desktop/ui/styles.css', import.meta.url), 'utf8');

test('桌面分类在同一列表中展示，扫描入口只保留知识库按钮', () => {
  assert.match(html, /id="knowledge-category-title"[^>]*>知识库</u);
  assert.match(html, /id="favorite-category-title"[^>]*>收藏</u);
  assert.match(html, /id="collaboration-category-title"[^>]*>协作</u);
  assert.doesNotMatch(html, /content-source-tabs|books-view-tab|favorites-view-tab|collaborations-view-tab/u);
  assert.match(html, /id="scan-btn"/u);
  assert.doesNotMatch(html, /id="scan-sources-btn"/u);
  assert.match(html, /id="books-list" class="books-list empty-state"><\/div>/u);
  assert.match(html, /id="favorite-document-rows"><\/div>/u);
  assert.match(html, /id="collaboration-document-rows"><\/div>/u);
});

test('未登录时清空三个分类的提示文案', () => {
  const helperSource = source.slice(
    source.indexOf('function syncUnauthenticatedEmptyStates('),
    source.indexOf('function renderAccount('),
  );
  const state = { loginUser: null, books: [], documentSourcesScanned: false };
  const elements = {
    booksList: { className: '', textContent: '先登录并扫描知识库。' },
    favoriteDocumentRows: { textContent: '扫描后加载' },
    collaborationDocumentRows: { textContent: '扫描后加载' },
  };
  vm.runInNewContext(`${helperSource}\nsyncUnauthenticatedEmptyStates();`, { state, elements });
  assert.equal(elements.booksList.textContent, '');
  assert.equal(elements.favoriteDocumentRows.textContent, '');
  assert.equal(elements.collaborationDocumentRows.textContent, '');
});

test('未登录时账号状态区域保持空白', () => {
  const renderAccountSource = source.slice(
    source.indexOf('function renderAccount('),
    source.indexOf('function togglePasswordVisibility('),
  );
  const elements = {
    accountText: { textContent: '未检测到登录状态' },
    accountBadge: { classList: { add() {}, remove() {} } },
    loginBtn: {
      textContent: '切换账号',
      classList: { add() {}, remove() {} },
    },
  };
  vm.runInNewContext(`${renderAccountSource}\nrenderAccount();`, {
    state: { loginUser: null },
    elements,
  });
  assert.equal(elements.accountText.textContent, '');
});

test('内容列表包含内部滚动区和三个独立折叠分类', () => {
  assert.match(html, /id="content-list-scroll" class="content-list-scroll"/u);
  for (const [category, contentId] of [
    ['knowledge', 'books-list'],
    ['favorite', 'favorite-document-rows'],
    ['collaboration', 'collaboration-document-rows'],
  ]) {
    assert.match(
      html,
      new RegExp(`data-category-toggle="${category}"[^>]*aria-expanded="true"[^>]*aria-controls="${contentId}"`, 'u'),
    );
    assert.match(html, new RegExp(`data-category-select="${category}"`, 'u'));
  }
  assert.match(styles, /\.content-list-scroll\s*\{[^}]*overflow-y:\s*auto/su);
  assert.match(styles, /scrollbar-gutter:\s*stable/u);
  assert.match(html, /class="select-chevron category-chevron"/u);
  assert.match(source, /tree-type-badge/u);
  assert.doesNotMatch(source, /可选择|可导出为表格/u);
  assert.doesNotMatch(html, /document-source-search|document-source-filter|document-source-scope-note/u);
  assert.doesNotMatch(source, /documentSourceSearch|documentSourceFilter|documentSourceScopeNote/u);
  assert.match(styles, /\.category-select\s*\{[^}]*flex-direction:\s*row[^}]*white-space:\s*nowrap/su);
  const sourceRows = source.slice(
    source.indexOf('function renderDocumentSources('),
    source.indexOf('function getEntrySourceTypes('),
  );
  assert.match(sourceRows, /tree-row source-document-row/u);
  assert.match(sourceRows, /tree-checkbox/u);
  assert.match(sourceRows, /tree-label source-document-title/u);
  assert.match(sourceRows, /tree-type-badge/u);
  assert.match(sourceRows, /entry\.documentType === 'Sheet' \? '数据表' : '文档'/u);
  assert.doesNotMatch(sourceRows, /source-document-meta|source-document-badge|entry\.owner|entry\.bookName|appendSourceBadge/u);
  assert.match(styles, /\.source-document-list\s*\{[^}]*gap:\s*4px/su);
  assert.match(styles, /\.source-document-row\s*\{[^}]*margin:\s*0/su);
  assert.match(styles, /\.source-document-title\s*\{[^}]*cursor:\s*pointer/su);
});

test('自动更新设置保留版本信息并移除说明性文案', () => {
  assert.match(html, /id="update-current-version"/u);
  assert.match(html, /id="update-last-checked"/u);
  assert.doesNotMatch(html, /自动更新不会中断正在进行的导出任务|启动后自动检查更新，发现新版后由你确认下载和安装/u);
  assert.doesNotMatch(source, /当前为开发模式：可以检查更新，但不能替换源码运行入口/u);
});

test('所有设置下拉项使用统一的主题菜单并保持原 select 值同步', () => {
  assert.equal((html.match(/<select\b/gu) || []).length, 4);
  assert.equal((html.match(/aria-label="(?:导出后重加密|导出目录|图形导出|数据表设置)"/gu) || []).length, 4);
  assert.match(source, /function initializeCustomSelects\(\)/u);
  assert.match(source, /select\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/u);
  assert.match(source, /aria-haspopup', 'listbox'/u);
  assert.match(source, /case 'ArrowDown'|event\.key === 'ArrowDown'/u);
  assert.match(source, /window\.innerWidth - menuWidth - viewportPadding/u);
  assert.match(styles, /\.app-select-menu\s*\{[^}]*position:\s*fixed/su);
  assert.match(styles, /\.app-select-option\[aria-selected="true"\]/u);
  assert.match(styles, /\.select-shell\.is-open\s*\{/u);
});

test('图形与数据表设置位于导出选项中，资源目录名可编辑且旧说明已移除', () => {
  const exportOptions = html.slice(html.indexOf('<h3>导出选项</h3>'), html.indexOf('<h3>加密策略</h3>'));
  const pathSettings = html.slice(html.indexOf('<h3>路径设置</h3>'), html.indexOf('</section>', html.indexOf('<h3>路径设置</h3>')));
  assert.match(exportOptions, /id="diagram-export-mode"/u);
  assert.match(exportOptions, /id="obsidian-setup-mode"/u);
  assert.match(exportOptions, /id="asset-directory-name"[^>]*value="_assets"/u);
  assert.doesNotMatch(pathSettings, /id="diagram-export-mode"|id="obsidian-setup-mode"/u);
  assert.doesNotMatch(html, /复杂块: 结构化优先|数据表: CSV \/ JSON \/ HTML \/ Bases/u);
  assert.match(source, /assetDirectoryName: elements\.assetDirectoryName\.value\.trim\(\) \|\| '_assets'/u);
});

test('资源目录路径将文档目录前缀固定显示，并允许编辑资源目录名', () => {
  assert.match(html, /class="asset-directory-prefix">&lt;文档所在目录&gt;\/<\/span>/u);
  assert.match(html, /id="asset-directory-name"[\s\S]*?value="_assets"[\s\S]*?aria-label="资源目录名"/u);
  assert.doesNotMatch(html, /每篇文档资源路径|<文档ID>/u);
  assert.match(source, /assetDirectoryName: elements\.assetDirectoryName\.value\.trim\(\) \|\| '_assets'/u);
  assert.match(styles, /\.asset-directory-input:focus-within\s*\{/u);
  assert.match(styles, /\.asset-directory-input input\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/su);
});

test('问号说明弹层脱离滚动卡片裁切，并在视口边缘自动定位', () => {
  assert.match(source, /function initializeHintTooltips\(\)/u);
  assert.match(source, /document\.body\.appendChild\(tooltip\)/u);
  assert.match(source, /window\.addEventListener\('scroll', positionTooltip, true\)/u);
  assert.match(source, /rect\.top >= tooltipHeight \+ gap \+ viewportPadding/u);
  assert.match(source, /activeTooltip\.dataset\.placement/u);
  assert.match(styles, /\.hint-tooltip-portal\s*\{[^}]*position:\s*fixed/su);
  assert.match(styles, /\.hint-tooltip-portal\.is-visible/u);
  assert.match(styles, /width:\s*min\(320px,\s*calc\(100vw - 24px\)\)/u);
  assert.match(styles, /z-index:\s*1000/u);
});

test('知识库根列表项与普通文档行保持一致，不再使用独立卡片样式', () => {
  assert.match(styles, /\.book-tree\s*\{[^}]*gap:\s*4px/su);
  assert.match(
    styles,
    /\.tree-node\.book-root\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/su,
  );
  assert.match(styles, /\.tree-row\s*\{[^}]*min-height:\s*30px/su);
  assert.match(styles, /\.source-document-row\s*\{[^}]*margin:\s*0/su);
});

test('导出配置与内容列表共用收紧后的卡片高度', () => {
  assert.match(styles, /--top-cards-height:\s*530px/u);
  assert.match(
    styles,
    /\.config-card,\s*\.books-card\s*\{[^}]*height:\s*var\(--top-cards-height\);[^}]*min-height:\s*var\(--top-cards-height\);[^}]*max-height:\s*var\(--top-cards-height\)/su,
  );
  assert.match(styles, /\.content-list-scroll\s*\{[^}]*overflow-y:\s*auto/su);
});

test('整体与当前知识库进度统计同行靠右显示，不再单独占行', () => {
  for (const [statsId, textId] of [
    ['progress-stats', 'progress-text'],
    ['book-progress-stats', 'book-progress-text'],
  ]) {
    const heading = html.match(
      new RegExp(`<div class="progress-heading">[\\s\\S]*?id="${textId}"[\\s\\S]*?id="${statsId}"[\\s\\S]*?<\\/div>`, 'u'),
    );
    assert.ok(heading, `${statsId} 应位于对应进度标题的同行区域`);
  }
  assert.match(styles, /\.progress-heading-meta\s*\{[^}]*min-width:\s*0;[^}]*margin-left:\s*auto/su);
  assert.match(styles, /\.progress-heading-status\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/su);
  assert.match(styles, /\.progress-stats\s*\{[^}]*white-space:\s*nowrap/su);
});

test('密码默认显示闭眼图标，显示密码时切换为睁眼图标', () => {
  for (const buttonId of ['toggle-passwords-btn', 'toggle-reencrypt-password-btn']) {
    const button = html.slice(html.indexOf(`id="${buttonId}"`));
    assert.match(button, /aria-pressed="false"/u);
    assert.match(button, /class="eye-visibility-icon"/u);
    assert.match(button, /class="eye-slash"/u);
  }
  assert.match(styles, /\.icon-btn\.active \.eye-slash\s*\{\s*display:\s*none/su);
  assert.match(source, /togglePasswordsBtn\.setAttribute\('aria-pressed', String\(!masked\)\)/u);
  assert.match(source, /toggleReencryptPasswordBtn\.setAttribute\('aria-pressed', String\(!visible\)\)/u);
  assert.match(source, /toggleReencryptPasswordBtn\.setAttribute\('aria-pressed', 'false'\)/u);
});

test('顶部导航栏收紧高度但保留按钮所需空间', () => {
  assert.match(styles, /\.hero\s*\{[^}]*min-height:\s*56px;[^}]*padding:\s*6px 14px;/su);
});

test('设置未提供值时，界面回退到截图标注的默认选项', () => {
  assert.match(source, /settings\.obsidianSetupMode \|\| 'bases\+community'/u);
  assert.match(source, /settings\.diagramExportMode \|\| 'auto'/u);
  assert.match(source, /settings\.vaultExportLayout \|\| 'direct-to-vault'/u);
  assert.match(source, /settings\.vaultExportSubdir \|\| '语雀导出'/u);
  assert.match(source, /settings\.reencryptEncryptedBlocksMode \|\| 'global'/u);
});

test('配置保存与路径选择使用带无障碍名称的图标按钮', () => {
  for (const [id, label] of [
    ['save-settings-btn', '保存配置'],
    ['choose-output-btn', '选择输出目录'],
    ['choose-failure-csv-btn', '选择失败日志 CSV'],
  ]) {
    const button = html.match(new RegExp(`<button\\s+id="${id}"[\\s\\S]*?<\\/button>`, 'u'))?.[0] || '';
    assert.match(button, /class="[^"]*icon-btn/u);
    assert.match(button, new RegExp(`aria-label="${label}"`, 'u'));
    assert.match(button, /<svg viewBox="0 0 24 24"/u);
    assert.doesNotMatch(button, />\\s*(?:保存配置|选择)\\s*</u);
  }
});

test('仅全局重加密模式显示全局密码设置', () => {
  const controlsSource = source.slice(
    source.indexOf('function syncReencryptControls('),
    source.indexOf('function syncVaultExportControls('),
  );
  const runForMode = (mode) => {
    const elements = {
      reencryptEncryptedBlocksMode: { value: mode },
      reencryptGlobalPasswordField: {
        hidden: false,
        classList: { toggle() {} },
      },
      reencryptGlobalPassword: { disabled: false, type: 'text' },
      toggleReencryptPasswordBtn: {
        disabled: false,
        classList: { remove() {} },
        setAttribute() {},
      },
    };
    vm.runInNewContext(`${controlsSource}\nsyncReencryptControls();`, { elements });
    return elements;
  };

  assert.equal(runForMode('off').reencryptGlobalPasswordField.hidden, true);
  assert.equal(runForMode('matched-block').reencryptGlobalPasswordField.hidden, true);
  const globalMode = runForMode('global');
  assert.equal(globalMode.reencryptGlobalPasswordField.hidden, false);
  assert.equal(globalMode.reencryptGlobalPassword.disabled, false);
});

test('只写输出目录时隐藏 Obsidian 仓库路径设置行', () => {
  const controlsSource = source.slice(
    source.indexOf('function syncVaultExportControls('),
    source.indexOf('function getExportButtonLabel('),
  );
  const runForLayout = (layout) => {
    const pathPairRow = { hidden: false };
    const mainField = {
      disabled: false,
      classList: { toggle() {} },
    };
    const subField = {
      disabled: false,
      classList: { toggle() {} },
    };
    const elements = {
      vaultExportLayout: { value: layout },
      obsidianVaultPath: { disabled: false, closest: () => mainField },
      chooseVaultBtn: { disabled: false },
      vaultExportSubdir: { disabled: false, closest: (selector) =>
        selector === '.path-pair-row' ? pathPairRow : subField },
    };
    vm.runInNewContext(`${controlsSource}\nsyncVaultExportControls();`, { elements });
    return { elements, pathPairRow };
  };

  const outputOnly = runForLayout('output-only');
  assert.equal(outputOnly.pathPairRow.hidden, true);
  assert.equal(outputOnly.elements.obsidianVaultPath.disabled, true);
  const directToVault = runForLayout('direct-to-vault');
  assert.equal(directToVault.pathPairRow.hidden, false);
  assert.equal(directToVault.elements.obsidianVaultPath.disabled, false);
});

test('导出按钮始终显示固定文案“开始导出”', () => {
  const labelSource = source.slice(
    source.indexOf('function getExportButtonLabel('),
    source.indexOf('function clearPollTimer('),
  );
  const getLabel = (overrides = {}) => {
    const state = {
      currentJobKind: '',
      currentJobStatus: 'idle',
      selectedDocumentKeys: new Set(),
      selectedBooks: new Set(),
      selectedDocuments: new Set(),
      ...overrides,
    };
    return vm.runInNewContext(`${labelSource}\ngetExportButtonLabel();`, { state });
  };

  assert.equal(getLabel(), '开始导出');
  assert.equal(getLabel({ selectedBooks: new Set(['book-1']) }), '开始导出');
  assert.equal(getLabel({ selectedDocuments: new Set(['doc-1']) }), '开始导出');
  assert.equal(getLabel({ selectedDocumentKeys: new Set(['source-1']) }), '开始导出');
  for (const status of ['running', 'paused', 'pausing', 'stopping']) {
    assert.equal(getLabel({ currentJobKind: 'export', currentJobStatus: status }), '开始导出');
  }
});

test('扫描与登录任务不展示导出进度，导出任务仍显示真实进度', () => {
  const progressFunctions = source.slice(
    source.indexOf('function syncProgress('),
    source.indexOf('function maybeScrollTaskLogsIntoView('),
  );
  const createContext = () => {
    const progressCalls = [];
    const elements = { progressMeta: { hidden: false } };
    const state = {
      currentExportSource: 'standard',
      lastSelectionSummary: { totalBooks: 1, totalDocuments: 2 },
      lastProgressSnapshot: {},
      lastExportConfig: null,
    };
    return {
      progressCalls,
      context: {
        elements,
        state,
        setProgress: (...args) => progressCalls.push(['overall', ...args]),
        setBookProgress: (...args) => progressCalls.push(['book', ...args]),
        formatPercent: (value) => `${value}%`,
        summarizeSelection: () => ({ totalBooks: 1, totalDocuments: 2 }),
        localizeProgressMessage: (message) => message,
      },
    };
  };

  for (const kind of ['source-scan', 'login']) {
    const { context, progressCalls } = createContext();
    vm.runInNewContext(
      `${progressFunctions}\nsyncProgress({ kind: '${kind}', events: [{ percent: 65, completedItems: 13, totalItems: 20 }] });`,
      context,
    );
    assert.equal(context.elements.progressMeta.hidden, true, `${kind} 应隐藏导出进度区`);
    assert.deepEqual(progressCalls, [], `${kind} 不应写入导出进度条`);
  }

  const { context, progressCalls } = createContext();
  vm.runInNewContext(
    `${progressFunctions}\nsyncProgress({ kind: 'export', events: [{ percent: 50, bookPercent: 25, book: '知识库 A', doc: '文档 B', completedBooks: 0, totalBooks: 1, completedDocuments: 1, totalDocuments: 2, bookCompleted: 1, bookTotal: 4 }] });`,
    context,
  );
  assert.equal(context.elements.progressMeta.hidden, false, '导出任务应显示进度区');
  assert.equal(progressCalls.length, 2, '导出任务应更新整体和当前知识库进度');
  assert.equal(progressCalls[0][1], 50);
  assert.equal(progressCalls[1][1], 25);
  assert.match(html, /id="progress-meta" class="progress-meta" hidden/u);
});

for (const functionName of ['autoScanBooksOnLaunch', 'autoScanBooksAfterLogin']) {
  test(`${functionName} 自动扫描知识库后会启动收藏和协作扫描`, async () => {
    const scanFunctions = source.slice(
      source.indexOf('async function autoScanBooksOnLaunch('),
      source.indexOf('async function requestBookScan('),
    );
    const events = [];
    const context = {
      renderStatus: () => {},
      requestBookScan: async () => {
        events.push('books');
        return { books: [] };
      },
      applyBookScanResult: () => events.push('apply-books'),
      scanDocumentSources: async () => events.push('sources'),
    };
    await vm.runInNewContext(
      `(async () => { ${scanFunctions}; await ${functionName}(); })()`,
      context,
    );
    assert.deepEqual(events, ['books', 'apply-books', 'sources']);
  });
}

test('来源分类勾选会选中该分类内所有可导出的文档与表格', () => {
  const selectionFunctions = source.slice(
    source.indexOf('function getEntrySourceTypes('),
    source.indexOf('function appendSourceBadge('),
  );
  const state = {
    books: [],
    documentSources: [
      { sourceType: 'favorite', documentType: 'Doc', documentKey: 'favorite-doc' },
      { sourceType: 'favorite', documentType: 'Sheet', documentKey: 'favorite-sheet' },
      { sourceType: 'favorite', documentType: 'Board', documentKey: 'unsupported' },
      { sourceType: 'collaboration', documentType: 'Doc', documentKey: 'collaboration-doc' },
      { sourceType: 'favorite', documentType: 'Doc', documentKey: '' },
    ],
    selectedBooks: new Set(['book-1']),
    selectedDocuments: new Set(['book-doc']),
    selectedDocumentKeys: new Set(),
  };
  const events = [];
  vm.runInNewContext(
    `${selectionFunctions}\ntoggleCategorySelection('favorite', true);`,
    {
      state,
      document: { querySelector: () => null },
      renderBooks: () => events.push('books'),
      renderDocumentSources: () => events.push('sources'),
    },
  );
  assert.deepEqual([...state.selectedDocumentKeys].sort(), ['favorite-doc', 'favorite-sheet']);
  assert.equal(state.selectedBooks.size, 0);
  assert.equal(state.selectedDocuments.size, 0);
  assert.deepEqual(events, ['books', 'sources']);
});

test('一级分类勾选框会显示全选与部分选择状态', () => {
  const selectionFunctions = source.slice(
    source.indexOf('function getEntrySourceTypes('),
    source.indexOf('function appendSourceBadge('),
  );
  const checkboxes = new Map(
    ['knowledge', 'favorite', 'collaboration'].map((categoryId) => [
      categoryId,
      { checked: false, indeterminate: false, disabled: false },
    ]),
  );
  const state = {
    books: [
      { id: 'book-1', root: { urls: ['book-1-doc'] } },
      { id: 'book-2', root: { urls: ['book-2-doc-a', 'book-2-doc-b'] } },
    ],
    documentSources: [
      { sourceType: 'favorite', documentType: 'Doc', documentKey: 'favorite-a' },
      { sourceType: 'favorite', documentType: 'Sheet', documentKey: 'favorite-b' },
      { sourceType: 'collaboration', documentType: 'Doc', documentKey: 'collab-a' },
    ],
    selectedBooks: new Set(['book-1']),
    selectedDocuments: new Set(['book-2-doc-a']),
    selectedDocumentKeys: new Set(['favorite-a', 'collab-a']),
  };
  vm.runInNewContext(`${selectionFunctions}\nsyncCategorySelectionControls();`, {
    state,
    document: {
      querySelector: (selector) => {
        const categoryId = selector.match(/data-category-select="([^"]+)"/u)?.[1];
        return checkboxes.get(categoryId) || null;
      },
    },
    collectDocumentUrls: (root) => root.urls,
  });
  assert.equal(checkboxes.get('knowledge').checked, false);
  assert.equal(checkboxes.get('knowledge').indeterminate, true);
  assert.equal(checkboxes.get('favorite').checked, false);
  assert.equal(checkboxes.get('favorite').indeterminate, true);
  assert.equal(checkboxes.get('collaboration').checked, true);
  assert.equal(checkboxes.get('collaboration').indeterminate, false);
});

test('单个分类可独立展开和折叠', () => {
  const toggleSource = source.slice(
    source.indexOf('function toggleCategory('),
    source.indexOf('function appendSourceBadge('),
  );
  const categories = Object.fromEntries(
    ['knowledge', 'favorite', 'collaboration'].map((categoryId) => {
      const toggle = {
        expanded: 'true',
        getAttribute: (name) => (
          name === 'aria-controls' ? `${categoryId}-content` : toggle.expanded
        ),
        setAttribute: (name, value) => {
          if (name === 'aria-expanded') toggle.expanded = value;
        },
      };
      return [categoryId, { toggle, content: { hidden: false } }];
    }),
  );
  const document = {
    querySelector: (selector) => {
      const categoryId = selector.match(/data-category-toggle="([^"]+)"/u)?.[1];
      return categories[categoryId]?.toggle || null;
    },
    getElementById: (contentId) => (
      Object.values(categories).find(({ toggle }) => toggle.getAttribute('aria-controls') === contentId)?.content
      || null
    ),
  };
  vm.runInNewContext(
    `${toggleSource}\ntoggleCategory('favorite');\ntoggleCategory('collaboration');`,
    { document },
  );
  assert.equal(categories.knowledge.toggle.expanded, 'true');
  assert.equal(categories.knowledge.content.hidden, false);
  assert.equal(categories.favorite.toggle.expanded, 'false');
  assert.equal(categories.favorite.content.hidden, true);
  assert.equal(categories.collaboration.toggle.expanded, 'false');
  assert.equal(categories.collaboration.content.hidden, true);
});

for (const recordCount of [0, 2, undefined]) {
  test(`桌面结果提示不把问题 CSV 文件路径冒充失败事件：记录数 ${recordCount}`, async () => {
    let poll;
    let finalLogs;
    const result = {
      status: 'success',
      outputDir: 'reports',
      contentOutputDir: 'content',
      failureCsv: 'reports/issues.csv',
      ...(recordCount === undefined ? {} : { failureRecordCount: recordCount }),
    };
    const state = { currentExportSource: 'document-sources' };
    const context = vm.createContext({
      state,
      window: { pywebview: { api: { getJobStatus: async () => ({
        kind: 'export', status: 'success', result, logs: ['导出完成'],
      }) } } },
      setInterval: (callback) => { poll = callback; return 1; },
      clearInterval: () => {},
      clearPollTimer: () => {},
      finalizeJobState: () => {},
      syncProgress: () => {},
      syncControls: () => {},
      renderStatus: () => {},
      applyCompletedExportProgress: () => {},
      renderLogs: (logs) => { finalLogs = logs; },
    });
    vm.runInContext(`${pollSource}\npollJob('test-job');`, context);
    await poll();
    assert.equal(state.currentOutputDir, 'content');
    assert.equal(finalLogs.join('\n').includes('失败 CSV:'), false);
    assert.match(finalLogs.join('\n'), recordCount === 0 ? /无错误或警告记录/ : /问题记录 CSV/);
  });
}
