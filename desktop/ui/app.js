const state = {
  settings: null,
  books: [],
  documentSources: [],
  documentSourcesScanned: false,
  documentSourcesExcludedCount: 0,
  selectedDocumentKeys: new Set(),
  selectedBooks: new Set(),
  selectedDocuments: new Set(),
  expandedNodes: new Set(),
  currentJobId: null,
  currentOutputDir: '',
  currentJobStatus: 'idle',
  currentJobKind: '',
  pollTimer: null,
  loginUser: null,
  lastExportConfig: null,
  currentExportSource: '',
  lastSelectedBookId: null,
  systemLogs: [],
  lastStatusMessage: '',
  lastSelectionSummary: { totalBooks: 0, totalDocuments: 0 },
  hasAutoScrolledToLogs: false,
  update: null,
  updatePollTimer: null,
  settingsTriggerBeforeOpen: null,
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
  assetDirectoryName: $('#asset-directory-name'),
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
  favoriteDocumentRows: $('#favorite-document-rows'),
  collaborationDocumentRows: $('#collaboration-document-rows'),
  bookCount: $('#book-count'),
  progressMeta: $('#progress-meta'),
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
  settingsTrigger: $('#settings-trigger'),
  settingsModal: $('#settings-modal'),
  settingsDialog: $('#settings-dialog'),
  settingsCloseBtn: $('#settings-close-btn'),
  autoCheckUpdates: $('#auto-check-updates'),
  updateCurrentVersion: $('#update-current-version'),
  updateLastChecked: $('#update-last-checked'),
  updateStatus: $('#update-status'),
  updateNotes: $('#update-notes'),
  updateProgressWrap: $('#update-progress-wrap'),
  updateProgressBar: $('#update-progress-bar'),
  updateProgressText: $('#update-progress-text'),
  checkUpdateBtn: $('#check-update-btn'),
  cancelUpdateDownloadBtn: $('#cancel-update-download-btn'),
  downloadUpdateBtn: $('#download-update-btn'),
  installUpdateBtn: $('#install-update-btn'),
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
  initializeHintTooltips();
  wireEvents();
  setupTransientShellScrollbar();
  await refreshLoginStatus();
  if (state.loginUser) {
    await autoScanBooksOnLaunch();
  }
  syncControls();
  syncTreeFoldToggleButton();
  await refreshUpdateState();
  scheduleAutoUpdateCheck();
  if (!state.loginUser) {
    renderStatus('桌面端已就绪');
  }
}

function wireEvents() {
  initializeCustomSelects();
  elements.saveSettingsBtn.addEventListener('click', saveSettings);
  elements.chooseOutputBtn.addEventListener('click', chooseOutputDir);
  elements.chooseFailureCsvBtn.addEventListener('click', chooseFailureCsv);
  elements.retryFailuresBtn.addEventListener('click', onRetryFailuresButtonClick);
  elements.chooseVaultBtn.addEventListener('click', chooseVaultDir);
  elements.loginBtn.addEventListener('click', startLogin);
  elements.scanBtn.addEventListener('click', scanBooks);
  elements.exportBtn.addEventListener('click', onExportButtonClick);
  document.querySelectorAll('[data-category-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', () => toggleCategory(toggle.dataset.categoryToggle));
  });
  document.querySelectorAll('[data-category-select]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      toggleCategorySelection(checkbox.dataset.categorySelect, checkbox.checked);
    });
  });
  elements.stopBtn.addEventListener('click', stopExport);
  elements.treeFoldToggleBtn.addEventListener('click', toggleTreeFoldState);
  elements.togglePasswordsBtn.addEventListener('click', togglePasswordVisibility);
  elements.encryptedPasswords.addEventListener('input', syncEncryptedPasswordsHeight);
  elements.toggleReencryptPasswordBtn.addEventListener('click', toggleReencryptPasswordVisibility);
  elements.reencryptEncryptedBlocksMode.addEventListener('change', syncReencryptControls);
  elements.vaultExportLayout.addEventListener('change', syncVaultExportControls);
  elements.settingsTrigger.addEventListener('click', openSettingsDialog);
  elements.settingsCloseBtn.addEventListener('click', closeSettingsDialog);
  elements.settingsModal.addEventListener('click', (event) => {
    if (event.target?.dataset?.settingsClose === 'true') closeSettingsDialog();
  });
  elements.autoCheckUpdates.addEventListener('change', saveAutoCheckUpdates);
  elements.checkUpdateBtn.addEventListener('click', () => checkForUpdates(true));
  elements.downloadUpdateBtn.addEventListener('click', startUpdateDownload);
  elements.cancelUpdateDownloadBtn.addEventListener('click', cancelUpdateDownload);
  elements.installUpdateBtn.addEventListener('click', installDownloadedUpdate);
  document.addEventListener('keydown', handleSettingsDialogKeydown);
  elements.openOutputBtn.addEventListener('click', () => {
    const outputDir = state.currentOutputDir || elements.outputDir.value.trim();
    if (outputDir) {
      window.pywebview.api.openOutputDir(outputDir);
    }
  });
}

