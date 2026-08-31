import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import LZString from 'lz-string';

const EXCALIDRAW_SOURCE = 'https://github.com/zsviczian/obsidian-excalidraw-plugin';
const DEFAULT_STROKE = '#495057';
const DEFAULT_FILL = '#ffffff';
const DEFAULT_TEXT = '#212529';

/**
 * 把布局敏感的流程图直接转换为 Excalidraw scene。
 * 所有文字、矩形和箭头均使用标准绑定字段，后续可在 Obsidian 中继续编辑。
 */
export function buildExcalidrawScene(boardIR = {}, options = {}) {
  const nodes = Array.isArray(boardIR?.nodes) ? boardIR.nodes : [];
  const edges = Array.isArray(boardIR?.edges) ? boardIR.edges : [];
  const timestamp = Number(options.timestamp || Date.now());
  const layout = normalizeLayout(nodes, options);
  const nodeEntries = nodes.map((node, index) => createNodeEntry(node, index, layout, timestamp));
  const entryBySourceId = new Map(nodeEntries.map((entry) => [entry.sourceId, entry]));
  // 所有连线统一绑定到形状边缘中心；多条线不再在边缘人为分散。
  const preparedEdges = normalizeEdgeCenterAnchors(edges, entryBySourceId);
  const routingContext = buildRoutingContext(preparedEdges, nodeEntries);
  const arrows = [];

  for (const [index, edge] of preparedEdges.entries()) {
    const source = entryBySourceId.get(edge.sourceId);
    const target = entryBySourceId.get(edge.targetId);
    if (!source || !target) {
      continue;
    }
    const arrow = createArrowElement(edge, source, target, layout, routingContext, index, timestamp);
    arrows.push(arrow);
    source.shape.boundElements.push({ id: arrow.id, type: 'arrow' });
    target.shape.boundElements.push({ id: arrow.id, type: 'arrow' });
  }

  const elements = [];
  for (const entry of nodeEntries) {
    elements.push(entry.shape, entry.text);
  }
  elements.push(...arrows);

  return {
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_SOURCE,
    elements,
    appState: {
      theme: 'light',
      viewBackgroundColor: '#f5faff',
      currentItemStrokeColor: DEFAULT_STROKE,
      currentItemBackgroundColor: DEFAULT_FILL,
      currentItemFillStyle: 'solid',
      currentItemStrokeWidthKey: 'medium',
      currentItemStrokeVariability: 'constant',
      currentItemStrokeStyle: 'solid',
      currentItemRoughness: 0,
      currentItemOpacity: 100,
      currentItemFontFamily: 2,
      currentItemFontSize: 18,
      currentItemTextAlign: 'center',
      currentItemStartArrowhead: null,
      currentItemEndArrowhead: 'arrow',
      currentItemArrowType: 'elbow',
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
      bindingPreference: 'enabled',
      isBindingEnabled: true,
      isMidpointSnappingEnabled: true,
      activeTool: { type: 'selection', customType: null, locked: false, fromSelection: false, lastActiveTool: null },
    },
    files: {},
  };
}

export function buildExcalidrawMarkdown(scene = {}) {
  const elements = Array.isArray(scene?.elements) ? scene.elements : [];
  const textElements = elements.filter((element) => element.type === 'text' && !element.isDeleted);
  const textSection = textElements
    .map((element) => `${String(element.text || '').trim()} ^${element.id}`)
    .filter(Boolean)
    .join('\n\n');
  const compressed = LZString.compressToBase64(JSON.stringify(scene, null, 2));
  return [
    '---',
    'excalidraw-plugin: parsed',
    'tags:',
    '  - excalidraw',
    '---',
    '# Excalidraw Data',
    '',
    '## Text Elements',
    textSection,
    '',
    '%%',
    '## Drawing',
    '```compressed-json',
    compressed,
    '```',
    '%%',
    '',
  ].join('\n');
}

export function readExcalidrawScene(markdownOrPath, options = {}) {
  const source = options.fromFile ? fs.readFileSync(markdownOrPath, 'utf8') : String(markdownOrPath || '');
  const match = source.match(/```compressed-json\r?\n([\s\S]*?)\r?\n```/i);
  if (!match) {
    throw new Error('未找到 Excalidraw compressed-json 数据块。');
  }
  const decoded = LZString.decompressFromBase64(String(match[1]).replace(/\s+/g, ''));
  if (!decoded) {
    throw new Error('Excalidraw compressed-json 解压失败。');
  }
  const scene = JSON.parse(decoded);
  if (!scene || !Array.isArray(scene.elements)) {
    throw new Error('Excalidraw scene 结构无效。');
  }
  return scene;
}

