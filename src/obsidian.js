import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ensureDir, sanitizeFileName, writeJson } from './utils.js';

export function normalizeObsidianSetupMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'bases+community') {
    return 'bases+community';
  }
  if (normalized === 'bases') {
    return 'bases';
  }
  return 'none';
}

export function normalizeVaultExportLayout(value) {
  return String(value || '').trim().toLowerCase() === 'direct-to-vault' ? 'direct-to-vault' : 'output-only';
}

export function normalizeVaultExportSubdir(value) {
  const parts = String(value || '')
    .split(/[\\/]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => sanitizeFileName(item, ''))
    .filter(Boolean);
  return parts.length > 0 ? path.join(...parts) : '';
}

export function resolveContentOutputDir(config = {}) {
  const outputDir = path.resolve(String(config.outputDir || path.join(process.cwd(), 'output')));
  const vaultPath = String(config.obsidianVaultPath || '').trim();
  const layout = normalizeVaultExportLayout(config.vaultExportLayout);
  const subdir = normalizeVaultExportSubdir(config.vaultExportSubdir);

  if (vaultPath && layout === 'direct-to-vault') {
    const vaultRoot = path.resolve(vaultPath);
    return ensureDir(subdir ? path.join(vaultRoot, subdir) : vaultRoot);
  }

  return ensureDir(outputDir);
}

export function parseVaultListOutput(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split('\t');
      return {
        name: String(name || '').trim(),
        path: String(rest.join('\t') || '').trim(),
      };
    })
    .filter((item) => item.name && item.path);
}