function initializeHintTooltips() {
  const hints = [...document.querySelectorAll('.hint-badge')];
  let activeTooltip = null;
  let activeBadge = null;

  const positionTooltip = () => {
    if (!activeTooltip || !activeBadge) return;

    const rect = activeBadge.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 10;
    const tooltipWidth = activeTooltip.getBoundingClientRect().width;
    const tooltipHeight = activeTooltip.getBoundingClientRect().height;
    const left = Math.min(
      Math.max(viewportPadding, rect.left + rect.width / 2 - tooltipWidth / 2),
      Math.max(viewportPadding, window.innerWidth - tooltipWidth - viewportPadding),
    );
    const top = rect.top >= tooltipHeight + gap + viewportPadding
      ? rect.top - tooltipHeight - gap
      : rect.bottom + gap;

    activeTooltip.dataset.placement = top < rect.top ? 'top' : 'bottom';
    activeTooltip.style.left = `${left}px`;
    activeTooltip.style.top = `${Math.min(top, window.innerHeight - tooltipHeight - viewportPadding)}px`;
    activeTooltip.style.setProperty(
      '--tooltip-arrow-left',
      `${Math.min(Math.max(rect.left + rect.width / 2 - left, 12), tooltipWidth - 12)}px`,
    );
  };

  const hideTooltip = () => {
    activeTooltip?.classList.remove('is-visible');
    activeTooltip = null;
    activeBadge = null;
  };

  for (const badge of hints) {
    const tooltip = badge.querySelector('.hint-tooltip');
    if (!tooltip) continue;

    if (!tooltip.id) {
      tooltip.id = `${badge.getAttribute('aria-label') || 'field-hint'}-tooltip`
        .replace(/[^a-zA-Z0-9_-]/gu, '-');
    }
    badge.setAttribute('aria-describedby', tooltip.id);
    tooltip.classList.add('hint-tooltip-portal');
    document.body.appendChild(tooltip);

    const showTooltip = () => {
      if (activeTooltip && activeTooltip !== tooltip) {
        activeTooltip.classList.remove('is-visible');
      }
      activeTooltip = tooltip;
      activeBadge = badge;
      positionTooltip();
      tooltip.classList.add('is-visible');
    };

    badge.addEventListener('mouseenter', showTooltip);
    badge.addEventListener('focus', showTooltip);
    badge.addEventListener('mouseleave', hideTooltip);
    badge.addEventListener('blur', hideTooltip);
  }

  window.addEventListener('resize', positionTooltip);
  window.addEventListener('scroll', positionTooltip, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  });
}

function initializeCustomSelects() {
  const selects = [...document.querySelectorAll('.select-shell select')];
  let openSelect = null;

  const closeOpenSelect = () => {
    openSelect?.close();
    openSelect = null;
  };

  for (const select of selects) {
    const shell = select.closest('.select-shell');
    const trigger = document.createElement('button');
    const value = document.createElement('span');
    const menu = document.createElement('div');
    const listboxId = `${select.id}-options`;
    const options = [...select.options];
    let activeIndex = Math.max(0, select.selectedIndex);

    trigger.type = 'button';
    trigger.className = 'app-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', listboxId);
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.id);
    value.className = 'app-select-value';
    trigger.appendChild(value);

    menu.id = listboxId;
    menu.className = 'app-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', trigger.getAttribute('aria-label'));
    menu.hidden = true;

    options.forEach((option, index) => {
      const item = document.createElement('button');
      const label = document.createElement('span');
      const checkmark = document.createElement('span');

      item.type = 'button';
      item.className = 'app-select-option';
      item.setAttribute('role', 'option');
      item.dataset.optionIndex = String(index);
      label.textContent = option.textContent.trim();
      checkmark.className = 'app-select-option-check';
      checkmark.setAttribute('aria-hidden', 'true');
      checkmark.textContent = '✓';
      item.append(label, checkmark);
      item.addEventListener('click', () => {
        if (select.disabled || option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeOpenSelect();
        trigger.focus();
      });
      menu.appendChild(item);
    });

    const syncSelection = () => {
      activeIndex = Math.max(0, select.selectedIndex);
      value.textContent = options[activeIndex]?.textContent.trim() || '';
      menu.querySelectorAll('[role="option"]').forEach((item, index) => {
        item.setAttribute('aria-selected', String(index === activeIndex));
      });
      trigger.disabled = select.disabled;
      shell.classList.toggle('is-disabled', select.disabled);
    };

    const positionMenu = () => {
      const rect = trigger.getBoundingClientRect();
      const gap = 6;
      const viewportPadding = 8;
      const menuWidth = Math.min(rect.width, Math.max(0, window.innerWidth - viewportPadding * 2));
      const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
      const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const availableAbove = rect.top - gap - viewportPadding;
      const estimatedHeight = Math.min(menu.scrollHeight, 260);
      const openAbove = availableBelow < estimatedHeight && availableAbove > availableBelow;
      const maxHeight = Math.max(80, Math.min(260, openAbove ? availableAbove : availableBelow));

      menu.style.left = `${Math.min(Math.max(viewportPadding, rect.left), maxLeft)}px`;
      menu.style.width = `${menuWidth}px`;
      menu.style.maxHeight = `${maxHeight}px`;
      menu.style.top = openAbove
        ? `${Math.max(viewportPadding, rect.top - Math.min(menu.scrollHeight, maxHeight) - gap)}px`
        : `${Math.min(rect.bottom + gap, window.innerHeight - viewportPadding - maxHeight)}px`;
    };

    const open = (focusIndex = null) => {
      if (select.disabled) return;
      closeOpenSelect();
      syncSelection();
      shell.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.hidden = false;
      positionMenu();
      openSelect = { close, position: positionMenu };
      if (focusIndex !== null) {
        focusOption(focusIndex);
      }
    };

    const close = () => {
      menu.hidden = true;
      shell.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    };

    const focusOption = (index) => {
      const items = menu.querySelectorAll('[role="option"]');
      if (!items.length) return;
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      items[activeIndex].focus();
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    };

    trigger.addEventListener('click', () => {
      if (menu.hidden) open();
      else closeOpenSelect();
    });

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (menu.hidden) open(activeIndex + direction);
        else focusOption(activeIndex + direction);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (menu.hidden) open(event.key === 'Home' ? 0 : options.length - 1);
        else focusOption(event.key === 'Home' ? 0 : options.length - 1);
      } else if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        closeOpenSelect();
        trigger.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (menu.hidden) open(activeIndex);
      }
    });

    menu.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusOption(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        focusOption(event.key === 'Home' ? 0 : options.length - 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeOpenSelect();
        trigger.focus();
      } else if (event.key === 'Tab') {
        closeOpenSelect();
      }
    });

    select.classList.add('native-select-bridge');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    select.addEventListener('change', syncSelection);
    shell.insertBefore(trigger, select);
    document.body.appendChild(menu);
    syncSelection();
  }

  document.addEventListener('pointerdown', (event) => {
    if (openSelect && !event.target.closest('.select-shell') && !event.target.closest('.app-select-menu')) {
      closeOpenSelect();
    }
  });
  window.addEventListener('resize', closeOpenSelect);
  window.addEventListener('scroll', () => openSelect?.position(), true);
}

