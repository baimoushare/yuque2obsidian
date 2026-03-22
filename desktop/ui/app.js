const state = {
  settings: null,
  books: [],
  selectedBooks: new Set(),
  expandedNodes: new Set(),
  currentJobId: null,
  currentOutputDir: '',
  currentJobStatus: 'idle',
  currentJobKind: '',
  pollTimer: null,
  loginUser: null,
  lastExportConfig: null,
  lastSelectedBookId: null,
  systemLogs: [],
  lastStatusMessage: '',
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  browserPath: $('#browser-path'),
  cookiePath: $('#cookie-path'),
  outputDir: $('#output-dir'),
  encryptedPasswords: $('#encrypted-passwords'),
  togglePasswordsBtn: $('#toggle-passwords-btn'),
  downloadImages: $('#download-images'),
  downloadAttachments: $('#download-attachments'),
  incrementalExport: $('#incremental-export'),
  booksList: $('#books-list'),
  bookCount: $('#book-count'),
  progressBar: $('#progress-bar'),
  progressText: $('#progress-text'),
  bookProgressBar: $('#book-progress-bar'),
  bookProgressText: $('#book-progress-text'),
  logs: $('#logs'),
  loginBtn: $('#login-btn'),
  scanBtn: $('#scan-btn'),
  exportBtn: $('#export-btn'),
  stopBtn: $('#stop-btn'),
  saveSettingsBtn: $('#save-settings-btn'),
  chooseOutputBtn: $('#choose-output-btn'),
  openOutputBtn: $('#open-output-btn'),
  expandAllBtn: $('#expand-all-btn'),
  collapseAllBtn: $('#collapse-all-btn'),
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
  if (window.pywebview?.api) {
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
      if (window.pywebview?.api) {
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
  if (!state.loginUser) {
    renderStatus('桌面端已就绪');
  }
}

function wireEvents() {
  elements.saveSettingsBtn.addEventListener('click', saveSettings);
  elements.chooseOutputBtn.addEventListener('click', chooseOutputDir);
  elements.loginBtn.addEventListener('click', startLogin);
  elements.scanBtn.addEventListener('click', scanBooks);
  elements.exportBtn.addEventListener('click', onExportButtonClick);
  elements.stopBtn.addEventListener('click', stopExport);
  elements.expandAllBtn.addEventListener('click', expandAllTrees);
  elements.collapseAllBtn.addEventListener('click', collapseAllTrees);
  elements.togglePasswordsBtn.addEventListener('click', togglePasswordVisibility);
  elements.openOutputBtn.addEventListener('click', () => {
    const outputDir = elements.outputDir.value.trim();
    if (outputDir) {
      window.pywebview.api.openOutputDir(outputDir);
    }
  });
}

function fillSettings(settings) {
  elements.browserPath.value = settings.browserPath || '';
  elements.cookiePath.value = settings.cookiePath || '';
  elements.outputDir.value = settings.outputDir || '';
  elements.encryptedPasswords.value = normalizePasswordList(settings.encryptedBlockPasswords, settings.encryptedBlockPassword);
  elements.downloadImages.checked = settings.downloadImages !== false;
  elements.downloadAttachments.checked = settings.downloadAttachments !== false;
  elements.incrementalExport.checked = settings.incrementalExport !== false;
  state.currentOutputDir = settings.outputDir || '';
}

function readSettings() {
  const encryptedBlockPasswords = parsePasswordList(elements.encryptedPasswords.value);
  return {
    browserPath: elements.browserPath.value.trim(),
    cookiePath: elements.cookiePath.value.trim(),
    outputDir: elements.outputDir.value.trim(),
    encryptedBlockPasswords,
    encryptedBlockPassword: encryptedBlockPasswords[0] || '',
    downloadImages: elements.downloadImages.checked,
    downloadAttachments: elements.downloadAttachments.checked,
    incrementalExport: elements.incrementalExport.checked,
    complexBlockMode: 'snapshot-first',
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
  const selected = await window.pywebview.api.chooseOutputDir();
  if (selected) {
    elements.outputDir.value = selected;
    state.currentOutputDir = selected;
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
    return;
  }

  elements.accountText.textContent = '未检测到登录状态';
  elements.accountBadge.classList.remove('logged-in');
  elements.loginBtn.textContent = '登录语雀';
}

function togglePasswordVisibility() {
  const masked = elements.encryptedPasswords.classList.toggle('masked-textarea');
  elements.togglePasswordsBtn.classList.toggle('active', !masked);
  elements.togglePasswordsBtn.title = masked ? '显示或隐藏密码' : '隐藏密码';
  elements.togglePasswordsBtn.setAttribute('aria-label', masked ? '显示密码' : '隐藏密码');
}

async function startLogin() {
  await saveSettings();
  const { jobId } = await window.pywebview.api.startLogin(readSettings());
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
    state.expandedNodes = collectDefaultExpandedNodes(books);
    renderBooks();
    renderStatus(`已自动扫描 ${books.length} 个知识库`);
  } catch (error) {
    renderStatus(`自动扫描知识库失败: ${error.message}`);
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

async function startExport() {
  const selectedBooks = collectSelectedBooksFromUi();
  state.selectedBooks = new Set(selectedBooks);

  if (selectedBooks.length === 0) {
    renderStatus('请先选择至少一个知识库。');
    return;
  }

  await saveSettings();
  const config = {
    ...readSettings(),
    selectedBooks,
  };

  state.lastExportConfig = config;
  const { jobId } = await window.pywebview.api.startExport(config);
  state.currentJobId = jobId;
  state.currentJobKind = 'export';
  state.currentJobStatus = 'running';
  state.currentOutputDir = config.outputDir;
  syncControls();
  renderStatus(
    config.incrementalExport
      ? `增量导出任务已启动，将按当前选择的 ${config.selectedBooks.length} 个知识库继续执行。`
      : `全量导出任务已启动，将导出当前选择的 ${config.selectedBooks.length} 个知识库。`,
  );
  renderLogs([`导出任务已启动，将处理 ${config.selectedBooks.length} 个知识库。`]);
  setProgress(0, '准备导出...');
  setBookProgress(0, '等待知识库任务...');
  pollJob(jobId);
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
        rootName: book.name,
        docCount: book.documentCount || 0,
        path: [],
        isBookRoot: true,
      }),
    );
  }

  elements.booksList.appendChild(tree);
}

