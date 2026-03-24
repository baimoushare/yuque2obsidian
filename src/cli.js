import path from 'path';
import { exportBooks, scanBooks } from './exporter.js';
import { createHttpClient, fetchCurrentUser, runManualLogin } from './yuque.js';

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readConfig() {
  const raw = process.env.YUQUE_EXPORTER_CONFIG;
  if (!raw) {
    throw new Error('Missing YUQUE_EXPORTER_CONFIG environment variable.');
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
    selectedBooks: parsed.selectedBooks || [],
    fullySelectedBooks: parsed.fullySelectedBooks || [],
    selectedDocuments: parsed.selectedDocuments || [],
    downloadImages: parsed.downloadImages ?? true,
    downloadAttachments: parsed.downloadAttachments ?? true,
    incrementalExport: parsed.incrementalExport ?? true,
    encryptedBlockPasswords,
    encryptedBlockPassword: encryptedBlockPasswords[0] || parsed.encryptedBlockPassword || '',
    complexBlockMode: parsed.complexBlockMode || 'snapshot-first',
    assetLayout: parsed.assetLayout || 'book_assets',
    jobControlPath: parsed.jobControlPath || '',
  };
}

async function main() {
  const command = process.argv[2];
  const config = readConfig();

  switch (command) {
    case 'login': {
      const result = await runManualLogin(config, emit);
      emit({ type: 'result', status: 'success', ...result });
      break;
    }
    case 'scan': {
      const books = await scanBooks(config);
      emit({ type: 'result', status: 'success', books });
      break;
    }
    case 'whoami': {
      const user = await fetchCurrentUser(createHttpClient(config.cookiePath));
      emit({ type: 'result', status: 'success', loggedIn: true, user });
      break;
    }
    case 'export':
      await exportBooks(config, emit);
      break;
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

main().catch((error) => {
  emit({
    type: 'result',
    status: 'error',
    error: error.message,
    stack: error.stack,
  });
  process.exitCode = 1;
});
