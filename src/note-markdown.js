/**
 * 小记正文是来自远端的非受信任内容。此模块只做纯转换，不访问网络或浏览器，
 * 便于在导出前稳定测试；HTML 仅覆盖已验证的常用标签。
 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'source', 'meta', 'link', 'input']);
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 's', 'strike', 'del', 'code', 'span', 'u', 'mark', 'small', 'sub', 'sup', 'br']);
const KNOWN_TAGS = new Set([
  ...INLINE_TAGS,
  ...VOID_TAGS,
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
]);

/**
 * 小记列表的 abstract 实际是缩略的 Lake/HTML 源码，不能直接当标题显示或写进文件名。
 * 这里只提取可见文字，不改原文；没有可见文字时由调用方按图片/附件兜底命名。
 */
export function extractNoteSummary(value, limit = 200) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let text;
  if (raw.startsWith('<')) {
    text = collectVisibleText(parseHtml(raw));
  } else {
    // 少数摘要可能是普通文本或 Markdown；去掉可能残留的内联标签。
    text = raw.replace(/<[^>]*>/gu, ' ');
  }
  text = text.replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, limit).join('').trim();
}

function collectVisibleText(node) {
  if (node.type === 'text') return String(node.value ?? '');
  const children = (node.children || []).map(collectVisibleText).join(' ');
  // 块级元素之间补空格，避免两段文字黏连成一个词。
  return node.type === 'element' && KNOWN_TAGS.has(node.tag) ? ` ${children} ` : children;
}

/**
 * 优先返回服务端已经给出的 Markdown。HTML 是降级路径；Lake 原文不会被臆测为 Markdown，
 * 当 HTML 出现未知 Lake 块时连同不完整标志交给后续导出器保存。
 */
export function convertNoteToMarkdown(note = {}) {
  const warnings = [];
  if (note.fullContentAvailable === false) {
    warnings.push('未取得完整正文，不能将摘要当作全文导出。');
  }

  const format = String(note.bodyFormat ?? note.format ?? '').trim().toLowerCase();
  const body = String(note.body ?? '');
  if (body && (format === 'markdown' || format === 'md')) {
    return compactResult({ markdown: normalizeMarkdown(body), warnings, incomplete: warnings.length > 0 });
  }

  const html = String(note.html ?? '');
  if (html.trim()) {
    const parsed = htmlToMarkdown(html, warnings);
    return compactResult({
      markdown: parsed.markdown,
      warnings,
      incomplete: warnings.length > 0,
      ...(warnings.length > 0 && note.rawSource != null ? { rawSource: note.rawSource } : {}),
    });
  }

  warnings.push('小记没有可转换的完整 Markdown 或 HTML 正文。');
  return compactResult({
    markdown: '',
    warnings,
    incomplete: true,
    ...(note.rawSource != null ? { rawSource: note.rawSource } : {}),
  });
}

/** 将元信息写为 JSON 风格 YAML 标量，避免标题或标签突破 frontmatter 边界。 */
export function renderNoteMarkdown(note = {}, markdown = '') {
  const tags = Array.isArray(note.tags) ? note.tags : [];
  const lines = [
    '---',
    `title: ${yamlString(note.summary || '未命名小记')}`,
    `yuque_note_key: ${yamlString(note.documentKey || '')}`,
    `yuque_note_id: ${yamlString(note.noteId || '')}`,
    `yuque_account_scope: ${yamlString(note.accountScope || '')}`,
    `source_url: ${yamlString(note.canonicalUrl || '')}`,
    `created_at: ${yamlString(note.createdAt || '')}`,
    `updated_at: ${yamlString(note.updatedAt || '')}`,
    'tags:',
    ...tags.map((tag) => `  - ${yamlString(tag)}`),
    '---',
  ];
  return `${lines.join('\n')}\n\n${String(markdown ?? '').replace(/^\n+/, '')}`;
}

function compactResult(result) {
  return {
    markdown: String(result.markdown ?? '').trim(),
    warnings: result.warnings,
    incomplete: Boolean(result.incomplete),
    ...(Object.prototype.hasOwnProperty.call(result, 'rawSource') ? { rawSource: result.rawSource } : {}),
  };
}