export function validateExcalidrawScene(scene = {}, expected = {}) {
  const elements = Array.isArray(scene?.elements) ? scene.elements.filter((element) => !element.isDeleted) : [];
  const shapes = elements.filter((element) => ['rectangle', 'diamond', 'ellipse'].includes(element.type));
  const texts = elements.filter((element) => element.type === 'text');
  const arrows = elements.filter((element) => element.type === 'arrow');
  const shapeIds = new Set(shapes.map((element) => element.id));
  const boundTextCount = texts.filter((element) => shapeIds.has(element.containerId)).length;
  const fullyBoundArrowCount = arrows.filter(
    (element) => shapeIds.has(element?.startBinding?.elementId) && shapeIds.has(element?.endBinding?.elementId),
  ).length;
  const duplicateIdCount = elements.length - new Set(elements.map((element) => element.id)).size;
  const result = {
    valid: true,
    shapeCount: shapes.length,
    textCount: texts.length,
    arrowCount: arrows.length,
    boundTextCount,
    fullyBoundArrowCount,
    duplicateIdCount,
    errors: [],
  };

  if (duplicateIdCount > 0) {
    result.errors.push('Excalidraw 元素 ID 存在重复。');
  }
  if (expected.nodeCount !== undefined && shapes.length !== Number(expected.nodeCount)) {
    result.errors.push(`节点数量不匹配：期望 ${expected.nodeCount}，实际 ${shapes.length}。`);
  }
  if (expected.nodeCount !== undefined && boundTextCount !== Number(expected.nodeCount)) {
    result.errors.push(`绑定文字数量不匹配：期望 ${expected.nodeCount}，实际 ${boundTextCount}。`);
  }
  if (expected.edgeCount !== undefined && arrows.length !== Number(expected.edgeCount)) {
    result.errors.push(`连线数量不匹配：期望 ${expected.edgeCount}，实际 ${arrows.length}。`);
  }
  if (expected.edgeCount !== undefined && fullyBoundArrowCount !== Number(expected.edgeCount)) {
    result.errors.push(`双端绑定箭头数量不匹配：期望 ${expected.edgeCount}，实际 ${fullyBoundArrowCount}。`);
  }
  result.valid = result.errors.length === 0;
  return result;
}

export function writeExcalidrawDrawing(targetPath, boardIR, options = {}) {
  const scene = buildExcalidrawScene(boardIR, options);
  const validation = validateExcalidrawScene(scene, {
    nodeCount: Array.isArray(boardIR?.nodes) ? boardIR.nodes.length : 0,
    edgeCount: Array.isArray(boardIR?.edges) ? boardIR.edges.length : 0,
  });
  if (!validation.valid) {
    throw new Error(`Excalidraw 场景校验失败：${validation.errors.join('；')}`);
  }
  const markdown = buildExcalidrawMarkdown(scene);
  writeUtf8Atomically(targetPath, markdown, options.allowOverwrite === true);
  return { scene, validation, targetPath };
}

function createNodeEntry(node, index, layout, timestamp) {
  const sourceId = String(node?.id || `node-${index + 1}`);
  const idSuffix = stableId(sourceId, index);
  const width = Math.max(118, Number(node?.width || 100) * layout.scale);
  const height = Math.max(46, Number(node?.height || 36) * layout.scale);
  const x = layout.toX(node?.x);
  const y = layout.toY(node?.y);
  const shapeId = `r${idSuffix}`;
  const textId = `t${idSuffix}`;
  const shape = {
    ...baseElement(shapeId, rectangleTypeForNode(node), x, y, width, height, index * 2, timestamp),
    strokeColor: String(node?.strokeColor || DEFAULT_STROKE),
    backgroundColor: String(node?.fillColor || DEFAULT_FILL),
    roundness: node?.shape === 'round' || /start[-_ ]?end/i.test(String(node?.originalShape || '')) ? { type: 3 } : null,
    boundElements: [{ id: textId, type: 'text' }],
  };
  const textValue = String(node?.text || '未命名节点');
  const textSize = estimateTextSize(textValue, width);
  const text = {
    ...baseElement(textId, 'text', x + (width - textSize.width) / 2, y + (height - textSize.height) / 2, textSize.width, textSize.height, index * 2 + 1, timestamp),
    strokeColor: String(node?.textColor || DEFAULT_TEXT),
    strokeWidth: 1,
    fontSize: textSize.fontSize,
    fontFamily: 2,
    text: textValue,
    rawText: textValue,
    originalText: textValue,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: shapeId,
    autoResize: true,
    lineHeight: 1.25,
  };
  return { sourceId, node, shape, text };
}

