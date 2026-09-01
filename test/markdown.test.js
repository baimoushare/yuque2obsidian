import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeYuqueCalloutBlocks, normalizeYuqueMarkdownStructure, processMarkdown, rewriteInternalLink } from '../src/markdown.js';

function createDocLinkIndex(entries, exportRoot = path.join('vault')) {
  const exact = new Map();
  const pathname = new Map();
  const bookDoc = new Map();
  const docSlug = new Map();

  for (const entry of entries) {
    if (entry.exactKey) {
      exact.set(entry.exactKey, [entry.target]);
    }
    if (entry.pathnameKey) {
      pathname.set(entry.pathnameKey, [entry.target]);
    }
    if (entry.bookDocKey) {
      bookDoc.set(entry.bookDocKey, [entry.target]);
    }
    if (entry.docSlugKey) {
      docSlug.set(entry.docSlugKey, [entry.target]);
    }
  }

  return {
    exact,
    pathname,
    bookDoc,
    docSlug,
    exportRoot,
  };
}

test('rewriteInternalLink maps exported yuque docs to obsidian wikilinks', () => {
  const index = createDocLinkIndex([
    {
      exactKey: 'https://www.yuque.com/demo/book/doc-a',
      pathnameKey: '/demo/book/doc-a',
      bookDocKey: 'book/doc-a',
      docSlugKey: 'doc-a',
      target: path.join('vault', 'Book', 'Doc A.md'),
    },
  ]);
  const value = rewriteInternalLink(
    'https://www.yuque.com/demo/book/doc-a',
    index,
    path.join('vault', 'Book', 'Folder', 'Doc B.md'),
    {
      exportRoot: path.join('vault'),
      linkText: '文档 A',
    },
  );

  assert.equal(value, '[[Book/Doc A|文档 A]]');
});

test('rewriteInternalLink falls back to unique book/doc and doc slug matches across yuque user aliases', () => {
  const index = createDocLinkIndex([
    {
      exactKey: 'https://www.yuque.com/baimoushare/ir0xet/hhellbvu5kqnyh91',
      pathnameKey: '/baimoushare/ir0xet/hhellbvu5kqnyh91',
      bookDocKey: 'ir0xet/hhellbvu5kqnyh91',
      docSlugKey: 'hhellbvu5kqnyh91',
      target: path.join('vault', '技术笔记', '基础理论', '三维基础', '贴近摄影测量技术.md'),
    },
  ]);

  const value = rewriteInternalLink(
    'https://www.yuque.com/baimoubiji/ir0xet/hhellbvu5kqnyh91?singleDoc#',
    index,
    path.join('vault', '职业工作', '项目相关', '10.高庙古建三维.md'),
    {
      exportRoot: path.join('vault'),
      linkText: '贴近摄影测量技术',
    },
  );

  assert.equal(value, '[[技术笔记/基础理论/三维基础/贴近摄影测量技术|贴近摄影测量技术]]');
});

test('rewriteInternalLink keeps external links when yuque anchors cannot be mapped safely', () => {
  const index = createDocLinkIndex([
    {
      exactKey: 'https://www.yuque.com/demo/book/doc-a',
      pathnameKey: '/demo/book/doc-a',
      bookDocKey: 'book/doc-a',
      docSlugKey: 'doc-a',
      target: path.join('vault', 'Book', 'Doc A.md'),
    },
  ]);

  const value = rewriteInternalLink(
    'https://www.yuque.com/demo/book/doc-a#section-1',
    index,
    path.join('vault', 'Book', 'Doc B.md'),
    {
      exportRoot: path.join('vault'),
      linkText: '文档 A',
    },
  );

  assert.equal(value, null);
});

test('processMarkdown rewrites image and attachment links to relative assets', async () => {
  const markdown = ['![\u56fe\u7247](https://cdn.example.com/path/demo.png)', '[\u9644\u4ef6](https://cdn.example.com/path/demo.pdf)'].join(
    '\n',
  );

  const rewritten = await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset(url, kind) {
      if (kind === 'image') {
        return path.join('vault', 'Book', '_assets', 'images', 'demo.png');
      }
      return path.join('vault', 'Book', '_assets', 'files', 'demo.pdf');
    },
  });

  assert.match(rewritten, /!\[\u56fe\u7247\]\(_assets\/images\/demo\.png\)/);
  assert.match(rewritten, /\[\u9644\u4ef6\]\(_assets\/files\/demo\.pdf\)/);
});

