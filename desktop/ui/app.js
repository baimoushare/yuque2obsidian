const state = {
  settings: null,
  books: [],
  selectedBooks: new Set(),
  selectedDocuments: new Set(),
  expandedNodes: new Set(),
  currentJobId: null,
  currentOutputDir: '',
  currentJobStatus: 'idle',
  currentJobKind: '',
  pollTimer: null,
  loginUser: null,
  loginWasAlreadyAuthenticated: false,
  lastExportConfig: null,
  currentExportSource: '',
  lastSelectedBookId: null,
  systemLogs: [],
  lastStatusMessage: '',
  lastSelectionSummary: { totalBooks: 0, totalDocuments: 0 },
  hasAutoScrolledToLogs: false,
  lastProgressSnapshot: {
    completedBooks: 0,
    totalBooks: 0,
    completedDocuments: 0,
    totalDocuments: 0,
    bookCompleted: 0,
    bookTotal: 0,
    currentBook: '',
    currentDoc: '',
  },
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  configCard: $('.config-card'),
  browserPath: $('#browser-path'),
  cookiePath: $('#cookie-path'),
  outputDir: $('#output-dir'),
  failureCsvPath: $('#failure-csv-path'),
  obsidianVaultPath: $('#obsidian-vault-path'),
  obsidianSetupMode: $('#obsidian-setup-mode'),
  diagramExportMode: $('#diagram-export-mode'),
  vaultExportLayout: $('#vault-export-layout'),
  vaultExportSubdir: $('#vault-export-subdir'),
  encryptedPasswords: $('#encrypted-passwords'),
  togglePasswordsBtn: $('#toggle-passwords-btn'),
  reencryptEncryptedBlocksMode: $('#reencrypt-encrypted-blocks-mode'),
  reencryptGlobalPasswordField: $('#reencrypt-global-password-field'),
  reencryptGlobalPassword: $('#reencrypt-global-password'),
  toggleReencryptPasswordBtn: $('#toggle-reencrypt-password-btn'),
  downloadImages: $('#download-images'),
  downloadAttachments: $('#download-attachments'),
  incrementalExport: $('#incremental-export'),
  booksList: $('#books-list'),
  bookCount: $('#book-count'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  progressStats: $('#progress-stats'),
  bookProgressBar: $('#book-progress-bar'),
  bookProgressText: $('#book-progress-text'),
  bookProgressStats: $('#book-progress-stats'),
  logsCard: $('.logs-card'),
  logs: $('#logs'),
  loginBtn: $('#login-btn'),
  scanBtn: $('#scan-btn'),
  exportBtn: $('#export-btn'),
  stopBtn: $('#stop-btn'),
  saveSettingsBtn: $('#save-settings-btn'),
  chooseOutputBtn: $('#choose-output-btn'),
  chooseFailureCsvBtn: $('#choose-failure-csv-btn'),
  retryFailuresBtn: $('#retry-failures-btn'),
  chooseVaultBtn: $('#choose-vault-btn'),
  openOutputBtn: $('#open-output-btn'),
  treeFoldToggleBtn: $('#tree-fold-toggle-btn'),
  treeFoldExpandIcon: $('#tree-fold-icon-expand'),
  treeFoldCollapseIcon: $('#tree-fold-icon-collapse'),
  accountBadge: $('#account-badge'),
  accountText: $('#account-text'),
};

bootstrap();

async function bootstrap() {
  try {
    await waitForPywebview();
    await init();
  } catch (error) {
    renderStatus(`初始化失败: ${error.message}`);
    renderLogs([`初始化失败: ${error.stack || error.message}`]);
  }
}

function waitForPywebview(timeoutMs = 15000) {
  if (isPywebviewReady()) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const cleanup = () => {
      window.removeEventListener('pywebviewready', onReady);
      clearInterval(interval);
    };

    const onReady = () => {
      cleanup();
      resolve();
    };

    const interval = setInterval(() => {
      if (isPywebviewReady()) {
        cleanup();
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        cleanup();
        reject(new Error('未能连接到 pywebview 桥接对象。'));
      }
    }, 200);

    window.addEventListener('pywebviewready', onReady, { once: true });
  });
}

function isPywebviewReady() {
  return typeof window.pywebview?.api?.loadSettings === 'function';
}

async function init() {
  const settings = await window.pywebview.api.loadSettings();
  state.settings = settings;
  fillSettings(settings);
  wireEvents();
  setupTransientShellScrollbar();
  await refreshLoginStatus();
  if (state.loginUser) {
    await autoScanBooksOnLaunch();
  }
  syncControls();
  syncTreeFoldToggleButton();
  if (!state.loginUser) {
    renderStatus('桌面端已就绪');
  }
}

function wireEvents() {
  elements.saveSettingsBtn.addEventListener('click', saveSettings);
  elements.chooseOutputBtn.addEventListener('click', chooseOutputDir);
  elements.chooseFailureCsvBtn.addEventListener('click', chooseFailureCsv);
  elements.retryFailuresBtn.addEventListener('click', onRetryFailuresButtonClick);
  elements.chooseVaultBtn.addEventListener('click', chooseVaultDir);
  elements.loginBtn.addEventListener('click', startLogin);
  elements.scanBtn.addEventListener('click', scanBooks);
  elements.exportBtn.addEventListener('click', onExportButtonClick);
  elements.stopBtn.addEventListener('click', stopExport);
  elements.treeFoldToggleBtn.addEventListener('click', toggleTreeFoldState);
  elements.togglePasswordsBtn.addEventListener('click', togglePasswordVisibility);
  elements.encryptedPasswords.addEventListener('input', syncEncryptedPasswordsHeight);
  elements.toggleReencryptPasswordBtn.addEventListener('click', toggleReencryptPasswordVisibility);
  elements.reencryptEncryptedBlocksMode.addEventListener('change', syncReencryptControls);
  elements.vaultExportLayout.addEventListener('change', syncVaultExportControls);
  elements.openOutputBtn.addEventListener('click', () => {
    const outputDir = state.currentOutputDir || elements.outputDir.value.trim();
    if (outputDir) {
      window.pywebview.api.openOutputDir(outputDir);
    }
  });
}