function fillSettings(settings) {
  elements.browserPath.value = settings.browserPath || '';
  elements.cookiePath.value = settings.cookiePath || '';
  elements.outputDir.value = settings.outputDir || '';
  elements.failureCsvPath.value = settings.failureCsvPath || '';
  elements.obsidianVaultPath.value = settings.obsidianVaultPath || '';
  elements.obsidianSetupMode.value = settings.obsidianSetupMode || 'bases+community';
  elements.diagramExportMode.value = settings.diagramExportMode || 'auto';
  elements.assetDirectoryName.value = settings.assetDirectoryName || '_assets';
  elements.vaultExportLayout.value = settings.vaultExportLayout || 'direct-to-vault';
  elements.vaultExportSubdir.value = settings.vaultExportSubdir || '语雀导出';
  elements.encryptedPasswords.value = normalizePasswordList(settings.encryptedBlockPasswords, settings.encryptedBlockPassword);
  elements.reencryptEncryptedBlocksMode.value = settings.reencryptEncryptedBlocksMode || 'global';
  elements.reencryptGlobalPassword.value = settings.reencryptGlobalPassword || '';
  elements.downloadImages.checked = settings.downloadImages !== false;
  elements.downloadAttachments.checked = settings.downloadAttachments !== false;
  elements.incrementalExport.checked = settings.incrementalExport !== false;
  elements.autoCheckUpdates.checked = settings.autoCheckUpdates !== false;
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
    assetDirectoryName: elements.assetDirectoryName.value.trim() || '_assets',
    autoCheckUpdates: elements.autoCheckUpdates.checked,
  };
}

function openSettingsDialog() {
  state.settingsTriggerBeforeOpen = document.activeElement;
  elements.settingsModal.hidden = false;
  elements.settingsModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('settings-dialog-open');
  refreshUpdateState().finally(() => elements.settingsDialog.focus());
}

function closeSettingsDialog() {
  if (elements.settingsModal.hidden) return;
  elements.settingsModal.hidden = true;
  elements.settingsModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('settings-dialog-open');
  stopUpdatePolling();
  if (state.settingsTriggerBeforeOpen instanceof HTMLElement) {
    state.settingsTriggerBeforeOpen.focus();
  }
}