test('processMarkdown embeds downloaded audio and video attachments inline', async () => {
  const markdown = ['[\u89c6\u9891](https://cdn.example.com/path/demo.mp4)', '[\u97f3\u9891](https://cdn.example.com/path/demo.mp3)'].join('\n');

  const rewritten = await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset(url) {
      if (url.endsWith('.mp4')) {
        return path.join('vault', 'Book', '_assets', 'files', 'demo.mp4');
      }
      return path.join('vault', 'Book', '_assets', 'files', 'demo.mp3');
    },
  });

  assert.match(rewritten, /!\[\u89c6\u9891\]\(_assets\/files\/demo\.mp4\)/);
  assert.match(rewritten, /!\[\u97f3\u9891\]\(_assets\/files\/demo\.mp3\)/);
});

test('processMarkdown replaces failed images with inline notes while keeping failed attachments remote', async () => {
  const markdown = ['![\u56fe\u7247](https://cdn.example.com/path/demo.png)', '[\u9644\u4ef6](https://cdn.example.com/path/demo.pdf)'].join(
    '\n',
  );

  const rewritten = await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset() {
      return null;
    },
  });

  assert.match(
    rewritten,
    /> 注：图片“图片”未能可靠导出到本地，请查看原图：\[原图链接\]\(https:\/\/cdn\.example\.com\/path\/demo\.png\)/,
  );
  assert.match(rewritten, /\[\u9644\u4ef6\]\(https:\/\/cdn\.example\.com\/path\/demo\.pdf\)/);
});

test('processMarkdown replaces failed images without alt text with a generic inline note', async () => {
  const markdown = '![](https://cdn.example.com/path/demo.png)';

  const rewritten = await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset() {
      return null;
    },
  });

  assert.match(
    rewritten,
    /> 注：这张图片未能可靠导出到本地，请查看原图：\[原图链接\]\(https:\/\/cdn\.example\.com\/path\/demo\.png\)/,
  );
});

test('processMarkdown passes image occurrence metadata to the downloader', async () => {
  const markdown = ['![图1](https://cdn.example.com/path/one.png)', '![图2](https://cdn.example.com/path/two.png)'].join('\n');
  const calls = [];

  await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset(url, kind, options = {}) {
      calls.push({ url, kind, options });
      return null;
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'image');
  assert.equal(calls[0].options.imageOccurrence, 0);
  assert.equal(calls[0].options.assetAlt, '图1');
  assert.equal(calls[1].options.imageOccurrence, 1);
  assert.equal(calls[1].options.assetAlt, '图2');
});

test('normalizeYuqueCalloutBlocks converts Yuque highlight blocks to Obsidian callouts', () => {
  const markdown = [
    '导语',
    '',
    ':::info',
    '我变得自信有趣，',
    '',
    '允许别人踏入我的生活，',
    ':::',
    '',
    ':::warning 注意下雨 :::',
  ].join('\n');

  const normalized = normalizeYuqueCalloutBlocks(markdown);

  assert.match(normalized, /> \[!info\]\n> 我变得自信有趣，\n>\n> 允许别人踏入我的生活，/);
  assert.match(normalized, /> \[!warning\]\n> 注意下雨/);
});

test('normalizeYuqueCalloutBlocks falls back to plain blockquotes for unknown Yuque block types', () => {
  const markdown = [':::glk', '只保留引用兜底', ':::'].join('\n');

  const normalized = normalizeYuqueCalloutBlocks(markdown);

  assert.equal(normalized, ['> 只保留引用兜底'].join('\n'));
});

test('normalizeYuqueCalloutBlocks leaves code fences unchanged', () => {
  const markdown = ['```md', ':::info', '示例语法', ':::', '```'].join('\n');

  const normalized = normalizeYuqueCalloutBlocks(markdown);

  assert.equal(normalized, markdown);
});