function fillSettings(settings) {
  elements.browserPath.value = settings.browserPath || '';
  elements.cookiePath.value = settings.cookiePath || '';
  elements.outputDir.value = settings.outputDir || '';
  elements.failureCsvPath.value = settings.failureCsvPath || '';
  elements.obsidianVaultPath.value = settings.obsidianVaultPath || '';
  elements.obsidianSetupMode.value = settings.obsidianSetupMode || 'none';
  elements.diagramExportMode.value = settings.diagramExportMode || 'auto';
  elements.vaultExportLayout.value = settings.vaultExportLayout || 'output-only';
  elements.vaultExportSubdir.value = settings.vaultExportSubdir || '';
  elements.encryptedPasswords.value = normalizePasswordList(settings.encryptedBlockPasswords, settings.encryptedBlockPassword);
  elements.reencryptEncryptedBlocksMode.value = settings.reencryptEncryptedBlocksMode || 'off';
  elements.reencryptGlobalPassword.value = settings.reencryptGlobalPassword || '';
  elements.downloadImages.checked = settings.downloadImages !== false;
  elements.downloadAttachments.checked = settings.downloadAttachments !== false;
  elements.incrementalExport.checked = settings.incrementalExport !== false;
  state.currentOutputDir = settings.outputDir || '';
  syncEncryptedPasswordsHeight();
  syncReencryptControls();
  syncVaultExportControls();
}

function readSettings() {
  const encryptedBlockPasswords = parsePasswordList(elements.encryptedPasswords.value);
  return {
    browserPath: elements.browserPath.value.trim(),
    cookiePath: elements.cookiePath.value.trim(),
    outputDir: elements.outputDir.value.trim(),
    failureCsvPath: elements.failureCsvPath.value.trim(),
    obsidianVaultPath: elements.obsidianVaultPath.value.trim(),
    obsidianSetupMode: elements.obsidianSetupMode.value,
    diagramExportMode: elements.diagramExportMode.value,
    vaultExportLayout: elements.vaultExportLayout.value,
    vaultExportSubdir: elements.vaultExportSubdir.value.trim(),
    encryptedBlockPasswords,
    encryptedBlockPassword: encryptedBlockPasswords[0] || '',
    reencryptEncryptedBlocksMode: elements.reencryptEncryptedBlocksMode.value,
    reencryptGlobalPassword: elements.reencryptGlobalPassword.value,
    downloadImages: elements.downloadImages.checked,
    downloadAttachments: elements.downloadAttachments.checked,
    incrementalExport: elements.incrementalExport.checked,
    datatableExportMode: 'structured-first',
    complexBlockMode: 'auto',
    diagramSnapshotMode: 'fallback-only',
    assetLayout: 'book_assets',
  };
}

async function saveSettings() {
  const settings = await window.pywebview.api.saveSettings(readSettings());
  state.settings = settings;
  fillSettings(settings);
  renderStatus('配置已保存');
  return settings;
}

async function chooseOutputDir() {
  const selected = await window.pywebview.api.chooseOutputDir(elements.outputDir.value.trim());
  if (selected) {
    elements.outputDir.value = selected;
    state.currentOutputDir = selected;
  }
}

async function chooseFailureCsv() {
  const selected = await window.pywebview.api.chooseFailureCsv(elements.failureCsvPath.value.trim());
  if (selected) {
    elements.failureCsvPath.value = selected;
  }
}

async function chooseVaultDir() {
  const selected = await window.pywebview.api.chooseVaultDir(elements.obsidianVaultPath.value.trim());
  if (selected) {
    elements.obsidianVaultPath.value = selected;
  }
}

async function refreshLoginStatus() {
  try {
    const payload = await window.pywebview.api.getLoginStatus(readSettings());
    state.loginUser = payload?.loggedIn ? payload.user || null : null;
  } catch {
    state.loginUser = null;
  }
  renderAccount();
}

function renderAccount() {
  if (state.loginUser?.login || state.loginUser?.name) {
    const name = state.loginUser.name || state.loginUser.login;
    const login = state.loginUser.login ? ` @${state.loginUser.login}` : '';
    elements.accountText.textContent = `已登录: ${name}${login}`;
    elements.accountBadge.classList.add('logged-in');
    elements.loginBtn.textContent = '切换账号';
    elements.loginBtn.classList.remove('primary');
    elements.loginBtn.classList.add('secondary', 'login-switch-btn');
    return;
  }

  elements.accountText.textContent = '未检测到登录状态';
  elements.accountBadge.classList.remove('logged-in');
  elements.loginBtn.textContent = '登录语雀';
  elements.loginBtn.classList.add('primary');
  elements.loginBtn.classList.remove('secondary', 'login-switch-btn');
}

function togglePasswordVisibility() {
  const masked = elements.encryptedPasswords.classList.toggle('masked-textarea');
  elements.togglePasswordsBtn.classList.toggle('active', !masked);
  elements.togglePasswordsBtn.title = masked ? '显示或隐藏密码' : '隐藏密码';
  elements.togglePasswordsBtn.setAttribute('aria-label', masked ? '显示密码' : '隐藏密码');
}