function createArrowElement(edge, source, target, layout, routingContext, index, timestamp) {
  const startFixedPoint = resolveFixedPoint(edge.sourceAnchor, source, target);
  const endFixedPoint = resolveFixedPoint(edge.targetAnchor, target, source);
  const start = fixedPointToCoordinate(source.shape, startFixedPoint);
  const end = fixedPointToCoordinate(target.shape, endFixedPoint);
  // 优先使用语雀原始路径，避免导出器再次按几何中点生成折线。
  const originalPoints = buildOriginalArrowPoints(edge, source, layout, start, end);
  const points = originalPoints || toRelativeArrowPoints(
    buildFallbackArrowPath(edge, source, target, start, end, routingContext),
    start,
    end,
  );
  const hasOriginalPath = Boolean(originalPoints);
  // 自定义多点路径不能标记为 elbowed：Excalidraw 会在加载时接管 elbow 路由，
  // 重新计算中间折点，导致已经避开节点的外部通道被折回节点内部。
  // 没有原始路径的连线则使用导出器生成的正交路径，并启用默认拐角路由。
  const elbowed = !hasOriginalPath;
  // 自定义路径使用 inside 绑定，保留语雀原始折点；默认拐角路径使用 orbit，
  // 让 Excalidraw 按拐角箭头语义维护端点绑定。
  const bindingMode = hasOriginalPath ? 'inside' : 'orbit';
  const bounds = getArrowBounds(points);
  const arrowId = `a${stableId(edge?.id || `${edge.sourceId}-${edge.targetId}`, index)}`;
  return {
    ...baseElement(arrowId, 'arrow', start.x, start.y, bounds.width, bounds.height, 100000 + index, timestamp),
    strokeColor: String(edge?.color || DEFAULT_STROKE),
    backgroundColor: 'transparent',
    strokeWidth: 2,
    points,
    startBinding: {
      elementId: source.shape.id,
      focus: 0,
      gap: 1,
      fixedPoint: startFixedPoint,
      mode: bindingMode,
    },
    endBinding: {
      elementId: target.shape.id,
      focus: 0,
      gap: 1,
      fixedPoint: endFixedPoint,
      mode: bindingMode,
    },
    startArrowhead: null,
    endArrowhead: edge?.marker || 'arrow',
    elbowed,
    fixedSegments: null,
    startIsSpecial: null,
    endIsSpecial: null,
  };
}

function getArrowBounds(points = []) {
  const xs = points.map((point) => Number(point?.[0])).filter(Number.isFinite);
  const ys = points.map((point) => Number(point?.[1])).filter(Number.isFinite);
  return {
    width: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
    height: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
  };
}

/**
 * 为缺少原始路径的连线准备一个只读路由上下文。
 * 路由只避让节点矩形，不改变节点坐标，也不改变 Excalidraw 的绑定关系。
 */
function buildRoutingContext(edges, nodeEntries) {
  return {
    nodes: nodeEntries.map((entry) => entry.shape),
    routes: [],
    edgeCountBySource: countEdgesBy(edges, 'sourceId'),
    edgeCountByTarget: countEdgesBy(edges, 'targetId'),
  };
}