function handleSettingsDialogKeydown(event) {
  if (elements.settingsModal.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSettingsDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...elements.settingsDialog.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function refreshUpdateState() {
  if (typeof window.pywebview.api.getUpdateState !== 'function') return null;
  try {
    const update = await window.pywebview.api.getUpdateState();
    state.update = update;
    renderUpdateState(update);
    return update;
  } catch (error) {
    renderUpdateState({ status: 'error', message: '读取更新状态失败', error: error.message, currentVersion: '?' });
    return null;
  }
}

function renderUpdateState(update = {}) {
  const status = String(update.status || 'idle');
  const available = update.availableUpdate || null;
  const currentVersion = update.currentVersion ? `v${update.currentVersion}` : '未知';
  const message = update.error || update.message || '尚未检查更新';
  const isDownloading = status === 'downloading';
  const isDownloaded = status === 'downloaded';
  const isApplying = status === 'applying';

  elements.updateCurrentVersion.textContent = currentVersion;
  elements.updateLastChecked.textContent = formatUpdateTime(update.lastCheckedAt);
  elements.updateStatus.textContent = available ? `${message}（v${available.version}）` : message;
  elements.autoCheckUpdates.checked = state.settings?.autoCheckUpdates !== false;
  elements.autoCheckUpdates.disabled = isApplying;
  elements.updateNotes.replaceChildren();
  for (const note of available?.notes || []) {
    const item = document.createElement('li');
    item.textContent = note;
    elements.updateNotes.append(item);
  }
  elements.updateNotes.hidden = !available?.notes?.length;

  const showProgress = isDownloading || isDownloaded || isApplying;
  elements.updateProgressWrap.hidden = !showProgress;
  elements.updateProgressBar.style.width = `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;
  elements.updateProgressText.textContent = isApplying ? '正在安装…' : `${Math.max(0, Math.min(100, Number(update.progress || 0)))}%`;

  elements.checkUpdateBtn.hidden = isDownloading || isApplying;
  elements.checkUpdateBtn.disabled = status === 'checking';
  elements.checkUpdateBtn.textContent = status === 'checking' ? '正在检查…' : '立即检查更新';
  elements.cancelUpdateDownloadBtn.hidden = !isDownloading;
  elements.downloadUpdateBtn.hidden = !available || isDownloading || isDownloaded || isApplying || !update.isPackaged;
  elements.downloadUpdateBtn.disabled = !update.canInstall;
  elements.installUpdateBtn.hidden = !isDownloaded;
  elements.installUpdateBtn.disabled = !update.canInstall;
  elements.installUpdateBtn.textContent = update.canInstall ? '安装并重启' : '安装目录不可写';
}

function formatUpdateTime(value) {
  if (!value) return '尚未检查';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function saveAutoCheckUpdates() {
  const enabled = elements.autoCheckUpdates.checked;
  try {
    const result = await window.pywebview.api.setAutoCheckUpdates(enabled);
    state.settings = { ...(state.settings || {}), autoCheckUpdates: result.autoCheckUpdates };
    renderUpdateState(result.update || state.update || {});
  } catch (error) {
    elements.autoCheckUpdates.checked = state.settings?.autoCheckUpdates !== false;
    renderStatus(`保存自动更新设置失败: ${error.message}`);
  }
}

async function checkForUpdates(force) {
  if (typeof window.pywebview.api.checkForUpdates !== 'function') return;
  try {
    renderUpdateState({ ...(state.update || {}), status: 'checking', message: '正在检查更新…' });
    const update = await window.pywebview.api.checkForUpdates(Boolean(force));
    state.update = update;
    renderUpdateState(update);
    if (update.status === 'available' && !elements.settingsModal.hidden) {
      elements.downloadUpdateBtn.focus();
    }
  } catch (error) {
    renderUpdateState({ ...(state.update || {}), status: 'error', message: '检查更新失败', error: error.message });
  }
}

async function startUpdateDownload() {
  try {
    const update = await window.pywebview.api.startUpdateDownload();
    state.update = update;
    renderUpdateState(update);
    startUpdatePolling();
  } catch (error) {
    renderStatus(`下载更新失败: ${error.message}`);
  }
}

async function cancelUpdateDownload() {
  try {
    const update = await window.pywebview.api.cancelUpdateDownload();
    state.update = update;
    renderUpdateState(update);
  } catch (error) {
    renderStatus(`取消下载失败: ${error.message}`);
  }
}

async function installDownloadedUpdate() {
  if (!window.confirm('安装更新会关闭当前程序。确认继续吗？')) return;
  try {
    const update = await window.pywebview.api.installDownloadedUpdate();
    state.update = { ...(state.update || {}), ...update, status: 'applying' };
    renderUpdateState(state.update);
  } catch (error) {
    renderStatus(`安装更新失败: ${error.message}`);
  }
}

function startUpdatePolling() {
  stopUpdatePolling();
  state.updatePollTimer = window.setInterval(async () => {
    const update = await refreshUpdateState();
    if (!update || !['downloading', 'checking', 'applying'].includes(update.status)) stopUpdatePolling();
  }, 450);
}

function stopUpdatePolling() {
  if (state.updatePollTimer) {
    window.clearInterval(state.updatePollTimer);
    state.updatePollTimer = null;
  }
}

function scheduleAutoUpdateCheck() {
  if (state.settings?.autoCheckUpdates === false || typeof window.pywebview.api.checkForUpdates !== 'function') return;
  window.setTimeout(async () => {
    if (state.currentJobStatus === 'running') return;
    try {
      const update = await window.pywebview.api.checkForUpdates(false);
      state.update = update;
      renderUpdateState(update);
      if (update.status === 'available') renderStatus(`发现新版本 v${update.availableUpdate?.version}，可在右下角设置中下载。`);
    } catch {
      // 自动检查失败不打断正常启动；用户仍可在设置中手动检查。
    }
  }, 8000);
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

async function refreshLoginStatus(options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const payload = await window.pywebview.api.getLoginStatus(readSettings());
      state.loginUser = payload?.loggedIn ? payload.user || null : null;
    } catch {
      state.loginUser = null;
    }
    if (state.loginUser || attempt === attempts - 1) break;
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }
  renderAccount();
  syncUnauthenticatedEmptyStates();
}

function syncUnauthenticatedEmptyStates() {
  if (state.loginUser) return;
  if (state.books.length === 0) {
    elements.booksList.className = 'books-list empty-state';
    elements.booksList.textContent = '';
  }
  if (!state.documentSourcesScanned) {
    elements.favoriteDocumentRows.textContent = '';
    elements.collaborationDocumentRows.textContent = '';
  }
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

  elements.accountText.textContent = '';
  elements.accountBadge.classList.remove('logged-in');
  elements.loginBtn.textContent = '登录语雀';
  elements.loginBtn.classList.add('primary');
  elements.loginBtn.classList.remove('secondary', 'login-switch-btn');
}

function togglePasswordVisibility() {
  const masked = elements.encryptedPasswords.classList.toggle('masked-textarea');
  elements.togglePasswordsBtn.classList.toggle('active', !masked);
  elements.togglePasswordsBtn.title = masked ? '显示密码' : '隐藏密码';
  elements.togglePasswordsBtn.setAttribute('aria-label', masked ? '显示密码' : '隐藏密码');
  elements.togglePasswordsBtn.setAttribute('aria-pressed', String(!masked));
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
  elements.toggleReencryptPasswordBtn.title = visible ? '显示重加密密码' : '隐藏重加密密码';
  elements.toggleReencryptPasswordBtn.setAttribute('aria-label', visible ? '显示重加密密码' : '隐藏重加密密码');
  elements.toggleReencryptPasswordBtn.setAttribute('aria-pressed', String(!visible));
}

function syncReencryptControls() {
  const mode = elements.reencryptEncryptedBlocksMode.value || 'off';
  const enableGlobalPassword = mode === 'global';
  if (elements.reencryptGlobalPasswordField) {
    elements.reencryptGlobalPasswordField.hidden = !enableGlobalPassword;
    elements.reencryptGlobalPasswordField.classList.toggle('is-disabled', !enableGlobalPassword);
  }
  elements.reencryptGlobalPassword.disabled = !enableGlobalPassword;
  elements.toggleReencryptPasswordBtn.disabled = !enableGlobalPassword;
  if (!enableGlobalPassword) {
    elements.reencryptGlobalPassword.type = 'password';
    elements.toggleReencryptPasswordBtn.classList.remove('active');
    elements.toggleReencryptPasswordBtn.title = '显示或隐藏重加密密码';
    elements.toggleReencryptPasswordBtn.setAttribute('aria-label', '显示重加密密码');
    elements.toggleReencryptPasswordBtn.setAttribute('aria-pressed', 'false');
  }
}

function syncVaultExportControls() {
  const outputOnly = (elements.vaultExportLayout.value || 'output-only') === 'output-only';
  const pathPairRow = elements.vaultExportSubdir.closest('.path-pair-row');
  const mainField = elements.obsidianVaultPath.closest('.path-pair-main');
  const subField = elements.vaultExportSubdir.closest('.path-pair-sub');

  if (pathPairRow) {
    pathPairRow.hidden = outputOnly;
  }
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
  setExportProgressVisible(false);
  await saveSettings();
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
  try {
    setExportProgressVisible(false);
    await saveSettings();
    renderStatus('正在扫描知识库...');
    const result = await requestBookScan();
    applyBookScanResult(result, '已扫描');
    await refreshLoginStatus();
    await scanDocumentSources();
  } catch (error) {
    renderStatus(`扫描知识库失败: ${error.message}`);
  }
}

async function scanDocumentSources() {
  try {
    setExportProgressVisible(false);
    await saveSettings();
    if (typeof window.pywebview.api.startDocumentSourceScan !== 'function') {
      throw new Error('当前桌面桥接版本不支持收藏/协作扫描，请使用源码启动新版程序。');
    }
    const { jobId } = await window.pywebview.api.startDocumentSourceScan(readSettings());
    state.currentJobId = jobId;
    state.currentJobKind = 'source-scan';
    state.currentJobStatus = 'running';
    syncControls();
    renderStatus(
      '正在读取收藏与协作分类；不会展开知识库入口。扫描结果完整前会保留现有列表。',
    );
    pollJob(jobId);
  } catch (error) {
    renderStatus(`扫描收藏/协作文档失败: ${error.message}`);
  }
}

function applyDocumentSourceScanResult(result = {}) {
  if (!Array.isArray(result.documents) || !Array.isArray(result.excluded)) {
    throw new Error('扫描响应缺少文档或排除项列表，不能按空列表继续。');
  }
  state.documentSources = result.documents;
  state.documentSourcesScanned = true;
  const excludedCount = Number(result.excludedCount ?? result.excluded.length);
  state.documentSourcesExcludedCount = Number.isFinite(excludedCount) ? excludedCount : result.excluded.length;
  const availableKeys = new Set(result.documents.map((entry) => String(entry.documentKey || '')).filter(Boolean));
  state.selectedDocumentKeys = new Set(
    [...state.selectedDocumentKeys].filter((documentKey) => availableKeys.has(documentKey)),
  );
  renderDocumentSources();
  renderStatus(
    `已扫描收藏/协作：${result.documents.length} 篇具体文档，${excludedCount} 个入口或暂不可识别项目未展开。`,
  );
}

async function autoScanBooksOnLaunch() {
  renderStatus('已检测到登录账号，正在自动扫描知识库、收藏与协作...');
  try {
    const result = await requestBookScan();
    applyBookScanResult(result, '已自动扫描');
  } catch (error) {
    renderStatus(`自动扫描知识库失败: ${error.message}`);
  }
  await scanDocumentSources();
}

async function autoScanBooksAfterLogin() {
  renderStatus('登录完成，正在自动扫描知识库、收藏与协作...');
  try {
    const result = await requestBookScan();
    applyBookScanResult(result, '首次登录成功，已自动扫描');
  } catch (error) {
    renderStatus(`登录完成，但自动扫描知识库失败: ${error.message}`);
  }
  await scanDocumentSources();
}

async function requestBookScan() {
  const config = readSettings();
  if (typeof window.pywebview.api.scanBooksDetailed === 'function') {
    return await window.pywebview.api.scanBooksDetailed(config);
  }

  // 兼容仍只暴露旧 scanBooks 接口的桌面桥接层。
  const books = await window.pywebview.api.scanBooks(config);
  return {
    books,
    warnings: [],
    totalBooks: books.length,
    skippedBooks: 0,
  };
}

function applyBookScanResult(result = {}, successPrefix = '已扫描') {
  const books = Array.isArray(result.books) ? result.books : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const reportedTotalBooks = Number(result.totalBooks ?? books.length + warnings.length);
  const reportedSkippedBooks = Number(result.skippedBooks ?? warnings.length);
  const totalBooks = Number.isFinite(reportedTotalBooks) ? reportedTotalBooks : books.length + warnings.length;
  const skippedBooks = Number.isFinite(reportedSkippedBooks) ? reportedSkippedBooks : warnings.length;

  state.books = books;
  state.selectedBooks = new Set(books.map((book) => String(book.id)));
  state.selectedDocuments = new Set();
  state.expandedNodes = collectDefaultExpandedNodes(books);
  renderBooks();

  appendScanWarnings(warnings);
  if (skippedBooks > 0) {
    renderStatus(`${successPrefix} ${books.length}/${totalBooks} 个知识库，已跳过 ${skippedBooks} 个异常知识库；详情见日志`);
    return;
  }
  renderStatus(`${successPrefix} ${books.length} 个知识库`);
}

function appendScanWarnings(warnings = []) {
  for (const warning of warnings) {
    const message = String(warning?.message || warning || '').trim();
    if (message) {
      state.systemLogs.push(`扫描提示：${message}`);
    }
  }
  if (state.systemLogs.length > 120) {
    state.systemLogs = state.systemLogs.slice(-120);
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

  if (
    state.currentJobKind === 'export' &&
    state.currentJobStatus === 'paused' &&
    (
      state.currentExportSource === 'document-sources' ||
      (state.currentExportSource === 'retry' && state.lastExportConfig?.retrySourceDocuments?.length > 0)
    )
  ) {
    await startDocumentSourceExport(state.lastExportConfig);
    return;
  }

  if (state.selectedDocumentKeys.size > 0) {
    await startDocumentSourceExport();
  } else {
    await startExport();
  }
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

async function startDocumentSourceExport(resumeConfig = null) {
  const selectedDocumentKeys = Array.isArray(resumeConfig?.selectedDocumentKeys)
    ? resumeConfig.selectedDocumentKeys
    : collectSelectedDocumentKeysFromUi();
  state.selectedDocumentKeys = new Set(selectedDocumentKeys);
  if (selectedDocumentKeys.length === 0) {
    renderStatus('请先在“收藏与协作”中选择至少一篇具体文档。');
    return;
  }
  if (typeof window.pywebview.api.startDocumentSourceExport !== 'function') {
    renderStatus('当前桌面桥接版本不支持收藏/协作文档导出，请使用源码启动新版程序。');
    return;
  }

  if (!resumeConfig) {
    await saveSettings();
  }
  const config = {
    ...(resumeConfig || readSettings()),
    selectedDocumentKeys,
  };
  state.lastExportConfig = config;
  state.lastSelectionSummary = { totalBooks: 0, totalDocuments: selectedDocumentKeys.length };
  state.lastProgressSnapshot = {
    completedBooks: 0,
    totalBooks: 0,
    completedDocuments: 0,
    totalDocuments: selectedDocumentKeys.length,
    bookCompleted: 0,
    bookTotal: selectedDocumentKeys.length,
    currentBook: '',
    currentDoc: '',
  };
  const { jobId } = await window.pywebview.api.startDocumentSourceExport(config);
  state.currentJobId = jobId;
  state.currentJobKind = 'export';
  state.currentJobStatus = 'running';
  state.currentExportSource = 'document-sources';
  state.currentOutputDir = config.outputDir;
  syncControls();
  renderStatus(`已启动来源文档导出，仅处理明确选择的 ${selectedDocumentKeys.length} 篇文档。`);
  renderLogs([`收藏/协作文档导出已启动，共 ${selectedDocumentKeys.length} 篇。`]);
  setProgress(0, '准备导出...', `0% · 文档 0/${selectedDocumentKeys.length}`);
  setBookProgress(0, '检查所选文档...', `0% · 文档 0/${selectedDocumentKeys.length}`);
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
    selectedDocumentKeys: result.selectedDocumentKeys || [],
    retrySourceDocuments: result.retrySourceDocuments || [],
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
  renderStatus(
    result.sourceRetry
      ? `来源文档失败重试已启动，仅重导 ${result.documentCount || 0} 篇文档，不扫描知识库。`
      : `失败文档重导任务已启动，将覆盖重导 ${result.documentCount || 0} 篇文档。`,
  );
  renderLogs([
    `已从失败日志读取 ${result.rowCount || 0} 条记录，去重后匹配到 ${result.documentCount || 0} 篇文档。`,
    result.sourceRetry
      ? `这些来源文档将按 documentKey 直接重试，使用失败日志所在目录：${state.currentOutputDir}`
      : `本次已自动关闭增量导出，并使用失败日志所在目录作为输出目录：${state.currentOutputDir}`,
    unmatchedCount > 0 ? `有 ${unmatchedCount} 篇文档当前未在可访问知识库中找到，已暂时跳过。` : '失败日志中的可匹配文档都已加入本次重导任务。',
  ]);
  setProgress(
    0,
    '准备重新导出...',
    result.sourceRetry
      ? `0% · 文档 0/${state.lastSelectionSummary.totalDocuments}`
      : `0% · 知识库 0/${state.lastSelectionSummary.totalBooks} · 文档 0/${state.lastSelectionSummary.totalDocuments}`,
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
  renderStatus(
    state.currentExportSource === 'document-sources'
      ? '已请求暂停，当前文档处理完成后会自动暂停；继续时会沿用本次勾选的文档。'
      : '已请求暂停，当前文档处理完成后会自动暂停。暂停后可重新调整知识库选择，再继续导出。',
  );
}

async function stopExport() {
  if (!state.currentJobId) {
    return;
  }
  await window.pywebview.api.cancelExport(state.currentJobId);
  state.currentJobStatus = 'stopping';
  syncControls();
  renderStatus(
    state.currentJobKind === 'source-scan'
      ? '已请求停止；当前列表页结束后将取消，之前的完整扫描结果会保留。'
      : '已请求停止，当前进度会先保存。',
  );
}

function renderBooks() {
  if (state.books.length === 0) {
    elements.booksList.className = 'books-list empty-state';
    elements.booksList.textContent = '没有可导出的知识库。';
    elements.bookCount.textContent = '0 个知识库 / 0 篇文档';
    syncTreeFoldToggleButton();
    syncCategorySelectionControls();
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
  syncCategorySelectionControls();
  syncControls();
}

function renderDocumentSources() {
  const groups = [
    ['favorite', elements.favoriteDocumentRows, '收藏'],
    ['collaboration', elements.collaborationDocumentRows, '协作'],
  ];
  for (const [, list] of groups) list.replaceChildren();
  if (!state.documentSourcesScanned) {
    for (const [, list] of groups) {
      list.className = 'empty-state';
      list.textContent = '扫描知识库后会同时读取此分类。';
    }
    if (state.books.length === 0) elements.bookCount.textContent = '尚未扫描';
    syncCategorySelectionControls();
    syncControls();
    return;
  }

  const counts = new Map();
  for (const [sourceType, list, categoryName] of groups) {
    const entries = getDocumentsForSourceType(sourceType);
    counts.set(sourceType, { total: entries.length });
    if (entries.length === 0) {
      list.className = 'empty-state';
      list.textContent = `${categoryName}分类中没有可直接导出的具体文档。`;
      continue;
    }

    list.className = 'source-document-list';
    for (const entry of entries) {
      const supported = ['Doc', 'Sheet'].includes(entry.documentType);
      const row = document.createElement('div');
      row.className = 'tree-row source-document-row';

      const toggle = document.createElement('div');
      toggle.className = 'tree-spacer';
      row.appendChild(toggle);

      const checkboxWrap = document.createElement('label');
      checkboxWrap.className = 'tree-checkbox';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.documentKey = String(entry.documentKey || '');
      checkbox.checked = state.selectedDocumentKeys.has(checkbox.dataset.documentKey);
      checkbox.disabled = !supported || !checkbox.dataset.documentKey;
      checkbox.setAttribute('aria-label', `选择文档：${String(entry.title || '未命名文档')}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.selectedBooks.clear();
          state.selectedDocuments.clear();
          renderBooks();
          state.selectedDocumentKeys.add(checkbox.dataset.documentKey);
        } else {
          state.selectedDocumentKeys.delete(checkbox.dataset.documentKey);
        }
        renderDocumentSources();
      });
      checkboxWrap.appendChild(checkbox);
      row.appendChild(checkboxWrap);

      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'tree-label source-document-title';
      title.disabled = !supported || !checkbox.dataset.documentKey;
      title.setAttribute('aria-label', `选择文档：${String(entry.title || '未命名文档')}`);
      title.addEventListener('click', () => checkbox.click());
      const titleText = document.createElement('strong');
      titleText.textContent = String(entry.title || '未命名文档');

      const typeBadge = document.createElement('span');
      typeBadge.className = 'tree-type-badge';
      typeBadge.textContent = entry.documentType === 'Sheet' ? '数据表' : '文档';
      title.append(titleText, typeBadge);
      row.appendChild(title);
      list.appendChild(row);
    }
  }
  elements.bookCount.textContent =
    `收藏 ${counts.get('favorite').total}/${counts.get('favorite').total} 篇 · `
    + `协作 ${counts.get('collaboration').total}/${counts.get('collaboration').total} 篇 · `
    + `已选 ${state.selectedDocumentKeys.size} 篇 · ${state.documentSourcesExcludedCount} 个入口/项目未展开`;
  syncCategorySelectionControls();
  syncControls();
}