function syncEncryptedPasswordsHeight() {
  const textarea = elements.encryptedPasswords;
  if (!textarea) {
    return;
  }

  const styles = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(styles.lineHeight) || 24;
  const paddingTop = parseFloat(styles.paddingTop) || 0;
  const paddingBottom = parseFloat(styles.paddingBottom) || 0;
  const borderTop = parseFloat(styles.borderTopWidth) || 0;
  const borderBottom = parseFloat(styles.borderBottomWidth) || 0;
  const verticalChrome = paddingTop + paddingBottom + borderTop + borderBottom;
  const minHeight = lineHeight * 3 + verticalChrome;
  const maxHeight = lineHeight * 6 + verticalChrome;

  textarea.style.height = 'auto';
  const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function toggleReencryptPasswordVisibility() {
  const visible = elements.reencryptGlobalPassword.type === 'text';
  elements.reencryptGlobalPassword.type = visible ? 'password' : 'text';
  elements.toggleReencryptPasswordBtn.classList.toggle('active', !visible);
  elements.toggleReencryptPasswordBtn.title = visible ? '显示或隐藏重加密密码' : '隐藏重加密密码';
  elements.toggleReencryptPasswordBtn.setAttribute('aria-label', visible ? '显示重加密密码' : '隐藏重加密密码');
}

function syncReencryptControls() {
  const mode = elements.reencryptEncryptedBlocksMode.value || 'off';
  const enableGlobalPassword = mode === 'global';
  if (elements.reencryptGlobalPasswordField) {
    elements.reencryptGlobalPasswordField.hidden = false;
    elements.reencryptGlobalPasswordField.classList.toggle('is-disabled', !enableGlobalPassword);
  }
  elements.reencryptGlobalPassword.disabled = !enableGlobalPassword;
  elements.toggleReencryptPasswordBtn.disabled = !enableGlobalPassword;
  if (!enableGlobalPassword) {
    elements.reencryptGlobalPassword.type = 'password';
    elements.toggleReencryptPasswordBtn.classList.remove('active');
    elements.toggleReencryptPasswordBtn.title = '显示或隐藏重加密密码';
    elements.toggleReencryptPasswordBtn.setAttribute('aria-label', '显示重加密密码');
  }
}

function syncVaultExportControls() {
  const outputOnly = (elements.vaultExportLayout.value || 'output-only') === 'output-only';
  const mainField = elements.obsidianVaultPath.closest('.path-pair-main');
  const subField = elements.vaultExportSubdir.closest('.path-pair-sub');

  elements.obsidianVaultPath.disabled = outputOnly;
  elements.chooseVaultBtn.disabled = outputOnly;
  elements.vaultExportSubdir.disabled = outputOnly;

  if (mainField) {
    mainField.classList.toggle('is-disabled', outputOnly);
  }
  if (subField) {
    subField.classList.toggle('is-disabled', outputOnly);
  }
}

async function startLogin() {
  await saveSettings();
  state.loginWasAlreadyAuthenticated = Boolean(state.loginUser);
  // 如果当前已登录，说明用户点击的是“切换账号”，需要强制重新认证。
  // 这里额外检查按钮样式/文案，避免状态刷新滞后时按钮已显示“切换账号”，
  // 但 state.loginUser 还没同步，导致后端误走“复用旧会话”的快速返回分支。
  const isReauth =
    Boolean(state.loginUser) ||
    elements.loginBtn.classList.contains('login-switch-btn') ||
    elements.loginBtn.textContent.includes('切换账号');
  const config = readSettings();
  if (isReauth) {
    config.forceReauth = true;
  }
  const { jobId } = await window.pywebview.api.startLogin(config);
  state.currentJobId = jobId;
  state.currentJobKind = 'login';
  state.currentJobStatus = 'running';
  syncControls();
  renderStatus('登录浏览器已打开，请在弹出的浏览器中完成语雀登录。');
  pollJob(jobId);
}

async function scanBooks() {
  await saveSettings();
  renderStatus('正在扫描知识库...');
  const books = await window.pywebview.api.scanBooks(readSettings());
  state.books = books;
  state.selectedBooks = new Set(books.map((book) => String(book.id)));
  state.selectedDocuments = new Set();
  state.expandedNodes = collectDefaultExpandedNodes(books);
  renderBooks();
  await refreshLoginStatus();
  renderStatus(`已扫描 ${books.length} 个知识库`);
}

async function autoScanBooksOnLaunch() {
  try {
    renderStatus('已检测到登录账号，正在自动扫描知识库...');
    const books = await window.pywebview.api.scanBooks(readSettings());
    state.books = books;
    state.selectedBooks = new Set(books.map((book) => String(book.id)));
    state.selectedDocuments = new Set();
    state.expandedNodes = collectDefaultExpandedNodes(books);
    renderBooks();
    renderStatus(`已自动扫描 ${books.length} 个知识库`);
  } catch (error) {
    renderStatus(`自动扫描知识库失败: ${error.message}`);
  }
}

async function autoScanBooksAfterFirstLogin() {
  try {
    renderStatus('登录完成，正在自动扫描知识库...');
    const books = await window.pywebview.api.scanBooks(readSettings());
    state.books = books;
    state.selectedBooks = new Set(books.map((book) => String(book.id)));
    state.selectedDocuments = new Set();
    state.expandedNodes = collectDefaultExpandedNodes(books);
    renderBooks();
    renderStatus(`首次登录成功，已自动扫描 ${books.length} 个知识库`);
  } catch (error) {
    renderStatus(`登录完成，但自动扫描知识库失败: ${error.message}`);
  }
}

async function onExportButtonClick() {
  if (state.currentJobKind === 'export' && state.currentJobStatus === 'running') {
    await pauseExport();
    return;
  }

  if (state.currentJobKind === 'export' && state.currentJobStatus === 'pausing') {
    return;
  }

  await startExport();
}

async function onRetryFailuresButtonClick() {
  const retryRunning = state.currentExportSource === 'retry' && state.currentJobKind === 'export' && state.currentJobStatus === 'running';
  const retryPausing =
    state.currentExportSource === 'retry' && state.currentJobKind === 'export' && ['pausing', 'stopping'].includes(state.currentJobStatus);
  const retryPaused = state.currentExportSource === 'retry' && state.currentJobKind === 'export' && state.currentJobStatus === 'paused';

  if (retryRunning) {
    await pauseExport();
    return;
  }

  if (retryPausing) {
    return;
  }

  if (retryPaused) {
    await startRetryExportFromFailureCsv();
    return;
  }

  await startRetryExportFromFailureCsv();
}

async function startExport() {
  const selection = collectExportSelectionFromUi();
  state.selectedBooks = new Set(selection.fullySelectedBooks);
  state.selectedDocuments = new Set(selection.selectedDocuments);

  if (selection.selectedBooks.length === 0 && selection.selectedDocuments.length === 0) {
    renderStatus('请先选择至少一个知识库。');
    return;
  }

  await saveSettings();
  const config = {
    ...readSettings(),
    selectedBooks: selection.selectedBooks,
    fullySelectedBooks: selection.fullySelectedBooks,
    selectedDocuments: selection.selectedDocuments,
  };

  state.lastExportConfig = config;
  state.lastSelectionSummary = summarizeSelection(config);
  state.lastProgressSnapshot = {
    completedBooks: 0,
    totalBooks: state.lastSelectionSummary.totalBooks,
    completedDocuments: 0,
    totalDocuments: state.lastSelectionSummary.totalDocuments,
    bookCompleted: 0,
    bookTotal: 0,
    currentBook: '',
    currentDoc: '',
  };
  const { jobId } = await window.pywebview.api.startExport(config);
  state.currentJobId = jobId;
  state.currentJobKind = 'export';
  state.currentJobStatus = 'running';
  state.currentExportSource = 'standard';
  state.currentOutputDir = config.outputDir;
  syncControls();
  renderStatus(
    config.incrementalExport
      ? `增量导出任务已启动，将按当前选择的 ${config.selectedBooks.length} 个知识库继续执行。`
      : `全量导出任务已启动，将导出当前选择的 ${config.selectedBooks.length} 个知识库。`,
  );
  renderLogs([`导出任务已启动，将处理 ${config.selectedBooks.length} 个知识库。`]);
  const selectionSummary = state.lastSelectionSummary;
  setProgress(0, '准备导出...', `0% · 知识库 0/${selectionSummary.totalBooks} · 文档 0/${selectionSummary.totalDocuments}`);
  setBookProgress(0, '等待知识库任务...', '0% · 文档 0/0');
  maybeScrollTaskLogsIntoView();
  pollJob(jobId);
}

async function startRetryExportFromFailureCsv() {
  const failureCsvPath = elements.failureCsvPath.value.trim();
  if (!failureCsvPath) {
    renderStatus('请先选择失败日志 CSV。');
    return;
  }

  await saveSettings();
  const retryConfig = {
    ...readSettings(),
    failureCsvPath,
  };
  const result = await window.pywebview.api.startRetryExportFromFailureCsv(retryConfig);

  state.currentJobId = result.jobId;
  state.currentJobKind = 'export';
  state.currentJobStatus = 'running';
  state.currentExportSource = 'retry';
  state.currentOutputDir = result.outputDir || retryConfig.outputDir;
  state.lastExportConfig = {
    ...retryConfig,
    outputDir: state.currentOutputDir,
    selectedBooks: result.selectedBooks || [],
    fullySelectedBooks: [],
    selectedDocuments: result.selectedDocuments || [],
    incrementalExport: false,
  };
  state.lastSelectionSummary = {
    totalBooks: result.bookCount || 0,
    totalDocuments: result.documentCount || 0,
  };
  state.lastProgressSnapshot = {
    completedBooks: 0,
    totalBooks: state.lastSelectionSummary.totalBooks,
    completedDocuments: 0,
    totalDocuments: state.lastSelectionSummary.totalDocuments,
    bookCompleted: 0,
    bookTotal: 0,
    currentBook: '',
    currentDoc: '',
  };

  if (state.currentOutputDir) {
    elements.outputDir.value = state.currentOutputDir;
  }

  syncControls();

  const unmatchedCount = Array.isArray(result.unmatchedDocuments) ? result.unmatchedDocuments.length : 0;
  renderStatus(`失败文档重导任务已启动，将覆盖重导 ${result.documentCount || 0} 篇文档。`);
  renderLogs([
    `已从失败日志读取 ${result.rowCount || 0} 条记录，去重后匹配到 ${result.documentCount || 0} 篇文档。`,
    `本次已自动关闭增量导出，并使用失败日志所在目录作为输出目录：${state.currentOutputDir}`,
    unmatchedCount > 0 ? `有 ${unmatchedCount} 篇文档当前未在可访问知识库中找到，已暂时跳过。` : '失败日志中的可匹配文档都已加入本次重导任务。',
  ]);
  setProgress(
    0,
    '准备重新导出...',
    `0% · 知识库 0/${state.lastSelectionSummary.totalBooks} · 文档 0/${state.lastSelectionSummary.totalDocuments}`,
  );
  setBookProgress(0, '等待知识库任务...', '0% · 文档 0/0');
  maybeScrollTaskLogsIntoView();
  pollJob(result.jobId);
}

async function pauseExport() {
  if (!state.currentJobId) {
    return;
  }
  await window.pywebview.api.pauseExport(state.currentJobId);
  state.currentJobStatus = 'pausing';
  syncControls();
  renderStatus('已请求暂停，当前文档处理完成后会自动暂停。暂停后可重新调整知识库选择，再继续导出。');
}

async function stopExport() {
  if (!state.currentJobId) {
    return;
  }
  await window.pywebview.api.cancelExport(state.currentJobId);
  state.currentJobStatus = 'stopping';
  syncControls();
  renderStatus('已请求停止，当前进度会先保存。');
}

function renderBooks() {
  if (state.books.length === 0) {
    elements.booksList.className = 'books-list empty-state';
    elements.booksList.textContent = '没有可导出的知识库。';
    elements.bookCount.textContent = '0 个知识库 / 0 篇文档';
    syncTreeFoldToggleButton();
    syncControls();
    return;
  }

  const totalDocs = state.books.reduce((sum, book) => sum + (book.documentCount || 0), 0);
  elements.booksList.className = 'books-list';
  elements.bookCount.textContent = `${state.books.length} 个知识库 / ${totalDocs} 篇文档`;
  elements.booksList.innerHTML = '';

  const tree = document.createElement('div');
  tree.className = 'book-tree';

  for (const book of state.books) {
    tree.appendChild(
      renderTreeNode(book.root, {
        bookId: String(book.id),
        bookSlug: book.slug,
        bookUserUrl: book.userUrl,
        rootName: book.name,
        docCount: book.documentCount || 0,
        path: [],
        isBookRoot: true,
      }),
    );
  }

  elements.booksList.appendChild(tree);
  syncTreeFoldToggleButton();
  syncControls();
}

function renderTreeNode(node, meta) {
  const nodeId = makeNodeId(meta.bookId, meta.path, node.name);
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const docUrl = getAbsoluteDocUrl(node, meta);
  const isDocument = Boolean(docUrl);
  const descendantDocUrls = collectDocumentUrls(node, meta, []);
  const selectionState = getNodeSelectionState(meta.bookId, descendantDocUrls, meta.isBookRoot);
  const wrapper = document.createElement('div');
  wrapper.className = `tree-node${meta.isBookRoot ? ' book-root' : ''}${hasChildren && !state.expandedNodes.has(nodeId) ? ' collapsed' : ''}`;
  wrapper.dataset.nodeId = nodeId;

  const row = document.createElement('div');
  row.className = 'tree-row';

  const toggle = document.createElement(hasChildren ? 'button' : 'div');
  toggle.className = hasChildren ? 'tree-toggle' : 'tree-spacer';
  toggle.textContent = hasChildren ? (state.expandedNodes.has(nodeId) ? '▾' : '▸') : '';
  if (hasChildren) {
    toggle.type = 'button';
    toggle.addEventListener('click', () => toggleNode(nodeId));
  }
  row.appendChild(toggle);

  if (meta.isBookRoot) {
    const checkboxWrap = document.createElement('label');
    checkboxWrap.className = 'tree-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.bookId = meta.bookId;
    checkbox.checked = selectionState.checked;
    checkbox.indeterminate = selectionState.indeterminate;
    checkbox.addEventListener('click', (event) => handleBookSelectionInteraction(meta.bookId, event, 'checkbox'));
    checkboxWrap.appendChild(checkbox);
    row.appendChild(checkboxWrap);
  } else {
    const checkboxWrap = document.createElement('label');
    checkboxWrap.className = 'tree-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.bookId = meta.bookId;
    if (docUrl) {
      checkbox.dataset.docUrl = docUrl;
    }
    checkbox.checked = selectionState.checked;
    checkbox.indeterminate = selectionState.indeterminate;
    checkbox.disabled = descendantDocUrls.length === 0;
    checkbox.addEventListener('click', (event) =>
      handleNodeSelectionInteraction(meta.bookId, descendantDocUrls, event, 'checkbox'),
    );
    checkboxWrap.appendChild(checkbox);
    row.appendChild(checkboxWrap);
  }

  const label = document.createElement('button');
  label.type = 'button';
  label.className = `tree-label${meta.isBookRoot ? ' book-root-label' : ''}`;
  const title = document.createElement('strong');
  title.textContent = node.name;

  if (meta.isBookRoot) {
    label.appendChild(title);
    const count = document.createElement('span');
    count.className = 'book-doc-count';
    count.textContent = `${meta.docCount} 篇`;
    label.appendChild(count);
    label.addEventListener('click', (event) => handleBookSelectionInteraction(meta.bookId, event, 'label'));
  } else {
    label.appendChild(title);
    const subtitle = document.createElement('span');
    subtitle.textContent = describeNode(node);
    label.appendChild(subtitle);
    if (isDocument) {
      label.addEventListener('click', (event) => handleNodeSelectionInteraction(meta.bookId, descendantDocUrls, event, 'label'));
    }
  }

  if (hasChildren && !meta.isBookRoot && !isDocument) {
    label.addEventListener('click', () => toggleNode(nodeId));
  }
  row.appendChild(label);
  wrapper.appendChild(row);

  if (hasChildren) {
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'tree-children';
    node.children.forEach((child, index) => {
      childrenWrap.appendChild(
        renderTreeNode(child, {
          ...meta,
          isBookRoot: false,
          path: [...meta.path, `${index}`],
        }),
      );
    });
    wrapper.appendChild(childrenWrap);
  }

  return wrapper;
}

function describeNode(node) {
  switch (node.type) {
    case 'BOOK':
      return '知识库';
    case 'TITLE':
      return '目录';
    case 'TITLE+DOC':
      return '目录文档';
    case 'DOC':
      return '文档';
    default:
      return node.type || '节点';
  }
}

function toggleBookSelection(bookId, checked) {
  if (checked) {
    state.selectedBooks.add(bookId);
    clearDocumentSelectionsForBook(bookId);
  } else {
    state.selectedBooks.delete(bookId);
  }
  syncBookCheckboxes(bookId, checked);
}

function handleBookSelectionInteraction(bookId, event, source) {
  event.preventDefault();
  if (source === 'checkbox') {
    event.stopPropagation();
  }

  const orderedBookIds = state.books.map((book) => String(book.id));
  const currentSelected = state.selectedBooks.has(bookId);

  if (event.shiftKey && state.lastSelectedBookId && orderedBookIds.includes(state.lastSelectedBookId)) {
    const start = orderedBookIds.indexOf(state.lastSelectedBookId);
    const end = orderedBookIds.indexOf(bookId);
    const [from, to] = start <= end ? [start, end] : [end, start];
    state.selectedBooks = new Set();
    for (let index = from; index <= to; index += 1) {
      state.selectedBooks.add(orderedBookIds[index]);
      clearDocumentSelectionsForBook(orderedBookIds[index]);
    }
    orderedBookIds.forEach((id) => syncBookCheckboxes(id, state.selectedBooks.has(id)));
  } else if (event.ctrlKey || event.metaKey) {
    toggleBookSelection(bookId, !currentSelected);
  } else if (source === 'label') {
    state.selectedBooks = new Set([bookId]);
    clearDocumentSelectionsForBook(bookId);
    orderedBookIds.forEach((id) => syncBookCheckboxes(id, state.selectedBooks.has(id)));
  } else {
    toggleBookSelection(bookId, !currentSelected);
  }

  state.lastSelectedBookId = bookId;
  renderBooks();
}

function syncBookCheckboxes(bookId, checked) {
  document.querySelectorAll(`input[type="checkbox"][data-book-id="${cssEscape(bookId)}"]`).forEach((input) => {
    if (!input.dataset.docUrl) {
      input.checked = checked;
    }
  });
}

function handleNodeSelectionInteraction(bookId, descendantDocUrls, event, source) {
  event.preventDefault();
  if (source === 'checkbox') {
    event.stopPropagation();
  }

  if (descendantDocUrls.length === 0) {
    return;
  }

  if (state.selectedBooks.has(bookId)) {
    state.selectedBooks.delete(bookId);
    syncBookCheckboxes(bookId, false);
    clearDocumentSelectionsForBook(bookId);
  }

  const fullySelected = descendantDocUrls.every((docUrl) => state.selectedDocuments.has(docUrl));
  if (fullySelected) {
    descendantDocUrls.forEach((docUrl) => state.selectedDocuments.delete(docUrl));
  } else {
    descendantDocUrls.forEach((docUrl) => state.selectedDocuments.add(docUrl));
  }
  renderBooks();
}

function syncDocumentCheckboxes(docUrl, checked) {
  document.querySelectorAll(`input[type="checkbox"][data-doc-url="${cssEscape(docUrl)}"]`).forEach((input) => {
    input.checked = checked;
  });
}

function clearDocumentSelectionsForBook(bookId) {
  const urls = collectDocumentUrlsForBook(bookId);
  urls.forEach((docUrl) => state.selectedDocuments.delete(docUrl));
  urls.forEach((docUrl) => syncDocumentCheckboxes(docUrl, false));
}

function toggleNode(nodeId) {
  if (state.expandedNodes.has(nodeId)) {
    state.expandedNodes.delete(nodeId);
  } else {
    state.expandedNodes.add(nodeId);
  }
  renderBooks();
}

function toggleTreeFoldState() {
  if (isTreeFullyExpanded()) {
    collapseAllTrees();
    return;
  }
  expandAllTrees();
}

function expandAllTrees() {
  const all = new Set();
  state.books.forEach((book) => collectAllNodeIds(book.root, String(book.id), [], all));
  state.expandedNodes = all;
  renderBooks();
}

function collapseAllTrees() {
  state.expandedNodes = new Set();
  renderBooks();
}

function collectDefaultExpandedNodes(books) {
  return new Set();
}

function isTreeFullyExpanded() {
  const allNodeIds = collectAllTreeNodeIds();
  if (allNodeIds.size === 0) {
    return false;
  }
  for (const nodeId of allNodeIds) {
    if (!state.expandedNodes.has(nodeId)) {
      return false;
    }
  }
  return true;
}

function collectAllTreeNodeIds() {
  const all = new Set();
  state.books.forEach((book) => collectAllNodeIds(book.root, String(book.id), [], all));
  return all;
}

function syncTreeFoldToggleButton() {
  const hasBooks = state.books.length > 0;
  elements.treeFoldToggleBtn.disabled = !hasBooks;

  const isExpanded = hasBooks && isTreeFullyExpanded();
  elements.treeFoldToggleBtn.dataset.mode = isExpanded ? 'expanded' : 'collapsed';
  elements.treeFoldToggleBtn.title = isExpanded ? '当前已展开，点击全部折叠' : '当前已折叠，点击全部展开';
  elements.treeFoldToggleBtn.setAttribute(
    'aria-label',
    isExpanded ? '当前已展开，点击全部折叠' : '当前已折叠，点击全部展开',
  );

  elements.treeFoldExpandIcon.hidden = !isExpanded;
  elements.treeFoldCollapseIcon.hidden = isExpanded;
}

function collectAllNodeIds(node, bookId, path, output) {
  const nodeId = makeNodeId(bookId, path, node.name);
  output.add(nodeId);
  (node.children || []).forEach((child, index) => {
    collectAllNodeIds(child, bookId, [...path, `${index}`], output);
  });
}

function makeNodeId(bookId, path, name) {
  return `${bookId}::${path.join('.')}::${name}`;
}

function isDocumentNode(node) {
  return node?.type === 'DOC' || node?.type === 'TITLE+DOC';
}

function getAbsoluteDocUrl(node, meta) {
  if (!isDocumentNode(node) || !node?.url || !meta.bookUserUrl || !meta.bookSlug) {
    return '';
  }
  return `https://www.yuque.com/${meta.bookUserUrl}/${meta.bookSlug}/${node.url}`.replace(/\/$/, '');
}

function collectDocumentUrlsForBook(bookId) {
  const book = state.books.find((item) => String(item.id) === String(bookId));
  if (!book?.root) {
    return [];
  }
  return collectDocumentUrls(book.root, {
    bookUserUrl: book.userUrl,
    bookSlug: book.slug,
  });
}

function collectDocumentUrls(node, meta, output = []) {
  const docUrl = getAbsoluteDocUrl(node, meta);
  if (docUrl) {
    output.push(docUrl);
  }
  (node.children || []).forEach((child) => collectDocumentUrls(child, meta, output));
  return output;
}

function getNodeSelectionState(bookId, descendantDocUrls, isBookRoot = false) {
  if (isBookRoot) {
    return {
      checked: state.selectedBooks.has(bookId),
      indeterminate: false,
    };
  }

  if (state.selectedBooks.has(bookId)) {
    return {
      checked: true,
      indeterminate: false,
    };
  }

  if (descendantDocUrls.length === 0) {
    return {
      checked: false,
      indeterminate: false,
    };
  }

  const selectedCount = descendantDocUrls.filter((docUrl) => state.selectedDocuments.has(docUrl)).length;
  if (selectedCount === 0) {
    return {
      checked: false,
      indeterminate: false,
    };
  }

  if (selectedCount === descendantDocUrls.length) {
    return {
      checked: true,
      indeterminate: false,
    };
  }

  return {
    checked: false,
    indeterminate: true,
  };
}

function pollJob(jobId) {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }

  state.pollTimer = setInterval(async () => {
    let job;
    try {
      job = await window.pywebview.api.getJobStatus(jobId);
    } catch (error) {
      clearPollTimer();
      renderStatus(`获取任务状态失败: ${error.message}`);
      renderLogs([`获取任务状态失败: ${error.stack || error.message}`]);
      state.currentJobStatus = 'error';
      syncControls();
      return;
    }

    state.currentJobKind = job.kind || state.currentJobKind;
    state.currentJobStatus = job.status || state.currentJobStatus;
    renderLogs(job.logs || []);
    syncProgress(job);
    syncControls();

    if (job.status === 'success') {
      clearPollTimer();
      finalizeJobState(job);
      if (job.kind === 'login') {
        await refreshLoginStatus();
        const shouldAutoScanAfterFirstLogin = !state.loginWasAlreadyAuthenticated && Boolean(state.loginUser);
        state.loginWasAlreadyAuthenticated = Boolean(state.loginUser);
        if (shouldAutoScanAfterFirstLogin) {
          await autoScanBooksAfterFirstLogin();
        } else {
          renderStatus('登录完成');
        }
      } else {
        renderStatus('导出完成');
      }
      const result = job.result || {};
      state.currentOutputDir = result.contentOutputDir || result.outputDir || state.currentOutputDir;
      if (result.failureCsv) {
        renderLogs([...(job.logs || []), `失败 CSV: ${result.failureCsv}`]);
      }
      if (job.kind === 'export') {
        applyCompletedExportProgress(result);
      }
    } else if (job.status === 'paused') {
      clearPollTimer();
      finalizeJobState(job);
      state.currentJobKind = 'export';
      renderStatus('导出已暂停，可随时继续。');
    } else if (job.status === 'error' || job.status === 'cancelled') {
      clearPollTimer();
      finalizeJobState(job);
      if (job.kind === 'login' && job.status === 'cancelled') {
        // 切换账号过程中用户关闭登录浏览器，视为主动取消：
        // 刷新账号状态并恢复按钮可点击，不把界面停留在“登录中”。
        await refreshLoginStatus();
        state.loginWasAlreadyAuthenticated = Boolean(state.loginUser);
        renderStatus(job.result?.message || '已取消切换账号，可继续使用当前账号。');
      } else {
        renderStatus(job.error || job.result?.message || (job.status === 'cancelled' ? '任务已停止' : '任务失败'));
      }
    }
  }, 900);
}