function countEdgesBy(edges, key) {
  const counts = new Map();
  for (const edge of edges) {
    const value = String(edge?.[key] || '');
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

/**
 * 没有语雀原始 points/path 时，始终生成正交路径，使普通连线默认呈现拐角箭头。
 * 对同侧高密度汇线，使用节点外侧的稳定通道，避免长线穿过中间节点。
 */
function buildFallbackArrowPath(edge, source, target, start, end, routingContext) {
  const obstacles = (routingContext?.nodes || []).filter(
    (shape) => shape.id !== source.shape.id && shape.id !== target.shape.id,
  );
  const candidates = buildOrthogonalCandidates(start, end, obstacles, edge);
  const targetSideCandidate = buildTargetSideLaneCandidate(start, end, edge);
  const safeTargetSideCandidate = targetSideCandidate && !pathIntersectsObstacles(targetSideCandidate, obstacles)
    ? targetSideCandidate
    : null;
  const best = candidates
    .filter((candidate) => !pathIntersectsObstacles(candidate, obstacles))
    .sort((left, right) => scoreRoute(left, routingContext?.routes) - scoreRoute(right, routingContext?.routes))[0];
  const route = safeTargetSideCandidate || best || [start, end];
  routingContext?.routes.push(route);
  return route;
}

function buildOrthogonalCandidates(start, end, obstacles, edge) {
  const horizontal = isHorizontalConnection(edge, start, end);
  const coordinates = horizontal
    ? collectChannelCoordinates(obstacles, 'y', start.y, end.y)
    : collectChannelCoordinates(obstacles, 'x', start.x, end.x);
  const candidates = [];

  for (const channel of coordinates) {
    candidates.push(
      horizontal
        ? [start, { x: start.x, y: channel }, { x: end.x, y: channel }, end]
        : [start, { x: channel, y: start.y }, { x: channel, y: end.y }, end],
    );
  }

  // 混合方向或没有可用通道时，补充两种最短的单次转折路径。
  candidates.push(
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
  );
  return candidates.map(removeRedundantPoints).filter((candidate) => candidate.length >= 2);
}

function buildTargetSideLaneCandidate(start, end, edge) {
  if (!isHorizontalConnection(edge, start, end) || start.x === end.x) {
    return null;
  }
  // 对左右方向的高密度汇线，在目标节点外侧保留一条竖向通道，
  // 再用短水平段进入目标，避免整条竖线贴在目标节点边框上。
  const targetSideGap = 12;
  const targetSideX = end.x + (start.x < end.x ? -targetSideGap : targetSideGap);
  return removeRedundantPoints([
    start,
    { x: targetSideX, y: start.y },
    { x: targetSideX, y: end.y },
    end,
  ]);
}

function collectChannelCoordinates(obstacles, axis, start, end) {
  const gap = 12;
  const values = [start, end, (start + end) / 2];
  for (const obstacle of obstacles) {
    const minimum = axis === 'x' ? obstacle.x : obstacle.y;
    const maximum = axis === 'x' ? obstacle.x + obstacle.width : obstacle.y + obstacle.height;
    values.push(minimum - gap, minimum + gap, maximum - gap, maximum + gap);
  }
  return [...new Set(values.filter(Number.isFinite))].sort((left, right) => Math.abs(left - (start + end) / 2) - Math.abs(right - (start + end) / 2));
}

function isHorizontalConnection(edge, start, end) {
  const sourceAnchor = edge?.sourceAnchor;
  const targetAnchor = edge?.targetAnchor;
  if (Array.isArray(sourceAnchor) && Array.isArray(targetAnchor)) {
    return sourceAnchor[0] !== 0.5 || targetAnchor[0] !== 0.5;
  }
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
}

function pathIntersectsObstacles(points, obstacles) {
  return obstacles.some((obstacle) => {
    for (let index = 1; index < points.length; index += 1) {
      if (segmentIntersectsRect(points[index - 1], points[index], obstacle, 2)) {
        return true;
      }
    }
    return false;
  });
}

function segmentIntersectsRect(start, end, rect, padding = 0) {
  const left = Number(rect.x) - padding;
  const right = Number(rect.x) + Number(rect.width) + padding;
  const top = Number(rect.y) - padding;
  const bottom = Number(rect.y) + Number(rect.height) + padding;
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  if (maxX < left || minX > right || maxY < top || minY > bottom) return false;
  if (start.x === end.x) return start.x > left && start.x < right && maxY > top && minY < bottom;
  if (start.y === end.y) return start.y > top && start.y < bottom && maxX > left && minX < right;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const tValues = [
    (left - start.x) / dx,
    (right - start.x) / dx,
    (top - start.y) / dy,
    (bottom - start.y) / dy,
  ].filter((value) => value > 0 && value < 1);
  return tValues.some((t) => {
    const x = start.x + dx * t;
    const y = start.y + dy * t;
    return x >= left && x <= right && y >= top && y <= bottom;
  });
}

function scoreRoute(points, existingRoutes = []) {
  const length = points.slice(1).reduce((total, point, index) => {
    const previous = points[index];
    return total + Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
  }, 0);
  const bends = Math.max(0, points.length - 2);
  const overlapPenalty = existingRoutes.reduce((total, route) => total + collinearOverlap(points, route) * 20, 0);
  return length + bends * 80 + overlapPenalty;
}

function collinearOverlap(leftPoints, rightPoints) {
  let overlap = 0;
  for (let leftIndex = 1; leftIndex < leftPoints.length; leftIndex += 1) {
    const leftStart = leftPoints[leftIndex - 1];
    const leftEnd = leftPoints[leftIndex];
    for (let rightIndex = 1; rightIndex < rightPoints.length; rightIndex += 1) {
      const rightStart = rightPoints[rightIndex - 1];
      const rightEnd = rightPoints[rightIndex];
      if (leftStart.y === leftEnd.y && rightStart.y === rightEnd.y && leftStart.y === rightStart.y) {
        overlap += intervalOverlap(leftStart.x, leftEnd.x, rightStart.x, rightEnd.x);
      }
      if (leftStart.x === leftEnd.x && rightStart.x === rightEnd.x && leftStart.x === rightStart.x) {
        overlap += intervalOverlap(leftStart.y, leftEnd.y, rightStart.y, rightEnd.y);
      }
    }
  }
  return overlap;
}

function intervalOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return Math.max(0, Math.min(Math.max(leftStart, leftEnd), Math.max(rightStart, rightEnd)) - Math.max(Math.min(leftStart, leftEnd), Math.min(rightStart, rightEnd)));
}

function removeRedundantPoints(points) {
  const result = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    const beforePrevious = result[result.length - 2];
    if (beforePrevious && previous && ((beforePrevious.x === previous.x && previous.x === point.x) || (beforePrevious.y === previous.y && previous.y === point.y))) {
      result[result.length - 1] = point;
      continue;
    }
    result.push(point);
  }
  return result;
}

