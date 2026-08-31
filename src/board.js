import { stripHtml } from './utils.js';

const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const CSS_COLOR_RE = /^(?:rgba?|hsla?)\([^)]*\)$/i;
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

  const state = { invalidReason: '', helperLineCount: 0 };
  const roots = [];

  for (const entry of diagramData.body) {
    const entryType = String(entry?.type ?? '').trim().toLowerCase();
    if (entryType === 'line') {
      state.helperLineCount += 1;
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

  const summary = summarizeMindmapRoots(roots);
  return {
    isPureMindmap: true,
    reason: '',
    roots,
    nodeCount: summary.nodeCount,
    ignoredElementCount: state.helperLineCount,
    layoutCompleteness: summary.layoutCompleteness,
  };
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

  for (const [sourceOrder, entry] of diagramData.body.entries()) {
    const entryType = String(entry?.type ?? '').trim().toLowerCase();
    if (entryType === 'geometry') {
      geometryCount += 1;
      const node = normalizeFlowchartNode(entry, nodes.length + 1, sourceOrder);
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
      id: String(entry?.id ?? `line-${edges.length + 1}`),
      sourceId,
      targetId,
      sourceAnchor: normalizeConnection(entry?.source?.connection),
      targetAnchor: normalizeConnection(entry?.target?.connection),
      shape: String(entry?.shape ?? '').trim().toLowerCase(),
      marker: String(entry?.target?.marker ?? entry?.source?.marker ?? '').trim().toLowerCase(),
      color: normalizeBoardColor(entry?.stroke?.color ?? entry?.border?.color),
      points: normalizeLinePoints(entry?.points ?? entry?.path ?? []),
      sourceOrder: lineEntries.indexOf(entry),
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
    geometryCount,
    lineCount,
    invalidLineCount,
    sourceElementCount: diagramData.body.length,
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
  const direction = String(flowchart?.direction || inferFlowchartDirection(flowchart) || 'TD').toUpperCase();
  const lines = [`flowchart ${['TD', 'TB', 'BT', 'LR', 'RL'].includes(direction) ? direction : 'TD'}`];

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

/**
 * 将思维导图树渲染为 Obsidian 局部展示可用的 markmap 代码块。
 * Markdown 本身仍是唯一内容源，插件缺失时可安全降级为普通层级列表。
 */
export function renderMindmapMarkmap(roots = []) {
  const lines = [];
  for (const root of roots) {
    renderMarkmapNode(root, 1, lines);
  }
  const body = lines.join('\n').trim();
  return body ? `\`\`\`markmap\n${body}\n\`\`\`` : '';
}

/**
 * 统一暴露给渲染层的图形模型，避免后续格式转换再次从原始 JSON 猜结构。
 */
export function buildBoardIR(diagramData) {
  const mindmap = analyzeMindmapDiagram(diagramData);
  if (mindmap.isPureMindmap) {
    const nodes = flattenMindmapRoots(mindmap.roots);
    return {
      kind: 'mindmap',
      roots: mindmap.roots,
      nodes,
      edges: buildMindmapEdges(mindmap.roots),
      sourceElementCount: Array.isArray(diagramData?.body) ? diagramData.body.length : 0,
      nodeCount: nodes.length,
      edgeCount: Math.max(0, nodes.length - mindmap.roots.length),
      ignoredElementCount: Number(mindmap.ignoredElementCount || 0),
      unsupportedElementCount: 0,
      structureCompleteness: nodes.length > 0 ? 1 : 0,
      layoutCompleteness: Number(mindmap.layoutCompleteness || 0),
      partialStructured: false,
      reason: '',
    };
  }

  const flowchart = analyzeFlowchartDiagram(diagramData);
  if (flowchart.isFlowchart) {
    const totalConnectable = Math.max(1, Number(flowchart.geometryCount || 0) + Number(flowchart.lineCount || 0));
    const recognized = flowchart.nodes.length + flowchart.edges.length;
    return {
      kind: 'flowchart',
      roots: [],
      nodes: flowchart.nodes,
      edges: flowchart.edges,
      sourceElementCount: Number(flowchart.sourceElementCount || 0),
      nodeCount: flowchart.nodes.length,
      edgeCount: flowchart.edges.length,
      ignoredElementCount: Number(flowchart.ignoredElementCount || 0),
      unsupportedElementCount: Math.max(0, Number(flowchart.ignoredElementCount || 0)),
      structureCompleteness: Math.min(1, recognized / totalConnectable),
      layoutCompleteness: calculateFlowchartLayoutCompleteness(flowchart.nodes),
      partialStructured: Boolean(flowchart.partialStructured),
      reason: flowchart.reason || '',
      direction: inferFlowchartDirection(flowchart),
      metrics: getFlowchartLayoutMetrics(flowchart),
    };
  }

  return {
    kind: 'board',
    roots: [],
    nodes: [],
    edges: [],
    sourceElementCount: Array.isArray(diagramData?.body) ? diagramData.body.length : 0,
    nodeCount: 0,
    edgeCount: 0,
    ignoredElementCount: Number(flowchart.ignoredElementCount || 0),
    unsupportedElementCount: Number(flowchart.ignoredElementCount || 0),
    structureCompleteness: 0,
    layoutCompleteness: 0,
    partialStructured: false,
    reason: flowchart.reason || mindmap.reason || 'unsupported-board-structure',
    metrics: getFlowchartLayoutMetrics(flowchart),
  };
}

/**
 * 仅供输出层选择格式。阈值保守：拿不准的图宁可保留快照，也不伪装成 Mermaid。
 */
export function classifyBoardIR(boardIR = {}) {
  if (boardIR?.kind === 'mindmap' && boardIR.nodeCount > 0) {
    return { category: 'mindmap', primaryFormat: 'markmap', fallbackRequired: false };
  }

  if (boardIR?.kind !== 'flowchart') {
    return { category: 'freeform', primaryFormat: 'png', fallbackRequired: true };
  }

  const metrics = boardIR.metrics || getFlowchartLayoutMetrics(boardIR);
  if (boardIR.partialStructured && boardIR.structureCompleteness >= 0.7) {
    return { category: 'partial-flowchart', primaryFormat: 'mermaid', fallbackRequired: true };
  }
  const isSimple =
    boardIR.nodeCount <= 20 &&
    boardIR.structureCompleteness >= 1 &&
    !boardIR.partialStructured &&
    metrics.maxFanIn <= 3 &&
    metrics.maxFanOut <= 3 &&
    metrics.dominantDirectionRatio >= 0.7 &&
    metrics.columnCount <= 3;

  if (isSimple) {
    return { category: 'simple-flowchart', primaryFormat: 'mermaid', fallbackRequired: false };
  }

  if (boardIR.structureCompleteness >= 0.7) {
    return { category: 'layout-sensitive-flowchart', primaryFormat: 'excalidraw', fallbackRequired: true };
  }

  return { category: 'partial-flowchart', primaryFormat: 'png', fallbackRequired: true };
}

export function inferFlowchartDirection(flowchart = {}) {
  const nodes = Array.isArray(flowchart?.nodes) ? flowchart.nodes : [];
  const edges = Array.isArray(flowchart?.edges) ? flowchart.edges : [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const votes = { TD: 0, BT: 0, LR: 0, RL: 0 };

  for (const edge of edges) {
    const source = nodeMap.get(edge?.sourceId);
    const target = nodeMap.get(edge?.targetId);
    if (!hasPosition(source) || !hasPosition(target)) {
      continue;
    }
    const dx = centerX(target) - centerX(source);
    const dy = centerY(target) - centerY(source);
    if (Math.abs(dx) > Math.abs(dy)) {
      votes[dx >= 0 ? 'LR' : 'RL'] += 1;
    } else if (Math.abs(dy) > 0) {
      votes[dy >= 0 ? 'TD' : 'BT'] += 1;
    }
  }

  const ranked = Object.entries(votes).sort((left, right) => right[1] - left[1]);
  return ranked[0]?.[1] > 0 ? ranked[0][0] : 'TD';
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
    geometryCount: Number(options.geometryCount || 0),
    lineCount: Number(options.lineCount || 0),
    invalidLineCount: Number(options.invalidLineCount || 0),
    sourceElementCount: Number(options.sourceElementCount || 0),
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
    edgeColor: normalizeBoardColor(rawNode?.treeEdge?.stroke),
    x: normalizeCoordinate(rawNode?.x),
    y: normalizeCoordinate(rawNode?.y),
    width: normalizeCoordinate(rawNode?.width),
    height: normalizeCoordinate(rawNode?.height),
    zIndex: normalizeCoordinate(rawNode?.zIndex),
  };
}

function normalizeFlowchartNode(rawNode, mermaidIndex, sourceOrder = -1) {
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
    originalShape: String(rawNode?.shape ?? '').trim(),
    x: normalizeCoordinate(rawNode?.x),
    y: normalizeCoordinate(rawNode?.y),
    width: normalizeCoordinate(rawNode?.width),
    height: normalizeCoordinate(rawNode?.height),
    fillColor: normalizeBoardColor(rawNode?.fill?.color ?? rawNode?.border?.fill),
    strokeColor: normalizeBoardColor(rawNode?.stroke?.color ?? rawNode?.border?.color),
    textColor: normalizeBoardColor(rawNode?.defaultContentStyle?.color),
    zIndex: normalizeCoordinate(rawNode?.zIndex),
    sourceOrder,
  };
}

function renderMindmapNode(node, depth, lines) {
  const indent = '  '.repeat(depth);
  lines.push(`${indent}- ${node.text}`);
  for (const child of node.children || []) {
    renderMindmapNode(child, depth + 1, lines);
  }
}

function renderMarkmapNode(node, depth, lines) {
  const level = Math.min(6, Math.max(1, depth));
  const text = String(node?.text || DEFAULT_NODE_TEXT).trim() || DEFAULT_NODE_TEXT;
  if (depth <= 6) {
    lines.push(`${'#'.repeat(level)} ${text}`);
  } else {
    lines.push(`${'  '.repeat(depth - 7)}- ${text}`);
  }
  for (const child of node.children || []) {
    renderMarkmapNode(child, depth + 1, lines);
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
    normalizeBoardColor(rawNode?.fill?.color) ||
    normalizeBoardColor(rawNode?.border?.fill) ||
    normalizeBoardColor(rawNode?.treeEdge?.stroke) ||
    normalizeBoardColor(rawNode?.defaultContentStyle?.color) ||
    ''
  );
}

function normalizeBoardColor(value) {
  const normalized = String(value ?? '').trim();
  return HEX_COLOR_RE.test(normalized) || CSS_COLOR_RE.test(normalized) ? normalized : '';
}

function normalizeHexColor(value) {
  const normalized = String(value ?? '').trim();
  return HEX_COLOR_RE.test(normalized) ? normalized : '';
}

function normalizeCoordinate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeConnection(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  const normalized = String(value ?? '').trim().toUpperCase();
  return ['N', 'S', 'E', 'W'].includes(normalized) ? normalized : null;
}

function normalizeLinePoints(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((point) => {
      if (Array.isArray(point) && point.length >= 2) {
        const x = Number(point[0]);
        const y = Number(point[1]);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
      }
      if (point && typeof point === 'object') {
        const x = Number(point.x);
        const y = Number(point.y);
        return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
      }
      return null;
    })
    .filter(Boolean);
}

function summarizeMindmapRoots(roots = []) {
  let nodeCount = 0;
  let positionedCount = 0;
  const visit = (node) => {
    nodeCount += 1;
    if (hasPosition(node)) {
      positionedCount += 1;
    }
    for (const child of node.children || []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return {
    nodeCount,
    layoutCompleteness: nodeCount > 0 ? positionedCount / nodeCount : 0,
  };
}

function flattenMindmapRoots(roots = []) {
  const nodes = [];
  const visit = (node, parentId = '', depth = 0, sourceOrder = 0) => {
    nodes.push({ ...node, parentId, depth, sourceOrder });
    for (const [childIndex, child] of (node.children || []).entries()) {
      visit(child, node.id, depth + 1, childIndex);
    }
  };
  for (const [rootIndex, root] of roots.entries()) {
    visit(root, '', 0, rootIndex);
  }
  return nodes;
}

function buildMindmapEdges(roots = []) {
  const edges = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      edges.push({ sourceId: node.id, targetId: child.id, color: child.edgeColor || node.edgeColor || node.color || '' });
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return edges;
}

function calculateFlowchartLayoutCompleteness(nodes = []) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 0;
  }
  const complete = nodes.filter((node) => hasPosition(node) && Number.isFinite(Number(node?.width)) && Number.isFinite(Number(node?.height)));
  return complete.length / nodes.length;
}

function getFlowchartLayoutMetrics(flowchart = {}) {
  const nodes = Array.isArray(flowchart?.nodes) ? flowchart.nodes : [];
  const edges = Array.isArray(flowchart?.edges) ? flowchart.edges : [];
  const incoming = new Map();
  const outgoing = new Map();
  const directionVotes = { TD: 0, BT: 0, LR: 0, RL: 0 };
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of edges) {
    incoming.set(edge.targetId, (incoming.get(edge.targetId) || 0) + 1);
    outgoing.set(edge.sourceId, (outgoing.get(edge.sourceId) || 0) + 1);
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!hasPosition(source) || !hasPosition(target)) {
      continue;
    }
    const dx = centerX(target) - centerX(source);
    const dy = centerY(target) - centerY(source);
    if (Math.abs(dx) > Math.abs(dy)) {
      directionVotes[dx >= 0 ? 'LR' : 'RL'] += 1;
    } else if (Math.abs(dy) > 0) {
      directionVotes[dy >= 0 ? 'TD' : 'BT'] += 1;
    }
  }

  const directionalEdges = Object.values(directionVotes).reduce((total, value) => total + value, 0);
  const dominantDirectionRatio = directionalEdges > 0 ? Math.max(...Object.values(directionVotes)) / directionalEdges : 1;
  const xValues = nodes.filter(hasPosition).map(centerX).sort((left, right) => left - right);
  const medianWidth = median(nodes.map((node) => Number(node?.width)).filter(Number.isFinite)) || 100;
  const columnCount = countCoordinateClusters(xValues, Math.max(30, medianWidth * 0.65));

  return {
    maxFanIn: Math.max(0, ...incoming.values()),
    maxFanOut: Math.max(0, ...outgoing.values()),
    elbowRatio: edges.length > 0 ? edges.filter((edge) => edge?.shape === 'elbow').length / edges.length : 0,
    dominantDirectionRatio,
    columnCount,
  };
}

function countCoordinateClusters(sortedValues = [], gap) {
  if (!sortedValues.length) {
    return 0;
  }
  let count = 1;
  let anchor = sortedValues[0];
  for (const value of sortedValues.slice(1)) {
    if (Math.abs(value - anchor) > gap) {
      count += 1;
      anchor = value;
    }
  }
  return count;
}

function median(values = []) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function hasPosition(node) {
  return Number.isFinite(Number(node?.x)) && Number.isFinite(Number(node?.y));
}

function centerX(node) {
  return Number(node.x) + (Number(node.width) || 0) / 2;
}

function centerY(node) {
  return Number(node.y) + (Number(node.height) || 0) / 2;
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
