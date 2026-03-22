import path from 'path';
import { exportBooks } from './src/export.js';
import { ensureDir } from './src/utils.js';

async function run() {
  const outputDir = ensureDir(process.env.EXPORT_PATH || path.join(process.cwd(), 'output'));
  const config = {
    browserPath: process.env.BROWSER_PATH || '',
    cookiePath: process.env.COOKIE_PATH || path.join(process.cwd(), 'cookies.json'),
    outputDir,
    selectedBooks: [],
    downloadImages: process.env.DOWNLOAD_IMAGES !== 'false',
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS !== 'false',
    complexBlockMode: 'snapshot-first',
    assetLayout: 'book_assets',
  };

  await exportBooks(config, (event) => {
    if (event.type === 'progress' && event.message) {
      console.log(event.message);
    }
    if (event.type === 'result' && event.status === 'success') {
      console.log(`Export finished. Failure CSV: ${event.latestFailureCsv}`);
    }
  });
}

run();
