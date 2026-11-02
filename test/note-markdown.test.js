import assert from 'node:assert/strict';
import test from 'node:test';
import { convertNoteToMarkdown, renderNoteMarkdown } from '../src/note-markdown.js';
import { processMarkdown } from '../src/markdown.js';
import path from 'node:path';

function note(overrides = {}) {
  return {
    accountScope: 'account-1',
    noteId: '123456789',
    documentKey: 'yuque-note:account-1:123456789',
    createdAt: '2026-10-23T10:20:30+08:00',
    updatedAt: '2026-10-23T11:20:30+08:00',
    canonicalUrl: 'https://www.yuque.com/note/123456789',
    summary: '小记标题',
    tags: ['工作'],
    body: '',
    bodyFormat: 'lake',
    html: '',
    fullContentAvailable: true,
    rawSource: '{"type":"doc"}',
    ...overrides,
  };
}

test('优先原始 Markdown 正文，不额外进行 Lake 或 HTML 转换', () => {
  const result = convertNoteToMarkdown(note({
    bodyFormat: 'markdown',
    body: '# 标题\n\n正文',
    html: '<p>不应使用</p>',
  }));

  assert.equal(result.markdown, '# 标题\n\n正文');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.incomplete, false);
  assert.equal('rawSource' in result, false);
});

test('受控 HTML 转换覆盖常见段落、标题、列表、链接、图片、附件、表格、代码和引用', () => {
  const result = convertNoteToMarkdown(note({
    html: [
      '<h2>计划</h2><p>第一段 <strong>重点</strong> <a href="https://example.com/a">链接</a>。</p>',
      '<ul><li>项目<ul><li>子项</li></ul></li></ul>',
      '<p><img src="https://cdn.example.com/a.png" alt="示意图"></p>',
      '<p><a href="https://cdn.example.com/demo.pdf">附件</a></p>',
      '<blockquote><p>引用内容</p></blockquote>',
      '<pre><code class="language-js">const x = 1;\n</code></pre>',
      '<table><thead><tr><th>名称</th><th>数量</th></tr></thead><tbody><tr><td>A</td><td>2</td></tr></tbody></table>',
    ].join(''),
  }));

  assert.match(result.markdown, /^## 计划/m);
  assert.match(result.markdown, /第一段 \*\*重点\*\* \[链接\]\(https:\/\/example\.com\/a\)\u3002/);
  assert.match(result.markdown, /- 项目\n  - 子项/);
  assert.match(result.markdown, /!\[示意图\]\(https:\/\/cdn\.example\.com\/a\.png\)/);
  assert.match(result.markdown, /\[附件\]\(https:\/\/cdn\.example\.com\/demo\.pdf\)/);
  assert.match(result.markdown, /> 引用内容/);
  assert.match(result.markdown, /```js\nconst x = 1;\n```/);
  assert.match(result.markdown, /\| 名称 \| 数量 \|\n\| --- \| --- \|\n\| A \| 2 \|/);
  assert.equal(result.incomplete, false);
});

test('HTML图片和附件实际进入现有processMarkdown下载回调', async () => {
  const converted = convertNoteToMarkdown(note({
    html: '<div><p><img src="https://cdn.example.com/a.png" width="640" id="image-1" class="lake-image"></p><p><a href="https://cdn.example.com/demo.pdf">文件</a></p></div>',
  }));
  const calls = [];
  const rewritten = await processMarkdown(converted.markdown, {
    docName: '图片小记',
    targetMdPath: path.resolve('test-output', '小记', 'note.md'),
    options: { downloadImages: true, downloadAttachments: true },
    async downloadAsset(url, kind) {
      calls.push({ url, kind });
      return path.resolve('test-output', '小记', '_assets', kind === 'image' ? 'a.png' : 'demo.pdf');
    },
  });
  assert.deepEqual(calls, [
    { url: 'https://cdn.example.com/a.png', kind: 'image' },
    { url: 'https://cdn.example.com/demo.pdf', kind: 'file' },
  ]);
  assert.match(rewritten, /!\[\]\(_assets\/a\.png\)/);
  assert.match(rewritten, /\[文件\]\(_assets\/demo\.pdf\)/);
});

test('未知卡片不静默丢弃，保留可见文字并标记原始 Lake 内容待恢复', () => {
  const result = convertNoteToMarkdown(note({
    html: '<p>已知内容</p><lake-card data-card-type="mindmap">卡片文字</lake-card>',
    rawSource: '{"type":"card","cardType":"mindmap"}',
  }));

  assert.match(result.markdown, /已知内容/);
  assert.match(result.markdown, /卡片文字/);
  assert.match(result.markdown, /小记转换不完整：未支持的内容块 lake-card/);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.rawSource, '{"type":"card","cardType":"mindmap"}');
  assert.match(result.warnings.join('\n'), /lake-card/);
  const wrappedCard = convertNoteToMarkdown(note({ html: '<div data-card-type="mindmap">卡片</div>' }));
  assert.equal(wrappedCard.incomplete, true);
  assert.match(wrappedCard.markdown, /卡片/);
  assert.ok(wrappedCard.rawSource);
});