export function resolveObsidianVaultName(cliPath, vaultPath) {
  if (!cliPath || !vaultPath) {
    return '';
  }

  const target = path.resolve(vaultPath);
  const output = execFileSync(cliPath, ['vaults', 'verbose'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const vaults = parseVaultListOutput(output);
  return vaults.find((vault) => path.resolve(vault.path) === target)?.name || '';
}

export function getDefaultObsidianCliPath() {
  const candidates = [
    process.env.OBSIDIAN_CLI_PATH,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Obsidian', 'Obsidian.com') : '',
    process.platform === 'darwin' ? '/Applications/Obsidian.app/Contents/MacOS/Obsidian' : '',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

/**
 * 只读检测当前 Vault 的图形能力。导出核心据此选择格式，绝不在这里静默安装插件。
 */
export function detectObsidianDiagramCapabilities(options = {}) {
  const vaultPath = String(options.vaultPath || '').trim();
  const cliPath = options.cliPath || getDefaultObsidianCliPath();
  const result = {
    vaultPath,
    cliPath,
    obsidianCli: false,
    markmap: false,
    excalidraw: false,
    excalidrawExtras: false,
    enabledPluginIds: [],
  };

  if (!vaultPath || !fs.existsSync(vaultPath)) {
    return result;
  }

  const pluginsRoot = path.join(vaultPath, '.obsidian', 'plugins');
  const enabledPath = path.join(vaultPath, '.obsidian', 'community-plugins.json');
  let enabled = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(enabledPath, 'utf8'));
    enabled = Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    enabled = [];
  }

  result.enabledPluginIds = enabled;
  const isAvailable = (id) => enabled.includes(id) && fs.existsSync(path.join(pluginsRoot, id));
  result.markmap = isAvailable('obsidian-mindmap-nextgen');
  result.excalidraw = isAvailable('obsidian-excalidraw-plugin');
  result.excalidrawExtras = isAvailable('excalidraw-extras');

  if (cliPath && fs.existsSync(cliPath)) {
    try {
      result.obsidianCli = Boolean(resolveObsidianVaultName(cliPath, vaultPath));
    } catch {
      result.obsidianCli = false;
    }
  }

  return result;
}

export function buildObsidianCliCommand(command, options = {}) {
  const args = [];
  if (options.vaultName) {
    args.push(`vault=${options.vaultName}`);
  }
  args.push(command);
  if (options.id) {
    args.push(`id=${options.id}`);
  }
  if (options.filter) {
    args.push(`filter=${options.filter}`);
  }
  if (options.enable) {
    args.push('enable');
  }
  return args;
}

export function planObsidianSetupActions(options = {}) {
  const mode = normalizeObsidianSetupMode(options.setupMode);
  if (mode === 'none') {
    return [];
  }

  const actions = [
    {
      kind: 'enable-core-plugin',
      pluginId: 'bases',
      filter: 'core',
      command: 'plugin:enable',
      args: buildObsidianCliCommand('plugin:enable', {
        vaultName: options.vaultName,
        id: 'bases',
        filter: 'core',
      }),
    },
  ];

  if (mode === 'bases+community') {
    actions.push({
      kind: 'install-community-plugin',
      pluginId: 'base-board',
      command: 'plugin:install',
      args: buildObsidianCliCommand('plugin:install', {
        vaultName: options.vaultName,
        id: 'base-board',
        enable: true,
      }),
    });
  }

  return actions;
}

export function executeObsidianSetup(options = {}) {
  const cliPath = options.cliPath || getDefaultObsidianCliPath();
  const vaultPath = String(options.vaultPath || '').trim();
  const setupMode = normalizeObsidianSetupMode(options.setupMode);

  const result = {
    cliPath,
    vaultPath,
    vaultName: '',
    setupMode,
    attempted: false,
    enabled: [],
    failed: [],
  };

  if (!cliPath || !vaultPath || setupMode === 'none') {
    return result;
  }

  let vaultName = '';
  try {
    vaultName = resolveObsidianVaultName(cliPath, vaultPath);
  } catch (error) {
    result.failed.push({
      kind: 'resolve-vault',
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }

  if (!vaultName) {
    result.failed.push({
      kind: 'resolve-vault',
      message: `The Obsidian CLI could not find a known Obsidian repository for ${vaultPath}.`,
    });
    return result;
  }

  result.vaultName = vaultName;
  result.attempted = true;

  for (const action of planObsidianSetupActions({ setupMode, vaultName })) {
    try {
      execFileSync(cliPath, action.args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      result.enabled.push({
        kind: action.kind,
        pluginId: action.pluginId,
      });
    } catch (error) {
      result.failed.push({
        kind: action.kind,
        pluginId: action.pluginId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export function writeObsidianSetupNote(outputDir, context = {}) {
  const root = ensureDir(outputDir);
  const filePath = path.join(root, 'Obsidian-setup.md');
  const lines = [
    '# Obsidian 接入说明',
    '',
    `- Obsidian 仓库目录: ${context.vaultPath || '未配置'}`,
    `- Obsidian 仓库名称: ${context.vaultName || '未识别'}`,
    `- 内容输出目录: ${context.contentOutputDir || '未设置'}`,
    `- 设置模式: ${context.setupMode || 'none'}`,
    `- CLI 路径: ${context.cliPath || '未检测到'}`,
    '',
    '## 建议启用',
    '',
    '- 核心插件 `Bases`：用于 table / cards / list 视图',
    '- 社区插件 `base-board`：可选，仅用于额外的 board 视图',
    '',
    '## CLI 命令',
    '',
  ];

  const actions = planObsidianSetupActions({
    setupMode: context.setupMode,
    vaultName: context.vaultName,
  });
  if (actions.length === 0) {
    lines.push('- 当前未要求自动配置插件。');
  } else {
    for (const action of actions) {
      const rendered = [context.cliPath || 'Obsidian.com', ...action.args].join(' ');
      lines.push(`- \`${rendered}\``);
    }
  }

  if (Array.isArray(context.enabled) && context.enabled.length > 0) {
    lines.push('', '## 已完成', '');
    for (const item of context.enabled) {
      lines.push(`- ${item.kind}${item.pluginId ? ` (${item.pluginId})` : ''}`);
    }
  }

  if (Array.isArray(context.failures) && context.failures.length > 0) {
    lines.push('', '## 自动配置结果', '');
    for (const failure of context.failures) {
      lines.push(`- ${failure.kind}${failure.pluginId ? ` (${failure.pluginId})` : ''}: ${failure.message}`);
    }
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

export function buildObsidianConfigSummary(config = {}, contentOutputDir = '') {
  return {
    outputDir: path.resolve(String(config.outputDir || path.join(process.cwd(), 'output'))),
    contentOutputDir: contentOutputDir ? path.resolve(contentOutputDir) : '',
    vaultPath: String(config.obsidianVaultPath || '').trim(),
    setupMode: normalizeObsidianSetupMode(config.obsidianSetupMode),
    vaultExportLayout: normalizeVaultExportLayout(config.vaultExportLayout),
    vaultExportSubdir: normalizeVaultExportSubdir(config.vaultExportSubdir),
  };
}

export function writeObsidianSetupJson(outputDir, payload = {}) {
  const filePath = path.join(ensureDir(outputDir), 'obsidian-setup.json');
  writeJson(filePath, payload);
  return filePath;
}