function yamlString(value) {
  // JSON 字符串也是 YAML 合法的双引号标量，并会转义引号、换行和控制符。
  return JSON.stringify(String(value ?? ''));
}

function normalizeMarkdown(value) {
  return String(value).replace(/\r\n?/g, '\n').trim();
}

function htmlToMarkdown(html, warnings) {
  const tree = parseHtml(html);
  const unknown = new Set();
  const context = { warnings, unknown };
  const markdown = renderChildren(tree.children, context, { block: true }).replace(/\n{3,}/g, '\n\n').trim();
  return { markdown };
}

/** 仅解析受控子集，不能执行脚本、加载资源或调用浏览器。 */
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const tokens = String(html).match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) {
      stack.at(-1).children.push({ type: 'text', value: decodeEntities(token) });
      continue;
    }
    const close = token.match(/^<\s*\/\s*([\w:-]+)/u);
    if (close) {
      const name = close[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const open = token.match(/^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/u);
    if (!open) continue;
    const tag = open[1].toLowerCase();
    const node = { type: 'element', tag, attrs: parseAttributes(open[2]), children: [] };
    stack.at(-1).children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/u.test(token)) stack.push(node);
  }
  return root;
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of String(source).matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function renderChildren(children, context, options = {}) {
  return children.map((node) => renderNode(node, context, options)).join('');
}

