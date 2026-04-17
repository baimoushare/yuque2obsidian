import { stripHtml } from './utils.js';

const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const EMBEDDED_BOARD_CARD_RE = /<card[^>]*name="board"[^>]*value="([^"]+)"/gi;
const DEFAULT_BOARD_TITLE = '\u601d\u7ef4\u5bfc\u56fe';
const DEFAULT_NODE_TEXT = '\u672a\u547d\u540d\u8282\u70b9';

export function extractBoardsFromDocDetail(docDetail = {}) {
  const content = typeof docDetail?.content === 'string' ? docDetail.content : '';
  if (isBoardDocument(docDetail)) {
    const parsed = parseBoardDocumentContent(content);
    return parsed?.diagramData
      ? [
          {
            index: 0,
            sourceType: 'board-document',
            title: String(docDetail?.title || DEFAULT_BOARD_TITLE),
            diagramData: parsed.diagramData,
            rawValue: content,
          },
        ]
      : [];
  }

  const boards = [];
  let match;
  while ((match = EMBEDDED_BOARD_CARD_RE.exec(content))) {
    const rawValue = match[1];
    const parsed = parseEmbeddedBoardValue(rawValue);
    if (!parsed?.diagramData) {
      continue;
    }
    boards.push({
      index: boards.length,
      sourceType: 'embedded-card',
      title: `${DEFAULT_BOARD_TITLE} ${boards.length + 1}`,
      diagramData: parsed.diagramData,
      rawValue,
    });
  }

  return boards;
}

export function isBoardDocument(docDetail = {}) {
  return docDetail?.type === 'Board' || docDetail?.format === 'lakeboard';
}

export function parseBoardDocumentContent(content) {
  const source = String(content ?? '').trim();
  if (!source) {
    return null;
  }

  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function parseEmbeddedBoardValue(rawValue) {
  const source = String(rawValue ?? '').trim();
  if (!source.startsWith('data:')) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(source.slice(5)));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function analyzeMindmapDiagram(diagramData) {
  if (!diagramData || !Array.isArray(diagramData.body) || diagramData.body.length === 0) {
    return { isPureMindmap: false, reason: 'missing-body', roots: [] };
  }

  const state = { invalidReason: '' };
  const roots = [];

  for (const entry of diagramData.body) {
    const entryType = String(entry?.type ?? '').trim().toLowerCase();
    if (entryType === 'line') {
      continue;
    }

    const root = normalizeMindmapNode(entry, state, { requireMindmapType: true });
    if (state.invalidReason) {
      return { isPureMindmap: false, reason: state.invalidReason, roots: [] };
    }
    if (root) {
      roots.push(root);
    }
  }

  if (roots.length === 0) {
    return { isPureMindmap: false, reason: 'empty-roots', roots: [] };
  }

  return { isPureMindmap: true, reason: '', roots };
}

export function analyzeFlowchartDiagram(diagramData) {
  if (!diagramData || !Array.isArray(diagramData.body) || diagramData.body.length === 0) {
    return buildFlowchartResult(false, 'missing-body');
  }

  const nodes = [];
  const nodeBySourceId = new Map();
  const lineEntries = [];
  let ignoredElementCount = 0;
  let geometryCount = 0;
  let lineCount = 0;
  let invalidLineCount = 0;

  for (const entry of diagramData.body) {
    const entryType = String(entry?.type ?? '').trim().toLowerCase();
    if (entryType === 'geometry') {
      geometryCount += 1;
      const node = normalizeFlowchartNode(entry, nodes.length + 1);
      if (!node || nodeBySourceId.has(node.id)) {
        ignoredElementCount += 1;
        continue;
      }
      nodes.push(node);
      nodeBySourceId.set(node.id, node);
      continue;
    }

    if (entryType === 'line') {
      lineCount += 1;
      lineEntries.push(entry);
      continue;
    }

    ignoredElementCount += 1;
  }

  if (geometryCount === 0 && lineCount === 0) {
    return buildFlowchartResult(false, 'unsupported-board-structure', {
      ignoredElementCount,
    });
  }

  if (nodes.length === 0) {
    return buildFlowchartResult(false, geometryCount > 0 ? 'no-connectable-nodes' : 'unsupported-board-structure', {
      ignoredElementCount,
    });
  }

  const edges = [];
  for (const entry of lineEntries) {
    const sourceId = String(entry?.source?.id ?? '').trim();
    const targetId = String(entry?.target?.id ?? '').trim();
    if (!sourceId || !targetId || !nodeBySourceId.has(sourceId) || !nodeBySourceId.has(targetId)) {
      invalidLineCount += 1;
      ignoredElementCount += 1;
      continue;
    }

    edges.push({
      sourceId,
      targetId,
    });
  }

  if (nodes.length < 2) {
    return buildFlowchartResult(false, 'insufficient-flow-graph', {
      nodes,
      ignoredElementCount,
    });
  }

  if (edges.length === 0) {
    return buildFlowchartResult(false, invalidLineCount > 0 ? 'invalid-line-endpoints' : 'insufficient-flow-graph', {
      nodes,
      ignoredElementCount,
    });
  }

  return buildFlowchartResult(true, '', {
    nodes,
    edges,
    partialStructured:
      ignoredElementCount > 0 || invalidLineCount > 0 || nodes.length < geometryCount || edges.length < lineCount,
    ignoredElementCount,
  });
}

export function renderMindmapMarkdown(roots = []) {
  const lines = [];
  for (const root of roots) {
    renderMindmapNode(root, 0, lines);
  }
  return lines.join('\n').trim();
}

export function renderFlowchartMermaid(flowchart = {}) {
  const nodes = Array.isArray(flowchart?.nodes) ? flowchart.nodes : [];
  const edges = Array.isArray(flowchart?.edges) ? flowchart.edges : [];
  if (nodes.length === 0) {
    return '';
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lines = ['flowchart TD'];

  for (const node of nodes) {
    lines.push(`  ${renderMermaidFlowNode(node)}`);
  }

  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge?.sourceId);
    const targetNode = nodeMap.get(edge?.targetId);
    if (!sourceNode || !targetNode) {
      continue;
    }
    lines.push(`  ${sourceNode.mermaidId} --> ${targetNode.mermaidId}`);
  }

  return lines.join('\n').trim();
}