test('normalizeYuqueMarkdownStructure carries broken bullet fragments into the next label', () => {
  const markdown = [
    '\u00b7OpenAI ChatGPT:[https://chatgpt.com/\u00b7Google](https://chatgpt.com/\u00b7Google)',
    'Gemini:[https://gemini.google.com/\u00b7Anthropic](https://gemini.google.com/\u00b7Anthropic)',
    'Claude:[https://claude.ai/](https://claude.ai/)',
  ].join('\n');

  const normalized = normalizeYuqueMarkdownStructure(markdown);

  assert.match(normalized, /\u00b7OpenAI ChatGPT:\[https:\/\/chatgpt\.com\/]\(https:\/\/chatgpt\.com\/\)/);
  assert.match(normalized, /\u00b7Google Gemini:\[https:\/\/gemini\.google\.com\/]\(https:\/\/gemini\.google\.com\/\)/);
  assert.match(normalized, /\u00b7Anthropic Claude:\[https:\/\/claude\.ai\/]\(https:\/\/claude\.ai\/\)/);
});

test('normalizeYuqueMarkdownStructure splits collapsed adjacent list items after links', () => {
  const markdown =
    '\u25cf\u963f\u91cc\u901a\u4e49\u5343\u95ee\u00b7\u56fd\u5185\uff1a[https://tongyi.aliyun.com/qianwen/](https://tongyi.aliyun.com/qianwen/)\u25cf\u6d77\u5916\uff1a[https://chat.qwen.ai/](https://chat.qwen.ai/)';

  const normalized = normalizeYuqueMarkdownStructure(markdown);
  const lines = normalized.split('\n');

  assert.equal(lines.length, 2);
  assert.match(lines[0], /\u963f\u91cc\u901a\u4e49\u5343\u95ee/);
  assert.match(lines[1], /\u6d77\u5916/);
});

test('normalizeYuqueMarkdownStructure repairs chained malformed links from a collapsed run', () => {
  const markdown = [
    '\u25cf\u767e\u5ea6\u6587\u5fc3\u4e00\u8a00\uff1a[https://yiyan.baidu.com/\u00b7Mistral(](https://yiyan.baidu.com/\u00b7Mistral()\u6cd5\u56fd):[https://mistral.ai/\u00b7Seed](https://mistral.ai/\u00b7Seed)',
    'Diffusion Preview:[https://seed.bytedance.com/zh/seed_diffusion](https://seed.bytedance.com/zh/seed_diffusion)',
  ].join('\n');

  const normalized = normalizeYuqueMarkdownStructure(markdown);

  assert.match(normalized, /\u25cf\u767e\u5ea6\u6587\u5fc3\u4e00\u8a00\uff1a\[https:\/\/yiyan\.baidu\.com\/]\(https:\/\/yiyan\.baidu\.com\/\)/);
  assert.match(normalized, /\u00b7Mistral\(\u6cd5\u56fd\):\[https:\/\/mistral\.ai\/]\(https:\/\/mistral\.ai\/\)/);
  assert.match(
    normalized,
    /\u00b7Seed Diffusion Preview:\[https:\/\/seed\.bytedance\.com\/zh\/seed_diffusion]\(https:\/\/seed\.bytedance\.com\/zh\/seed_diffusion\)/,
  );
});

test('normalizeYuqueMarkdownStructure expands plain label-url runs into separate markdown links', () => {
  const markdown =
    '\u25cf\u672c\u5730\u90e8\u7f72\u00b7 Ollama:https://ollama.com/\u00b7LM Studio:https://lmstudio.ai/\u00b7Cherry Studio:https://www.cherry-ai.com/';

  const normalized = normalizeYuqueMarkdownStructure(markdown);

  assert.match(normalized, /^\u25cf\u672c\u5730\u90e8\u7f72/m);
  assert.match(normalized, /\u00b7 Ollama:\[https:\/\/ollama\.com\/]\(https:\/\/ollama\.com\/\)/);
  assert.match(normalized, /\u00b7LM Studio:\[https:\/\/lmstudio\.ai\/]\(https:\/\/lmstudio\.ai\/\)/);
  assert.match(normalized, /\u00b7Cherry Studio:\[https:\/\/www\.cherry-ai\.com\/]\(https:\/\/www\.cherry-ai\.com\/\)/);
});

test('normalizeYuqueMarkdownStructure splits a section heading from the first inline bullet link', () => {
  const markdown = '\u25cf\u672c\u5730\u90e8\u7f72\u00b7 Ollama:[https://ollama.com/](https://ollama.com/)';
  const normalized = normalizeYuqueMarkdownStructure(markdown);
  const lines = normalized.split('\n');

  assert.equal(lines[0], '\u25cf\u672c\u5730\u90e8\u7f72');
  assert.equal(lines[1], '\u00b7 Ollama:[https://ollama.com/](https://ollama.com/)');
});

