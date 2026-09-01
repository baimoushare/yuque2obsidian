import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exportBooks, runComplexArtifactWorkerTask, scanBooks } from './exporter.js';
import { normalizeReencryptMode } from './meld-encrypt.js';
import {
  createHttpClient,
  ensureAuthenticatedCookieFile,
  fetchCurrentUser,
  runManualLogin,
} from './yuque.js';

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function parseCliConfig(rawConfig) {
  const raw = rawConfig || process.env.YUQUE_EXPORTER_CONFIG || (
    process.env.YUQUE_EXPORTER_CONFIG_STDIN === '1' ? fs.readFileSync(0, 'utf8') : ''
  );
  if (!raw) {
    throw new Error('Missing exporter configuration (environment or stdin).');
  }

  const parsed = JSON.parse(raw);
  const encryptedBlockPasswords = Array.isArray(parsed.encryptedBlockPasswords)
    ? parsed.encryptedBlockPasswords.filter(Boolean)
    : parsed.encryptedBlockPassword
      ? [parsed.encryptedBlockPassword]
      : [];

  return {
    browserPath: parsed.browserPath || '',
    cookiePath: parsed.cookiePath || path.join(process.cwd(), 'cookies.json'),
    outputDir: parsed.outputDir || path.join(process.cwd(), 'output'),
    obsidianVaultPath: parsed.obsidianVaultPath || '',
    obsidianSetupMode: parsed.obsidianSetupMode || 'none',
    vaultExportLayout: parsed.vaultExportLayout || 'output-only',
    vaultExportSubdir: typeof parsed.vaultExportSubdir === 'string' ? parsed.vaultExportSubdir : '',
    selectedBooks: parsed.selectedBooks || [],
    fullySelectedBooks: parsed.fullySelectedBooks || [],
    selectedDocuments: parsed.selectedDocuments || [],
    downloadImages: parsed.downloadImages ?? true,
    downloadAttachments: parsed.downloadAttachments ?? true,
    incrementalExport: parsed.incrementalExport ?? true,
    datatableExportMode: parsed.datatableExportMode || 'structured-first',
    encryptedBlockPasswords,
    encryptedBlockPassword: encryptedBlockPasswords[0] || parsed.encryptedBlockPassword || '',
    reencryptEncryptedBlocksMode: normalizeReencryptMode(parsed.reencryptEncryptedBlocksMode || 'off'),
    reencryptGlobalPassword: parsed.reencryptGlobalPassword || '',
    complexBlockMode: parsed.complexBlockMode || 'auto',
    diagramExportMode: parsed.diagramExportMode || 'auto',
    diagramSnapshotMode: parsed.diagramSnapshotMode || 'fallback-only',
    assetLayout: parsed.assetLayout || 'book_assets',
    // 桌面端点击“切换账号”时会传入该标记。
    // 这里必须保留下来，否则后续 runManualLogin 会误以为是普通登录，
    // 直接复用 cookies.json / 浏览器资料目录里的旧会话，表现为按钮点击后没有反应。
    forceReauth: Boolean(parsed.forceReauth),
    jobControlPath: parsed.jobControlPath || '',
  };
}

function readConfig() {
  return parseCliConfig();
}

async function main() {
  const command = process.argv[2];
  const config = readConfig();

  switch (command) {
    case 'login': {
      const result = await runManualLogin(config, emit, { forceReauth: config.forceReauth });
      emit({ type: 'result', status: 'success', ...result });
      break;
    }
    case 'scan': {
      await ensureAuthenticatedCookieFile(config);
      const books = await scanBooks(config);
      emit({ type: 'result', status: 'success', books });
      break;
    }
    case 'whoami': {
      await ensureAuthenticatedCookieFile(config);
      const user = await fetchCurrentUser(createHttpClient(config.cookiePath));
      emit({ type: 'result', status: 'success', loggedIn: true, user });
      break;
    }
    case 'export':
      await ensureAuthenticatedCookieFile(config);
      await exportBooks(config, emit);
      break;
    case 'capture-artifacts-worker': {
      await ensureAuthenticatedCookieFile(config);
      const taskFile = process.env.YUQUE_COMPLEX_ARTIFACT_TASK_FILE || '';
      if (!taskFile || !fs.existsSync(taskFile)) {
        throw new Error('Missing YUQUE_COMPLEX_ARTIFACT_TASK_FILE for complex artifact worker.');
      }

      const taskRoot = path.resolve(path.dirname(taskFile));

      const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      const result = await runComplexArtifactWorkerTask(config, task);
      if (!task.resultFile) {
        throw new Error('Complex artifact worker task is missing resultFile.');
      }
      const resultFile = path.resolve(task.resultFile);
      if (path.dirname(resultFile) !== taskRoot) {
        throw new Error('Complex artifact worker resultFile must stay beside the task file.');
      }
      fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
      emit({ type: 'result', status: 'success', resultFile });
      break;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entryPath) {
  main().catch((error) => {
    emit({
      type: 'result',
      status: 'error',
      error: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
  });
}