function toRelativeArrowPoints(points, start, end) {
  const first = points[0] || start;
  const relative = points.map((point) => [round(point.x - first.x), round(point.y - first.y)]);
  relative[0] = [0, 0];
  relative[relative.length - 1] = [round(end.x - start.x), round(end.y - start.y)];
  return relative;
}

function baseElement(id, type, x, y, width, height, order, timestamp) {
  return {
    id,
    type,
    x: round(x),
    y: round(y),
    width: round(Math.abs(width)),
    height: round(Math.abs(height)),
    angle: 0,
    strokeColor: DEFAULT_STROKE,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${String(order).padStart(6, '0')}`,
    roundness: null,
    seed: 100000 + order,
    version: 1,
    versionNonce: 1000000 + order,
    isDeleted: false,
    boundElements: [],
    updated: timestamp,
    link: null,
    locked: false,
    hasTextLink: false,
  };
}

function normalizeLayout(nodes = [], options = {}) {
  const positioned = nodes.filter((node) => Number.isFinite(Number(node?.x)) && Number.isFinite(Number(node?.y)));
  const minX = positioned.length ? Math.min(...positioned.map((node) => Number(node.x))) : 0;
  const minY = positioned.length ? Math.min(...positioned.map((node) => Number(node.y))) : 0;
  const scale = Number.isFinite(Number(options.scale)) ? Number(options.scale) : 1.18;
  const margin = Number.isFinite(Number(options.margin)) ? Number(options.margin) : 60;
  return {
    scale,
    toX: (value) => (Number.isFinite(Number(value)) ? (Number(value) - minX) * scale + margin : margin),
    toY: (value) => (Number.isFinite(Number(value)) ? (Number(value) - minY) * scale + margin : margin),
    toPoint: (point) => ({
      x: (Number(point?.[0]) - minX) * scale + margin,
      y: (Number(point?.[1]) - minY) * scale + margin,
    }),
  };
}

function rectangleTypeForNode(node = {}) {
  return node?.shape === 'diamond' ? 'diamond' : node?.shape === 'circle' ? 'ellipse' : 'rectangle';
}

function estimateTextSize(text, containerWidth) {
  const fontSize = 18;
  const lines = String(text || '').split(/\r?\n/);
  const longest = Math.max(...lines.map((line) => Array.from(line).length), 1);
  return {
    fontSize,
    width: Math.min(Math.max(24, longest * fontSize), Math.max(24, containerWidth - 18)),
    height: Math.max(fontSize * 1.25, lines.length * fontSize * 1.25),
  };
}

function normalizeEdgeCenterAnchors(edges = [], entriesById) {
  return edges.map((edge) => {
    const source = entriesById.get(edge?.sourceId);
    const target = entriesById.get(edge?.targetId);
    if (!source || !target) {
      return { ...edge };
    }
    return {
      ...edge,
      // 每条连线先按自身方向确定连接边；同一边上的多条线自然共用边中心。
      sourceAnchor: resolveFixedPoint(edge.sourceAnchor, source, target),
      targetAnchor: resolveFixedPoint(edge.targetAnchor, target, source),
    };
  });
}

function resolveFixedPoint(anchor, node, opposite) {
  if (Array.isArray(anchor) && anchor.length >= 2) {
    return normalizePointToEdgeCenter(anchor, node, opposite);
  }
  const direction = String(anchor || '').trim().toUpperCase();
  if (direction === 'N') return [0.5, 0];
  if (direction === 'S') return [0.5, 1];
  if (direction === 'E') return [1, 0.5];
  if (direction === 'W') return [0, 0.5];

  const sourceCenter = centerOf(node.shape);
  const targetCenter = centerOf(opposite.shape);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? [1, 0.5] : [0, 0.5];
  }
  return dy >= 0 ? [0.5, 1] : [0.5, 0];
}

/**
 * 将任意比例坐标归一为最近的形状边缘中心。
 * 即使源数据给出 [1, 0.25] 之类的偏移点，也不会形成扇形散点。
 */
function normalizePointToEdgeCenter(point, node, opposite) {
  const x = clamp(Number(point[0]), 0, 1);
  const y = clamp(Number(point[1]), 0, 1);
  const boundaryDistances = [
    { distance: x, fixedPoint: [0, 0.5] },
    { distance: 1 - x, fixedPoint: [1, 0.5] },
    { distance: y, fixedPoint: [0.5, 0] },
    { distance: 1 - y, fixedPoint: [0.5, 1] },
  ];
  const nearestDistance = Math.min(...boundaryDistances.map((item) => item.distance));
  if (nearestDistance > 0.25) {
    return resolveFixedPoint(null, node, opposite);
  }
  return boundaryDistances.find((item) => item.distance === nearestDistance).fixedPoint;
}

/**
 * 优先保留语雀画板已经计算好的折线路径。
 * 原始点可能是绝对画布坐标，也可能是相对线起点坐标。
 */
function buildOriginalArrowPoints(edge, source, layout, start, end) {
  const rawPoints = Array.isArray(edge?.points)
    ? edge.points.filter((point) => Array.isArray(point) && point.length >= 2)
    : [];
  if (rawPoints.length < 2) return null;
  const absolute = pointsAreAbsolute(rawPoints, source?.node);
  const canvasPoints = absolute
    ? rawPoints.map((point) => layout.toPoint(point))
    : rawPoints.map((point) => ({
        x: start.x + Number(point[0]) * layout.scale,
        y: start.y + Number(point[1]) * layout.scale,
      }));
  const first = canvasPoints[0];
  const relative = canvasPoints.map((point) => [round(point.x - first.x), round(point.y - first.y)]);
  relative[0] = [0, 0];
  // 绑定端点是最终权威端点；中间折点保持语雀原始形状。
  relative[relative.length - 1] = [round(end.x - start.x), round(end.y - start.y)];
  return relative;
}

function pointsAreAbsolute(points, sourceNode = {}) {
  const first = points[0];
  if (Math.abs(Number(first[0])) < 0.000001 && Math.abs(Number(first[1])) < 0.000001) return false;
  const x = Number(sourceNode?.x);
  const y = Number(sourceNode?.y);
  const width = Number(sourceNode?.width);
  const height = Number(sourceNode?.height);
  if (![x, y, width, height].every(Number.isFinite)) return false;
  return first[0] >= x - 1 && first[0] <= x + width + 1 && first[1] >= y - 1 && first[1] <= y + height + 1;
}


function fixedPointToCoordinate(shape, fixedPoint) {
  return {
    x: Number(shape.x) + Number(shape.width) * fixedPoint[0],
    y: Number(shape.y) + Number(shape.height) * fixedPoint[1],
  };
}

function centerOf(shape) {
  return { x: Number(shape.x) + Number(shape.width) / 2, y: Number(shape.y) + Number(shape.height) / 2 };
}

function stableId(value, index) {
  return crypto.createHash('sha1').update(`${value}:${index}`).digest('hex').slice(0, 12);
}

function writeUtf8Atomically(targetPath, content, allowOverwrite) {
  if (fs.existsSync(targetPath) && !allowOverwrite) {
    throw new Error(`目标 Excalidraw 文件已存在，拒绝覆盖：${targetPath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (!allowOverwrite || !fs.existsSync(targetPath)) {
      throw error;
    }
    fs.copyFileSync(temporaryPath, targetPath);
    fs.unlinkSync(temporaryPath);
  }
}

function clamp(value, minimum, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 0.5;
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