function finalizeJobState(job) {
  state.currentJobId = null;
  state.currentJobStatus = job?.status || 'idle';
  state.currentJobKind = job?.status === 'paused' ? 'export' : '';
  state.currentExportSource = job?.status === 'paused' ? state.currentExportSource : '';
  syncControls();
}

function syncProgress(job) {
  const latestProgress = [...(job.events || [])].reverse().find((event) => event.percent != null || event.bookPercent != null);
  if (!latestProgress) {
    return;
  }

  const currentBook = latestProgress.book || '';
  const currentDoc = latestProgress.doc || '';
  const selectionSummary =
    state.lastSelectionSummary.totalBooks > 0 || state.lastSelectionSummary.totalDocuments > 0
      ? state.lastSelectionSummary
      : summarizeSelection(state.lastExportConfig);
  const overallPercent = latestProgress.percent ?? 0;
  const completedBooks = latestProgress.completedBooks ?? state.lastProgressSnapshot.completedBooks ?? 0;
  const totalBooks = latestProgress.totalBooks ?? state.lastProgressSnapshot.totalBooks ?? selectionSummary.totalBooks;
  const completedDocuments = latestProgress.completedDocuments ?? state.lastProgressSnapshot.completedDocuments ?? 0;
  const totalDocuments =
    latestProgress.totalDocuments ?? state.lastProgressSnapshot.totalDocuments ?? selectionSummary.totalDocuments;
  const overallText = currentBook
    ? `当前知识库：${currentBook}`
    : localizeProgressMessage(latestProgress.message || '处理中...');
  const overallStats = `${formatPercent(overallPercent)} · 知识库 ${completedBooks}/${totalBooks || 0} · 文档 ${completedDocuments}/${totalDocuments || 0}`;
  setProgress(overallPercent, overallText, overallStats);

  const bookCompleted = latestProgress.bookCompleted ?? state.lastProgressSnapshot.bookCompleted ?? 0;
  const bookTotal = latestProgress.bookTotal ?? state.lastProgressSnapshot.bookTotal ?? 0;
  const bookPercent = latestProgress.bookPercent ?? 0;
  const bookText = currentDoc
    ? `当前笔记：${currentDoc}`
    : currentBook
      ? `${currentBook} ${bookCompleted}/${bookTotal || 0}`
      : localizeProgressMessage(latestProgress.message || '暂无任务');
  const bookStats = `${formatPercent(bookPercent)} · 文档 ${bookCompleted}/${bookTotal || 0}`;
  setBookProgress(bookPercent, bookText, bookStats);

  state.lastProgressSnapshot = {
    completedBooks,
    totalBooks,
    completedDocuments,
    totalDocuments,
    bookCompleted,
    bookTotal,
    currentBook,
    currentDoc,
  };
}