function renderTreeNode(node, meta) {
  const nodeId = makeNodeId(meta.bookId, meta.path, node.name);
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
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
    checkbox.checked = state.selectedBooks.has(meta.bookId);
    checkbox.addEventListener('click', (event) => handleBookSelectionInteraction(meta.bookId, event, 'checkbox'));
    checkboxWrap.appendChild(checkbox);
    row.appendChild(checkboxWrap);
  } else {
    const spacer = document.createElement('div');
    spacer.className = 'tree-spacer';
    row.appendChild(spacer);
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
  }

  if (hasChildren && !meta.isBookRoot) {
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
    }
    orderedBookIds.forEach((id) => syncBookCheckboxes(id, state.selectedBooks.has(id)));
  } else if (event.ctrlKey || event.metaKey) {
    toggleBookSelection(bookId, !currentSelected);
  } else if (source === 'label') {
    state.selectedBooks = new Set([bookId]);
    orderedBookIds.forEach((id) => syncBookCheckboxes(id, state.selectedBooks.has(id)));
  } else {
    toggleBookSelection(bookId, !currentSelected);
  }

  state.lastSelectedBookId = bookId;
}

function syncBookCheckboxes(bookId, checked) {
  document.querySelectorAll(`input[type="checkbox"][data-book-id="${cssEscape(bookId)}"]`).forEach((input) => {
    input.checked = checked;
  });
}

function toggleNode(nodeId) {
  if (state.expandedNodes.has(nodeId)) {
    state.expandedNodes.delete(nodeId);
  } else {
    state.expandedNodes.add(nodeId);
  }
  renderBooks();
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
      if (job.kind === 'login') {
        await refreshLoginStatus();
        renderStatus('登录完成');
      } else {
        renderStatus('任务完成');
      }
      const result = job.result || {};
      if (result.failureCsv) {
        renderLogs([...(job.logs || []), `失败 CSV: ${result.failureCsv}`]);
      }
      if (job.kind === 'export') {
        setProgress(100, '任务完成');
      }
    } else if (job.status === 'paused') {
      clearPollTimer();
      state.currentJobKind = 'export';
      renderStatus('导出已暂停，可随时继续。');
    } else if (job.status === 'error' || job.status === 'cancelled') {
      clearPollTimer();
      renderStatus(job.error || (job.status === 'cancelled' ? '任务已停止' : '任务失败'));
    }
  }, 900);
}

function syncProgress(job) {
  const latestProgress = [...(job.events || [])].reverse().find((event) => event.percent != null || event.bookPercent != null);
  if (!latestProgress) {
    return;
  }

  const currentBook = latestProgress.book || '';
  const currentDoc = latestProgress.doc || '';
  const overallText = currentBook
    ? `当前知识库：${currentBook}`
    : latestProgress.message || '处理中...';
  const overallValue = latestProgress.percent ?? 0;
  setProgress(overallValue, overallText);

  const bookCompleted = latestProgress.bookCompleted ?? 0;
  const bookTotal = latestProgress.bookTotal ?? 0;
  const bookText = currentDoc
    ? `当前笔记：${currentDoc}`
    : currentBook
      ? `${currentBook} ${bookCompleted}/${bookTotal || 0}`
      : latestProgress.message || '暂无任务';
  setBookProgress(latestProgress.bookPercent ?? 0, bookText);
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

function setProgress(value, text) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  elements.progressText.textContent = text;
}

function setBookProgress(value, text) {
  elements.bookProgressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  elements.bookProgressText.textContent = text;
}

function syncControls() {
  const exportRunning =
    state.currentJobKind === 'export' && ['running', 'pausing', 'stopping'].includes(state.currentJobStatus);
  const exportPaused = state.currentJobKind === 'export' && state.currentJobStatus === 'paused';
  const anyJobRunning = ['running', 'pausing', 'stopping'].includes(state.currentJobStatus);

  elements.loginBtn.disabled = anyJobRunning;
  elements.scanBtn.disabled = anyJobRunning;
  elements.stopBtn.disabled = !exportRunning || state.currentJobStatus === 'stopping';

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
    (input) => input.dataset.bookId,
  ).filter(Boolean);

  return selected.length > 0 ? selected : [...state.selectedBooks];
}

function setupTransientShellScrollbar() {
  let timer = null;

  const showScrollbar = () => {
    document.documentElement.classList.add('show-shell-scrollbar');
    document.body.classList.add('show-shell-scrollbar');
    clearTimeout(timer);
    timer = setTimeout(() => {
      document.documentElement.classList.remove('show-shell-scrollbar');
      document.body.classList.remove('show-shell-scrollbar');
    }, 900);
  };

  window.addEventListener('wheel', showScrollbar, { passive: true });
  window.addEventListener('scroll', showScrollbar, { passive: true });
}