function getEntrySourceTypes(entry) {
  const relations = Array.isArray(entry.sourceRelations) ? entry.sourceRelations : [];
  const sourceTypes = new Set(relations.map((relation) => relation?.sourceType));
  if (sourceTypes.size === 0 && entry.sourceType) sourceTypes.add(entry.sourceType);
  return sourceTypes;
}

function getDocumentsForSourceType(sourceType) {
  return state.documentSources.filter((entry) => getEntrySourceTypes(entry).has(sourceType));
}

function toggleCategory(categoryId) {
  const toggle = document.querySelector(`[data-category-toggle="${categoryId}"]`);
  if (!toggle) return;

  const content = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!content) return;

  const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!isExpanded));
  content.hidden = isExpanded;
}

function toggleCategorySelection(categoryId, checked) {
  if (categoryId === 'knowledge') {
    state.selectedBooks = checked
      ? new Set(state.books.map((book) => String(book.id)))
      : new Set();
    state.selectedDocuments.clear();
    state.selectedDocumentKeys.clear();
    renderBooks();
    renderDocumentSources();
    return;
  }

  if (!['favorite', 'collaboration'].includes(categoryId)) return;
  const documentKeys = getDocumentsForSourceType(categoryId)
    .filter((entry) => ['Doc', 'Sheet'].includes(entry.documentType))
    .map((entry) => String(entry.documentKey || '').trim())
    .filter(Boolean);
  if (documentKeys.length === 0) return;

  if (checked) {
    state.selectedBooks.clear();
    state.selectedDocuments.clear();
    documentKeys.forEach((documentKey) => state.selectedDocumentKeys.add(documentKey));
  } else {
    documentKeys.forEach((documentKey) => state.selectedDocumentKeys.delete(documentKey));
  }
  renderBooks();
  renderDocumentSources();
}