function maybeScrollTaskLogsIntoView() {
  if (state.hasAutoScrolledToLogs || !elements.logsCard) {
    return;
  }

  state.hasAutoScrolledToLogs = true;
  requestAnimationFrame(() => {
    elements.logsCard.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  });
}

function renderStatus(message) {
  if (!message || message === state.lastStatusMessage) {
    return;
  }
  state.lastStatusMessage = message;
  state.systemLogs.push(message);
  if (state.systemLogs.length > 120) {
    state.systemLogs = state.systemLogs.slice(-120);
  }
  renderLogs([]);
}

function renderLogs(lines) {
  const merged = [...state.systemLogs, ...lines];
  elements.logs.textContent = merged.length > 0 ? merged.join('\n') : '等待任务输出...';
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

function setProgress(value, text, statsText = '') {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  elements.progressText.textContent = text;
  if (elements.progressStats) {
    elements.progressStats.textContent = statsText || `${formatPercent(value)} · 知识库 0/0 · 文档 0/0`;
  }
}

function setBookProgress(value, text, statsText = '') {
  elements.bookProgressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  elements.bookProgressText.textContent = text;
  if (elements.bookProgressStats) {
    elements.bookProgressStats.textContent = statsText || `${formatPercent(value)} · 文档 0/0`;
  }
}

function applyCompletedExportProgress(result = {}) {
  const totals = result.totals || {};
  const totalBooks = Number(totals.books ?? state.lastProgressSnapshot.totalBooks ?? state.lastSelectionSummary.totalBooks ?? 0);
  const totalDocuments = Number(
    totals.documents ?? state.lastProgressSnapshot.totalDocuments ?? state.lastSelectionSummary.totalDocuments ?? 0,
  );

  state.lastProgressSnapshot = {
    completedBooks: totalBooks,
    totalBooks,
    completedDocuments: totalDocuments,
    totalDocuments,
    bookCompleted: totalDocuments,
    bookTotal: totalDocuments,
    currentBook: '',
    currentDoc: '',
  };

  setProgress(100, '任务完成', `100% · 知识库 ${totalBooks}/${totalBooks} · 文档 ${totalDocuments}/${totalDocuments}`);
  setBookProgress(100, '全部内容已完成', `100% · 文档 ${totalDocuments}/${totalDocuments}`);
}

function localizeProgressMessage(message) {
  const value = String(message || '').trim();
  if (!value) {
    return '';
  }

  const replacements = [
    ['Finalizing Obsidian setup...', '正在完成 Obsidian 配置...'],
    ['Obsidian setup finished', 'Obsidian 配置已完成'],
    ['Obsidian setup was skipped', '已跳过 Obsidian 配置'],
    ['Loading Yuque book list...', '正在加载语雀知识库列表...'],
  ];

  let localized = value;
  for (const [source, target] of replacements) {
    localized = localized.replace(source, target);
  }
  return localized;
}

function setButtonTone(button, tone) {
  button.classList.remove('primary', 'secondary', 'ghost');
  button.classList.add(tone);
}

function syncRetryFailuresButton(exportRunning, exportPaused) {
  const retryRunning = state.currentExportSource === 'retry' && exportRunning;
  const retryPaused = state.currentExportSource === 'retry' && exportPaused;
  const retryBusy =
    state.currentExportSource === 'retry' && state.currentJobKind === 'export' && ['pausing', 'stopping'].includes(state.currentJobStatus);
  const iconPath = retryRunning
    ? 'M6 5h4v14H6zM14 5h4v14h-4z'
    : 'M8 5.5v13l10-6.5-10-6.5Z';
  const title = retryRunning
    ? '暂停按失败日志重导并覆盖'
    : retryPaused
      ? '继续按失败日志重导并覆盖'
      : retryBusy
        ? state.currentJobStatus === 'stopping'
          ? '停止中...'
          : '暂停中...'
        : '开始按失败日志重导并覆盖';

  elements.retryFailuresBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPath}"></path></svg>`;
  elements.retryFailuresBtn.title = title;
  elements.retryFailuresBtn.setAttribute('aria-label', title);
}