function renderNode(node, context, options = {}) {
  // 代码块必须保留换行和空格，普通 HTML 文本则折叠浏览器布局空白。
  if (node.type === 'text') return options.inPre ? String(node.value ?? '') : normalizeText(node.value);
  const { tag, attrs, children } = node;
  const inner = () => renderChildren(children, context, { block: false, inPre: options.inPre });
  // Lake 有时把卡片落在普通 div/span 上，不能因标签本身受支持就宣称内容完整。
  const cardKind = attrs['data-card-type'] || attrs['data-card-key'] || attrs['data-card-name']
    || (/^(?:card|image|file|attachment|video|audio)$/iu.test(attrs['data-type'] || '') && attrs['data-type']);
  if (cardKind && KNOWN_TAGS.has(tag)) {
    markUnknown('card', context);
    const visible = inner().trim();
    return `${visible}${visible ? '\n\n' : ''}> 注：小记转换不完整：未支持的内容块 card。\n\n`;
  }
  if (!KNOWN_TAGS.has(tag)) {
    markUnknown(tag, context);
    const visible = inner().trim();
    return `${visible}${visible ? '\n\n' : ''}> 注：小记转换不完整：未支持的内容块 ${tag}。\n\n`;
  }
  if (tag === 'input') {
    // checked 是 HTML 布尔属性，存在即表示勾选，不能用属性字符串的真值判断。
    if (String(attrs.type || '').toLowerCase() === 'checkbox') {
      return `${Object.prototype.hasOwnProperty.call(attrs, 'checked') ? '[x]' : '[ ]'} `;
    }
    markUnknown('input', context);
    return attrs.value || '> 注：小记转换不完整：未支持的内容块 input。';
  }
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n\n---\n\n';
  if (tag === 'img') return renderImage(attrs, context);
  if (tag === 'a') return renderLink(inner(), attrs.href, context);
  if (tag === 'strong' || tag === 'b') return `**${inner().trim()}**`;
  if (tag === 'em' || tag === 'i') return `*${inner().trim()}*`;
  if (tag === 's' || tag === 'strike' || tag === 'del') return `~~${inner().trim()}~~`;
  if (tag === 'code') return options.inPre ? inner() : `\`${inner().trim().replace(/`/g, '\\`')}\``;
  if (tag === 'pre') {
    const code = findFirst(children, 'code');
    const language = String(code?.attrs?.class || '').match(/(?:language|lang)-([\w+-]+)/u)?.[1] || '';
    const content = renderChildren(code?.children || children, context, { inPre: true }).replace(/^\n|\n$/g, '');
    return `\n\n\`\`\`${language}\n${content}\n\`\`\`\n\n`;
  }
  if (/^h[1-6]$/u.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`;
  if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'header' || tag === 'footer') return `\n\n${inner().trim()}\n\n`;
  if (tag === 'blockquote') return `\n\n${inner().trim().split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}\n\n`;
  if (tag === 'ul' || tag === 'ol') return renderList(node, context, options.listDepth || 0);
  if (tag === 'li') return inner();
  if (tag === 'table') return renderTable(node, context);
  if (tag === 'caption') return `\n\n${inner().trim()}\n`;
  return inner();
}

function renderLink(label, href, context) {
  const text = label.trim() || '链接';
  const safe = safeUrl(href);
  if (!safe) {
    markUnsafeLink(context);
    return text;
  }
  return `[${text}](${safe.replace(/[()]/g, (character) => character === '(' ? '%28' : '%29')})`;
}

function renderImage(attrs, context) {
  const safe = safeUrl(attrs.src);
  const alt = String(attrs.alt || '').replace(/[\[\]]/g, '\\$&');
  if (!safe) {
    markUnsafeLink(context);
    return alt || '图片（不安全地址未导出）';
  }
  return `![${alt}](${safe.replace(/[()]/g, (character) => character === '(' ? '%28' : '%29')})`;
}

function renderList(node, context, depth) {
  const ordered = node.tag === 'ol';
  const lines = [];
  let number = 1;
  for (const child of node.children.filter((item) => item.type === 'element' && item.tag === 'li')) {
    const direct = child.children.filter((item) => item.type !== 'element' || (item.tag !== 'ul' && item.tag !== 'ol'));
    const nested = child.children.filter((item) => item.type === 'element' && (item.tag === 'ul' || item.tag === 'ol'));
    const marker = ordered ? `${number}.` : '-';
    number += 1;
    const content = renderChildren(direct, context).trim().replace(/\n+/g, ' ');
    lines.push(`${'  '.repeat(depth)}${marker} ${content}`.trimEnd());
    for (const list of nested) lines.push(renderList(list, context, depth + 1).replace(/^\n+|\n+$/g, ''));
  }
  return `\n\n${lines.join('\n')}\n\n`;
}

function renderTable(node, context) {
  // Markdown 表格不能表达跨行跨列。保留单元格文本，但必须提示降级并保全原文。
  const hasMergedCells = [...findAll(node, 'th'), ...findAll(node, 'td')]
    .some((cell) => Number(cell.attrs.rowspan || 1) > 1 || Number(cell.attrs.colspan || 1) > 1);
  if (hasMergedCells) markUnknown('table-merged-cells', context);
  const rows = findAll(node, 'tr').map((row) => row.children
    .filter((cell) => cell.type === 'element' && (cell.tag === 'th' || cell.tag === 'td'))
    .map((cell) => renderChildren(cell.children, context).replace(/\n+/g, ' ').trim().replace(/\|/g, '\\|'))
    .filter((cells) => cells.length > 0));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const header = [...rows[0], ...Array(Math.max(0, width - rows[0].length)).fill('')];
  const body = rows.slice(1).map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
  return `\n\n| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${body.map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`;
}

function findFirst(nodes, tag) {
  return nodes.find((node) => node.type === 'element' && node.tag === tag);
}

function findAll(node, tag, found = []) {
  for (const child of node.children || []) {
    if (child.type !== 'element') continue;
    if (child.tag === tag) found.push(child);
    findAll(child, tag, found);
  }
  return found;
}

function markUnknown(tag, context) {
  if (context.unknown.has(tag)) return;
  context.unknown.add(tag);
  context.warnings.push(`小记包含未支持的内容块 ${tag}，已保留可见文字并标记为不完整。`);
}

function markUnsafeLink(context) {
  if (!context.warnings.some((warning) => warning.includes('不安全链接'))) {
    context.warnings.push('小记包含不安全链接地址，已仅保留可见文字。');
  }
}

function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return /^https?:$/iu.test(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ');
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'");
}