export function buildJsonCanvasDocument(roots = []) {
  const nodes = [];
  const edges = [];
  let nodeCounter = 0;
  let edgeCounter = 0;
  let rowCounter = 0;

  const visit = (node, depth, parentId = '') => {
    const currentId = `node-${++nodeCounter}`;
    const text = node.text || DEFAULT_NODE_TEXT;
    const width = estimateCanvasNodeWidth(text);
    const height = estimateCanvasNodeHeight(text);
    const y = rowCounter * 140;
    rowCounter += 1;

    const canvasNode = {
      id: currentId,
      type: 'text',
      text,
      x: depth * 420,
      y,
      width,
      height,
    };

    if (node.color) {
      canvasNode.color = node.color;
    }

    nodes.push(canvasNode);

    if (parentId) {
      const edge = {
        id: `edge-${++edgeCounter}`,
        fromNode: parentId,
        fromSide: 'right',
        toNode: currentId,
        toSide: 'left',
      };
      if (node.edgeColor) {
        edge.color = node.edgeColor;
      } else if (node.color) {
        edge.color = node.color;
      }
      edges.push(edge);
    }

    for (const child of node.children || []) {
      visit(child, depth + 1, currentId);
    }
  };

  for (const root of roots) {
    visit(root, 0, '');
  }

  return { nodes, edges };
}

export function sanitizeMindmapText(value) {
  return sanitizeBoardText(value);
}

function buildFlowchartResult(isFlowchart, reason, options = {}) {
  return {
    isFlowchart,
    reason,
    nodes: Array.isArray(options.nodes) ? options.nodes : [],
    edges: Array.isArray(options.edges) ? options.edges : [],
    partialStructured: Boolean(options.partialStructured),
    ignoredElementCount: Number.isFinite(Number(options.ignoredElementCount))
      ? Number(options.ignoredElementCount)
      : 0,
  };
}