function syncControls() {
  const exportRunning =
    state.currentJobKind === 'export' && ['running', 'pausing', 'stopping'].includes(state.currentJobStatus);
  const exportPaused = state.currentJobKind === 'export' && state.currentJobStatus === 'paused';
  const anyJobRunning = ['running', 'pausing', 'stopping'].includes(state.currentJobStatus);
  const exportBusy = exportRunning || exportPaused;
  const retryRunning = state.currentExportSource === 'retry' && state.currentJobKind === 'export' && state.currentJobStatus === 'running';
  const retryPaused = state.currentExportSource === 'retry' && exportPaused;
  const retryBusy =
    state.currentExportSource === 'retry' && state.currentJobKind === 'export' && ['pausing', 'stopping'].includes(state.currentJobStatus);
  const hasBooks = state.books.length > 0;

  elements.loginBtn.disabled = anyJobRunning;
  elements.scanBtn.disabled = anyJobRunning;
  elements.chooseFailureCsvBtn.disabled = anyJobRunning;
  elements.retryFailuresBtn.disabled = retryBusy || (!retryRunning && !retryPaused && exportBusy);
  elements.stopBtn.disabled = !exportRunning || state.currentJobStatus === 'stopping';

  setButtonTone(elements.exportBtn, hasBooks ? 'primary' : 'secondary');
  syncRetryFailuresButton(exportRunning, exportPaused);

  if (exportRunning) {
    if (state.currentJobStatus === 'pausing') {
      elements.exportBtn.textContent = '暂停中...';
      elements.exportBtn.disabled = true;
    } else if (state.currentJobStatus === 'stopping') {
      elements.exportBtn.textContent = '停止中...';
      elements.exportBtn.disabled = true;
    } else {
      elements.exportBtn.textContent = '暂停导出';
      elements.exportBtn.disabled = false;
    }
  } else if (exportPaused) {
    elements.exportBtn.textContent = '继续导出';
    elements.exportBtn.disabled = false;
  } else {
    elements.exportBtn.textContent = '开始导出';
    elements.exportBtn.disabled = anyJobRunning;
  }
}