function syncCategorySelectionControls() {
  const knowledgeStates = state.books.map((book) => {
    const bookId = String(book.id);
    const documentUrls = collectDocumentUrls(book.root, {
      bookUserUrl: book.userUrl,
      bookSlug: book.slug,
    });
    const selected = state.selectedBooks.has(bookId)
      || (documentUrls.length > 0 && documentUrls.every((url) => state.selectedDocuments.has(url)));
    const partiallySelected = !state.selectedBooks.has(bookId)
      && documentUrls.some((url) => state.selectedDocuments.has(url));
    return { selected, partiallySelected };
  });
  syncCategoryCheckbox('knowledge', knowledgeStates);

  for (const sourceType of ['favorite', 'collaboration']) {
    const documentKeys = getDocumentsForSourceType(sourceType)
      .filter((entry) => ['Doc', 'Sheet'].includes(entry.documentType))
      .map((entry) => String(entry.documentKey || '').trim())
      .filter(Boolean);
    const selectedKeys = new Set(state.selectedDocumentKeys);
    syncCategoryCheckbox(
      sourceType,
      documentKeys.map((documentKey) => ({ selected: selectedKeys.has(documentKey) })),
    );
  }
}

function syncCategoryCheckbox(categoryId, items) {
  const checkbox = document.querySelector(`[data-category-select="${categoryId}"]`);
  if (!checkbox) return;

  const selectedCount = items.filter((item) => item.selected || item.partiallySelected).length;
  checkbox.checked = items.length > 0 && selectedCount === items.length
    && items.every((item) => item.selected);
  checkbox.indeterminate = selectedCount > 0 && !checkbox.checked;
  checkbox.disabled = items.length === 0;
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
    subtitle.className = 'tree-type-badge';
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
  clearSelectedSourceDocuments();
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
  clearSelectedSourceDocuments();
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

function clearSelectedSourceDocuments() {
  if (state.selectedDocumentKeys.size === 0) return;
  state.selectedDocumentKeys.clear();
  renderDocumentSources();
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
      const exportSource = state.currentExportSource;
      clearPollTimer();
      finalizeJobState(job);
      if (job.kind === 'source-scan') {
        try {
          applyDocumentSourceScanResult(job.result || {});
          const result = job.result || {};
          renderStatus(
            `已扫描收藏/协作：${result.documents.length} 篇具体文档，`
            + `${result.excludedCount ?? result.excluded.length} 个入口或暂不可识别项目未展开。`,
          );
          await refreshLoginStatus();
        } catch (error) {
          renderStatus(`扫描收藏/协作文档失败: ${error.message}；保留上次完整列表。`);
        }
      } else if (job.kind === 'login') {
        await refreshLoginStatus({ attempts: 4, delayMs: 750 });
        if (state.loginUser) {
          await autoScanBooksAfterLogin();
        } else {
          renderStatus('登录流程已结束，但当前未检测到有效登录状态。');
        }
      } else {
        const result = job.result || {};
        if (result.status === 'partial') {
          const totals = result.totals || {};
          if (exportSource === 'document-sources') {
            renderStatus(
              `来源导出有未完整项目：资源不完整 ${Number(totals.incomplete || 0)}，`
              + `需要登录 ${Number(totals.authenticationRequired || 0)}，`
              + `受限 ${Number(totals.restricted || 0)}，不可用 ${Number(totals.unavailable || 0)}，`
              + `其他失败 ${Math.max(0, Number(totals.failed || 0)
                - Number(totals.authenticationRequired || 0)
                - Number(totals.restricted || 0)
                - Number(totals.unavailable || 0))}，`
              + `不支持 ${Number(totals.unsupported || 0)}，本地修改保护 ${Number(totals.protected || 0)}；请查看结果报告。`,
            );
          } else {
            const affected = Number(totals.failed || 0)
              + Number(totals.unsupported || 0)
              + Number(totals.incomplete || 0)
              + Number(totals.protected || 0);
            renderStatus(`导出已完成，但有 ${affected} 篇文档失败、不支持、资源不完整或因本地修改而受保护；请查看结果报告。`);
          }
        } else {
          renderStatus('导出完成');
        }
      }
      const result = job.result || {};
      state.currentOutputDir = result.contentOutputDir || result.outputDir || state.currentOutputDir;
      if (result.failureCsv) {
        // CSV 每次都会创建；零条记录只代表没有问题，不能固定标为“失败”。
        const csvLabel = result.failureRecordCount === 0
          ? '本次无错误或警告记录（CSV 仅含表头）'
          : '问题记录 CSV';
        renderLogs([...(job.logs || []), `${csvLabel}: ${result.failureCsv}`]);
      }
      if (job.kind === 'export') {
        applyCompletedExportProgress(result, exportSource);
      }
    } else if (job.status === 'paused') {
      clearPollTimer();
      finalizeJobState(job);
      state.currentJobKind = 'export';
      renderStatus('导出已暂停，可随时继续。');
    } else if (job.status === 'error' || job.status === 'cancelled') {
      clearPollTimer();
      finalizeJobState(job);
      if (job.kind === 'login') {
        // 登录失败或取消后都要重新检查一次状态。
        // 否则前端会继续显示登录前的旧账号徽标，误导后续诊断。
        await refreshLoginStatus({ attempts: 2, delayMs: 500 });
        state.loginWasAlreadyAuthenticated = Boolean(state.loginUser);
        if (job.status === 'cancelled') {
          renderStatus(
            state.loginUser
              ? (job.result?.message || '已取消切换账号，可继续使用当前账号。')
              : '登录流程已取消，当前未检测到有效登录状态。',
          );
        } else {
          const errorMessage = job.error || job.result?.message || '登录失败';
          const stateMessage = state.loginUser
            ? '当前账号仍可用。'
            : '当前未检测到有效登录状态。';
          renderStatus(`${errorMessage} ${stateMessage}`);
        }
      } else {
        renderStatus(
          job.kind === 'source-scan' && job.status === 'cancelled'
            ? '收藏/协作扫描已取消；保留上次完整列表。'
            : (job.error || job.result?.message || (job.status === 'cancelled' ? '任务已停止' : '任务失败')),
        );
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
  if (job.kind !== 'export') {
    setExportProgressVisible(false);
    return;
  }
  setExportProgressVisible(true);

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
  const isSourceExport = state.currentExportSource === 'document-sources';
  const overallText = currentBook
    ? `当前知识库：${currentBook}`
    : localizeProgressMessage(latestProgress.message || '处理中...');
  const overallStats = isSourceExport
    ? `${formatPercent(overallPercent)} · 文档 ${completedDocuments}/${totalDocuments || 0}`
    : `${formatPercent(overallPercent)} · 知识库 ${completedBooks}/${totalBooks || 0} · 文档 ${completedDocuments}/${totalDocuments || 0}`;
  setProgress(overallPercent, overallText, overallStats);

  const bookCompleted = latestProgress.bookCompleted ?? state.lastProgressSnapshot.bookCompleted ?? 0;
  const bookTotal = latestProgress.bookTotal ?? state.lastProgressSnapshot.bookTotal ?? 0;
  const bookPercent = latestProgress.bookPercent ?? 0;
  const bookText = isSourceExport
    ? (currentDoc ? `当前文档：${currentDoc}` : '检查所选文档...')
    : currentDoc
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

function setExportProgressVisible(visible) {
  if (elements.progressMeta) {
    elements.progressMeta.hidden = !visible;
  }
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

function applyCompletedExportProgress(result = {}, exportSource = '') {
  const totals = result.totals || {};
  if (
    exportSource === 'document-sources' ||
    (exportSource === 'retry' && state.lastExportConfig?.retrySourceDocuments?.length > 0)
  ) {
    const totalDocuments = Number(
      totals.planned ?? state.lastProgressSnapshot.totalDocuments ?? state.lastSelectionSummary.totalDocuments ?? 0,
    );
    const completedDocuments = Number(totals.exported || 0)
      + Number(totals.skipped || 0)
      + Number(totals.failed || 0)
      + Number(totals.unsupported || 0)
      + Number(totals.incomplete || 0)
      + Number(totals.protected || 0);
    const completionText = result.status === 'partial' ? '处理完成，存在未完整项目' : '所选文档已完成';
    setProgress(100, completionText, `100% · 文档 ${completedDocuments}/${totalDocuments}`);
    setBookProgress(100, '来源文档处理完成', `100% · 文档 ${completedDocuments}/${totalDocuments}`);
    return;
  }

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
  const sourceScanRunning =
    state.currentJobKind === 'source-scan' && ['running', 'stopping'].includes(state.currentJobStatus);
  const exportPaused = state.currentJobKind === 'export' && state.currentJobStatus === 'paused';
  const anyJobRunning = ['running', 'pausing', 'stopping'].includes(state.currentJobStatus);
  const exportBusy = exportRunning || exportPaused;
  const retryRunning = state.currentExportSource === 'retry' && state.currentJobKind === 'export' && state.currentJobStatus === 'running';
  const retryPaused = state.currentExportSource === 'retry' && exportPaused;
  const retryBusy =
    state.currentExportSource === 'retry' && state.currentJobKind === 'export' && ['pausing', 'stopping'].includes(state.currentJobStatus);
  const hasBooks = state.books.length > 0;
  const hasSourceDocuments = state.documentSources.some(
    (entry) => ['Doc', 'Sheet'].includes(entry.documentType) && entry.documentKey,
  );
  const hasCurrentViewContent = hasBooks || hasSourceDocuments;

  elements.loginBtn.disabled = anyJobRunning;
  elements.scanBtn.disabled = anyJobRunning;
  elements.chooseFailureCsvBtn.disabled = anyJobRunning;
  elements.retryFailuresBtn.disabled = retryBusy || (!retryRunning && !retryPaused && exportBusy);
  elements.stopBtn.disabled = !(exportRunning || sourceScanRunning) || state.currentJobStatus === 'stopping';

  setButtonTone(elements.exportBtn, hasCurrentViewContent ? 'primary' : 'secondary');
  syncRetryFailuresButton(exportRunning, exportPaused);

  elements.exportBtn.textContent = getExportButtonLabel();
  elements.exportBtn.disabled = exportRunning
    ? ['pausing', 'stopping'].includes(state.currentJobStatus)
    : anyJobRunning;
}

function getExportButtonLabel() {
  return '开始导出';
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

function collectSelectedDocumentKeysFromUi() {
  return [...state.selectedDocumentKeys];
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