function normalizeMindmapNode(rawNode, state, options = {}) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    state.invalidReason = 'invalid-node';
    return null;
  }

  const type = String(rawNode.type ?? '').trim();
  if (options.requireMindmapType) {
    if (type !== 'mindmap') {
      state.invalidReason = `unsupported-root-type:${type || 'empty'}`;
      return null;
    }
  } else if (type && type !== 'mindmap') {
    state.invalidReason = `unsupported-node-type:${type}`;
    return null;
  }

  const rawChildren = rawNode.children ?? [];
  if (!Array.isArray(rawChildren)) {
    state.invalidReason = 'invalid-children';
    return null;
  }

  const children = [];
  for (const child of rawChildren) {
    const normalizedChild = normalizeMindmapNode(child, state);
    if (state.invalidReason) {
      return null;
    }
    if (normalizedChild) {
      children.push(normalizedChild);
    }
  }

  let text = extractBoardNodeText(rawNode);
  if (!text && children.length === 0) {
    return null;
  }
  if (!text) {
    text = DEFAULT_NODE_TEXT;
  }

  return {
    id: String(rawNode.id ?? ''),
    text,
    children,
    color: pickNodeColor(rawNode),
    edgeColor: normalizeHexColor(rawNode?.treeEdge?.stroke),
  };
}

function normalizeFlowchartNode(rawNode, mermaidIndex) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    return null;
  }

  const id = String(rawNode.id ?? '').trim();
  const text = extractBoardNodeText(rawNode);
  if (!id || !text) {
    return null;
  }

  return {
    id,
    mermaidId: `n${mermaidIndex}`,
    text,
    shape: normalizeFlowchartShape(rawNode?.shape),
    color: pickNodeColor(rawNode),
  };
}

function renderMindmapNode(node, depth, lines) {
  const indent = '  '.repeat(depth);
  lines.push(`${indent}- ${node.text}`);
  for (const child of node.children || []) {
    renderMindmapNode(child, depth + 1, lines);
  }
}

function renderMermaidFlowNode(node) {
  const label = `"${escapeMermaidText(node?.text || DEFAULT_NODE_TEXT)}"`;
  if (node?.shape === 'diamond') {
    return `${node.mermaidId}{${label}}`;
  }
  if (node?.shape === 'circle') {
    return `${node.mermaidId}((${label}))`;
  }
  if (node?.shape === 'round') {
    return `${node.mermaidId}(${label})`;
  }
  return `${node.mermaidId}[${label}]`;
}

function extractBoardNodeText(rawNode) {
  return sanitizeBoardText(rawNode?.html ?? rawNode?.textContent ?? rawNode?.text ?? '');
}

function sanitizeBoardText(value) {
  const decoded = decodeHtmlEntities(stripHtml(String(value ?? '')));
  return decoded.replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ').trim();
}

function escapeMermaidText(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('<br/>');
}

function normalizeFlowchartShape(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'diamond') {
    return 'diamond';
  }
  if (normalized === 'circle') {
    return 'circle';
  }
  if (normalized === 'ellipse' || normalized === 'roundrect' || normalized === 'roundedrect') {
    return 'round';
  }
  return 'rect';
}

function estimateCanvasNodeWidth(text) {
  return Math.max(220, Math.min(420, text.length * 18 + 60));
}

function estimateCanvasNodeHeight(text) {
  const lines = String(text ?? '').split('\n').length;
  return Math.max(80, lines * 28 + 32);
}

function pickNodeColor(rawNode) {
  return (
    normalizeHexColor(rawNode?.border?.fill) ||
    normalizeHexColor(rawNode?.treeEdge?.stroke) ||
    normalizeHexColor(rawNode?.defaultContentStyle?.color) ||
    ''
  );
}

function normalizeHexColor(value) {
  const normalized = String(value ?? '').trim();
  return HEX_COLOR_RE.test(normalized) ? normalized : '';
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|nbsp|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const token = String(entity).toLowerCase();
    if (token === 'nbsp') {
      return ' ';
    }
    if (token === 'amp') {
      return '&';
    }
    if (token === 'lt') {
      return '<';
    }
    if (token === 'gt') {
      return '>';
    }
    if (token === 'quot') {
      return '"';
    }
    if (token === 'apos') {
      return "'";
    }
    if (token.startsWith('#x')) {
      const codePoint = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (token.startsWith('#')) {
      const codePoint = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}