function clearPollTimer() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  syncControls();
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return String(value).replace(/"/g, '\\"');
}

function parsePasswordList(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePasswordList(passwords, fallbackPassword) {
  if (Array.isArray(passwords) && passwords.length > 0) {
    return passwords.join('\n');
  }
  return fallbackPassword ? String(fallbackPassword) : '';
}

function collectSelectedBooksFromUi() {
  const selected = Array.from(
    document.querySelectorAll('input[type="checkbox"][data-book-id]:checked'),
    (input) => (input.dataset.docUrl ? '' : input.dataset.bookId),
  ).filter(Boolean);

  return selected.length > 0 ? selected : [...state.selectedBooks];
}

function collectSelectedDocumentsFromUi() {
  const selected = Array.from(
    document.querySelectorAll('input[type="checkbox"][data-doc-url]:checked'),
    (input) => input.dataset.docUrl,
  ).filter(Boolean);

  return selected.length > 0 ? selected : [...state.selectedDocuments];
}

function collectExportSelectionFromUi() {
  const fullySelectedBooks = collectSelectedBooksFromUi();
  const selectedDocuments = collectSelectedDocumentsFromUi();
  const docParentBooks = Array.from(
    new Set(
      Array.from(
        document.querySelectorAll('input[type="checkbox"][data-doc-url]:checked'),
        (input) => input.dataset.bookId,
      ).filter(Boolean),
    ),
  );

  return {
    selectedBooks: Array.from(new Set([...fullySelectedBooks, ...docParentBooks])),
    fullySelectedBooks,
    selectedDocuments,
  };
}

function summarizeSelection(config) {
  if (!config) {
    return { totalBooks: 0, totalDocuments: 0 };
  }

  const fullySelectedBooks = new Set((config.fullySelectedBooks || []).map(String));
  const selectedDocuments = new Set(config.selectedDocuments || []);
  const selectedBookIds = new Set((config.selectedBooks || []).map(String));
  const allDocumentUrls = new Set();

  for (const book of state.books) {
    const bookId = String(book.id);
    if (!selectedBookIds.has(bookId) && !fullySelectedBooks.has(bookId)) {
      continue;
    }

    if (fullySelectedBooks.has(bookId)) {
      collectDocumentUrlsForBook(bookId).forEach((docUrl) => allDocumentUrls.add(docUrl));
    }
  }

  selectedDocuments.forEach((docUrl) => allDocumentUrls.add(docUrl));

  return {
    totalBooks: selectedBookIds.size,
    totalDocuments: allDocumentUrls.size,
  };
}

function formatPercent(value) {
  return `${Math.max(0, Math.min(100, Math.round(value || 0)))}%`;
}

/* function describeSelection(selection) {
  const parts = [];
  if (selection.fullySelectedBooks.length > 0) {
    parts.push(`鐏忓棗顕遍崙?${selection.fullySelectedBooks.length} 娑擃亝鏆ｆ稉顏嗙叀鐠囧棗绨盽);
  }
  if (selection.selectedDocuments.length > 0) {
    parts.push(`鐏忓棗顕遍崙?${selection.selectedDocuments.length} 缁″洦瀵氱€规碍鏋冨?`);
  }
  return parts.join('閿?);
}

} */

function describeSelection(selection) {
  const parts = [];
  if (selection.fullySelectedBooks.length > 0) {
    parts.push(`将导出 ${selection.fullySelectedBooks.length} 个整库知识库`);
  }
  if (selection.selectedDocuments.length > 0) {
    parts.push(`将导出 ${selection.selectedDocuments.length} 篇指定文档`);
  }
  return parts.join('，');
}

function setupTransientShellScrollbar() {
  document.documentElement.classList.add('show-shell-scrollbar');
  document.body.classList.add('show-shell-scrollbar');
}