test('空壳卡片和资源容器不能被误报完整', () => {
  for (const html of [
    '<div data-type="card" data-value="opaque"></div>',
    '<span data-type="image" data-value="opaque"></span>',
  ]) {
    const result = convertNoteToMarkdown(note({ html }));
    assert.equal(result.incomplete, true);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.rawSource);
  }
});

test('简单合并单元格改用 HTML 表格保留结构，不再误报不完整', () => {
  const result = convertNoteToMarkdown(note({
    html: '<table><tr><td rowspan="2">合并单元格</td><td>A</td></tr><tr><td>B</td></tr></table>',
  }));
  assert.equal(result.incomplete, false);
  assert.match(result.markdown, /<table>/);
  assert.match(result.markdown, /rowspan="2"/);
  assert.match(result.markdown, /合并单元格/);
});

test('Lake 图片/书签卡片从 data URI 值恢复链接，不把正文丢成空壳', () => {
  const card = (name, value) => `<card type="${name === 'yuque' ? 'block' : 'inline'}" name="${name}" value="data:${encodeURIComponent(JSON.stringify(value))}"/>`;
  const image = convertNoteToMarkdown(note({
    html: `<p>${card('image', { src: 'https://cdn.example.com/card.png' })}</p>`,
  }));
  assert.equal(image.incomplete, false);
  assert.match(image.markdown, /!\[\]\(https:\/\/cdn\.example\.com\/card\.png\)/);

  const bookmark = convertNoteToMarkdown(note({
    html: `<p>${card('bookmarklink', { src: 'https://example.com/site', text: '示例站点' })}</p>`,
  }));
  assert.equal(bookmark.incomplete, false);
  assert.match(bookmark.markdown, /\[示例站点\]\(https:\/\/example\.com\/site\)/);
});

test('语雀文档卡片占位文字变成可点击名称，站内相对链接不被误判不安全', () => {
  const source = '<card type="block" name="yuque" value="data:%7B%22src%22%3A%22https%3A%2F%2Fwww.yuque.com%2Fdocs%2Fshare%2Fabc%22%7D"/>';
  const result = convertNoteToMarkdown(note({
    html: '<p>此处为语雀内容卡片，点击链接查看：<a href="https://www.yuque.com/docs/share/abc">https://www.yuque.com/docs/share/abc</a></p><p><a href="/docs/share/xyz">站内链接</a></p>',
    rawSource: source,
  }));
  assert.equal(result.incomplete, false);
  assert.match(result.markdown, /\[语雀内容卡片\]\(https:\/\/www\.yuque\.com\/docs\/share\/abc\)/);
  assert.match(result.markdown, /\[站内链接\]\(https:\/\/www\.yuque\.com\/docs\/share\/xyz\)/);
  assert.doesNotMatch(result.markdown, /此处为语雀内容卡片，点击链接查看/);
});

test('协议相对外链补 https，不会误拼成语雀站内链接', () => {
  const result = convertNoteToMarkdown(note({
    html: '<p><a href="//www.zhihu.com/people/demo">知乎用户</a></p>',
  }));
  assert.equal(result.incomplete, false);
  assert.match(result.markdown, /\[知乎用户\]\(https:\/\/www\.zhihu\.com\/people\/demo\)/);
  assert.doesNotMatch(result.markdown, /yuque\.com\/\/www\.zhihu/);
});

test('HTML checkbox保留已完成和未完成状态，其他input显式不完整', () => {
  const result = convertNoteToMarkdown(note({ html: '<ul><li><input type="checkbox" checked>完成</li><li><input type="checkbox">待办</li></ul>' }));
  assert.match(result.markdown, /- \[x\] 完成\n- \[ \] 待办/);
  assert.equal(result.incomplete, false);
  const unsupported = convertNoteToMarkdown(note({ html: '<input type="text" value="不可丢弃">' }));
  assert.equal(unsupported.incomplete, true);
  assert.match(unsupported.markdown, /不可丢弃/);
});

test('空正文、不可用全文和不安全链接都明确标记不完整', () => {
  const unavailable = convertNoteToMarkdown(note({ fullContentAvailable: false }));
  assert.equal(unavailable.incomplete, true);
  assert.match(unavailable.warnings.join('\n'), /未取得完整正文/);

  const unsafe = convertNoteToMarkdown(note({ html: '<p><a href="javascript:alert(1)">危险链接</a></p>' }));
  assert.equal(unsafe.incomplete, true);
  assert.match(unsafe.markdown, /危险链接/);
  assert.match(unsafe.warnings.join('\n'), /不安全链接/);
});

test('安全 frontmatter 使用 JSON 标量转义换行、引号、冒号和井号', () => {
  const rendered = renderNoteMarkdown(note({
    summary: '标题\n---\n# 伪造属性: true',
    tags: ['#标签: 一\n二', '"引号"'],
    canonicalUrl: 'https://example.com/a?x=1',
  }), '正文');

  assert.match(rendered, /^---\ntitle: "标题\\n---\\n# 伪造属性: true"/);
  assert.match(rendered, /tags:\n  - "#标签: 一\\n二"\n  - "\\\"引号\\\""/);
  assert.match(rendered, /yuque_note_key: "yuque-note:account-1:123456789"/);
  assert.match(rendered, /\n---\n\n正文$/);
});