test('processMarkdown keeps external html document links as plain links', async () => {
  const markdown = '[\u76ee\u5f55](https://example.com/article.html#section)';
  let downloadCalls = 0;

  const rewritten = await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset() {
      downloadCalls += 1;
      return path.join('vault', 'Book', '_assets', 'files', 'article.html');
    },
  });

  assert.equal(downloadCalls, 0);
  assert.equal(rewritten, markdown);
});

test('processMarkdown keeps html_online links with anchors as plain links', async () => {
  const markdown =
    '[\u76ee\u5f55](https://hahaha.fmy1024.cn/html_online/2340_104476953online.html#4.2.2%20section)';
  let downloadCalls = 0;

  const rewritten = await processMarkdown(markdown, {
    docName: 'Demo',
    targetMdPath: path.join('vault', 'Book', 'Doc.md'),
    docLinkMap: createDocLinkIndex([]),
    options: {
      downloadImages: true,
      downloadAttachments: true,
    },
    async downloadAsset() {
      downloadCalls += 1;
      return path.join('vault', 'Book', '_assets', 'files', 'index.html');
    },
  });

  assert.equal(downloadCalls, 0);
  assert.equal(rewritten, markdown);
});

test('normalizeYuqueMarkdownStructure normalizes spaced bold markers', () => {
  const markdown =
    '\u60f3\u5fc5\u4f60\u80af\u5b9a\u4f1a\u95ee\u6211\u4e00\u4e2a ** \u95ee\u9898 ** \uff0c\u540e\u9762\u662f ** MeshData ** \uff0c\u8fd8\u6709 **<font style="color:#f33b45;"> \u4e09\u68f1\u9525 </font>** \u3002';

  const normalized = normalizeYuqueMarkdownStructure(markdown);

  assert.equal(
    normalized,
    '\u60f3\u5fc5\u4f60\u80af\u5b9a\u4f1a\u95ee\u6211\u4e00\u4e2a **\u95ee\u9898** \uff0c\u540e\u9762\u662f **MeshData** \uff0c\u8fd8\u6709 **<font style="color:#f33b45;">\u4e09\u68f1\u9525</font>** \u3002',
  );
});

test('normalizeYuqueMarkdownStructure keeps spaced bold markers inside code fences unchanged', () => {
  const markdown = ['```cpp', 'auto text = "** MeshData **";', '```', '', '** \u95ee\u9898 **'].join('\n');

  const normalized = normalizeYuqueMarkdownStructure(markdown);
  const lines = normalized.split('\n');

  assert.equal(lines[1], 'auto text = "** MeshData **";');
  assert.equal(lines[4], '**\u95ee\u9898**');
});

test('normalizeYuqueMarkdownStructure escapes literal wildcard asterisks inside quotes', () => {
  const markdown =
    '\u901a\u914d\u7b26 \u201c*\u201d \u8868\u793a\u4efb\u610f\u591a\u4e2a\u5b57\u7b26\uff0cVLOOKUP \u51fd\u6570\u7b2c\u4e00\u53c2\u6570\u4f7f\u7528 $G2&"*" \u3002';

  const normalized = normalizeYuqueMarkdownStructure(markdown);

  assert.equal(
    normalized,
    '\u901a\u914d\u7b26 \u201c\\*\u201d \u8868\u793a\u4efb\u610f\u591a\u4e2a\u5b57\u7b26\uff0cVLOOKUP \u51fd\u6570\u7b2c\u4e00\u53c2\u6570\u4f7f\u7528 $G2&"\\*" \u3002',
  );
});

test('normalizeYuqueMarkdownStructure keeps quoted literal asterisks inside code fences unchanged', () => {
  const markdown = [
    '```txt',
    '\u901a\u914d\u7b26 \u201c*\u201d \u548c $G2&"*" \u4fdd\u6301\u539f\u6837',
    '```',
    '',
    '\u901a\u914d\u7b26 \u201c*\u201d',
  ].join('\n');

  const normalized = normalizeYuqueMarkdownStructure(markdown);
  const lines = normalized.split('\n');

  assert.equal(lines[1], '\u901a\u914d\u7b26 \u201c*\u201d \u548c $G2&"*" \u4fdd\u6301\u539f\u6837');
  assert.equal(lines[4], '\u901a\u914d\u7b26 \u201c\\*\u201d');
});
