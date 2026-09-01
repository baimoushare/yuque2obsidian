import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoardIR } from '../src/board.js';
import {
  buildExcalidrawMarkdown,
  buildExcalidrawScene,
  readExcalidrawScene,
  validateExcalidrawScene,
  writeExcalidrawDrawing,
} from '../src/excalidraw.js';

function createDiagram() {
  return {
    body: [
      { id: 'start', type: 'geometry', shape: 'start-end', html: '开始', x: -50, y: 0, width: 100, height: 30 },
      { id: 'branch', type: 'geometry', shape: 'process', html: '分支', x: 180, y: 0, width: 100, height: 30 },
      { id: 'finish', type: 'geometry', shape: 'process', html: '结束', x: 180, y: 140, width: 100, height: 30 },
      { id: 'a1', type: 'line', shape: 'elbow', source: { id: 'start', connection: 'E' }, target: { id: 'branch', connection: 'W', marker: 'arrow' } },
      { id: 'a2', type: 'line', shape: 'elbow', source: { id: 'branch', connection: 'S' }, target: { id: 'finish', connection: 'N', marker: 'arrow' } },
    ],
  };
}

test('buildExcalidrawScene creates bound text and fully bound arrows from BoardIR', () => {
  const ir = buildBoardIR(createDiagram());
  const scene = buildExcalidrawScene(ir, { timestamp: 1 });
  const validation = validateExcalidrawScene(scene, { nodeCount: 3, edgeCount: 2 });
  const arrows = scene.elements.filter((element) => element.type === 'arrow');

  assert.equal(validation.valid, true);
  assert.equal(validation.boundTextCount, 3);
  assert.equal(validation.fullyBoundArrowCount, 2);
  assert.equal(arrows[0].elbowed, true);
  assert.equal(arrows[1].elbowed, true);
  assert.ok(arrows[0].startBinding.fixedPoint[0] > arrows[0].endBinding.fixedPoint[0]);
});

test('Excalidraw Markdown round-trips through compressed-json', () => {
  const scene = buildExcalidrawScene(buildBoardIR(createDiagram()), { timestamp: 1 });
  const markdown = buildExcalidrawMarkdown(scene);
  const decoded = readExcalidrawScene(markdown);

  assert.equal(decoded.elements.length, scene.elements.length);
  assert.equal(validateExcalidrawScene(decoded, { nodeCount: 3, edgeCount: 2 }).valid, true);
});

test('导出优先保留语雀原始折线路径，不重新取几何中点', () => {
  const diagram = {
    body: [
      { id: 'source', type: 'geometry', shape: 'process', html: '源', x: 0, y: 0, width: 100, height: 40 },
      { id: 'target', type: 'geometry', shape: 'process', html: '目标', x: 240, y: 120, width: 100, height: 40 },
      { id: 'route', type: 'line', shape: 'elbow', points: [[100, 20], [160, 20], [160, 140], [240, 140]], source: { id: 'source', connection: 'E' }, target: { id: 'target', connection: 'W', marker: 'arrow' } },
    ],
  };
  const scene = buildExcalidrawScene(buildBoardIR(diagram), { timestamp: 1, scale: 1 });
  const arrow = scene.elements.find((element) => element.type === 'arrow');
  assert.equal(arrow.elbowed, false);
  assert.equal(arrow.startBinding.mode, 'inside');
  assert.equal(arrow.endBinding.mode, 'inside');
  assert.deepEqual(arrow.points, [[0, 0], [60, 0], [60, 120], [122, 120]]);
});

test('没有原始路径的斜向连线默认使用正交拐角箭头', () => {
  const diagram = {
    body: [
      { id: 'source', type: 'geometry', shape: 'process', html: '源', x: 0, y: 0, width: 100, height: 40 },
      { id: 'target', type: 'geometry', shape: 'process', html: '目标', x: 220, y: 120, width: 100, height: 40 },
      { id: 'route', type: 'line', shape: 'elbow', source: { id: 'source', connection: 'E' }, target: { id: 'target', connection: 'W', marker: 'arrow' } },
    ],
  };
  const scene = buildExcalidrawScene(buildBoardIR(diagram), { timestamp: 1, scale: 1 });
  const arrow = scene.elements.find((element) => element.type === 'arrow');

  assert.equal(arrow.elbowed, true);
  assert.equal(arrow.startBinding.mode, 'orbit');
  assert.equal(arrow.endBinding.mode, 'orbit');
  assert.ok(arrow.points.length > 2);
  for (let index = 1; index < arrow.points.length; index += 1) {
    const previous = arrow.points[index - 1];
    const current = arrow.points[index];
    assert.ok(previous[0] === current[0] || previous[1] === current[1]);
  }
});

test('一对多和多对一连线统一使用同一边中心锚点', () => {
  const diagram = {
    body: [
      { id: 'source', type: 'geometry', shape: 'process', html: '源', x: 0, y: 100, width: 100, height: 40 },
      { id: 'target-a', type: 'geometry', shape: 'process', html: '目标 A', x: 220, y: 0, width: 100, height: 40 },
      { id: 'target-b', type: 'geometry', shape: 'process', html: '目标 B', x: 220, y: 100, width: 100, height: 40 },
      { id: 'target-c', type: 'geometry', shape: 'process', html: '目标 C', x: 220, y: 200, width: 100, height: 40 },
      { id: 'merge', type: 'geometry', shape: 'process', html: '汇', x: 500, y: 100, width: 100, height: 40 },
      { id: 'fan-a', type: 'line', shape: 'elbow', source: { id: 'source', connection: 'E' }, target: { id: 'target-a', connection: [0, 0.2], marker: 'arrow' } },
      { id: 'fan-b', type: 'line', shape: 'elbow', source: { id: 'source', connection: [1, 0.8] }, target: { id: 'target-b', connection: 'W', marker: 'arrow' } },
      { id: 'fan-c', type: 'line', shape: 'elbow', source: { id: 'source', connection: 'E' }, target: { id: 'target-c', connection: 'W', marker: 'arrow' } },
      { id: 'merge-a', type: 'line', shape: 'elbow', source: { id: 'target-a', connection: 'E' }, target: { id: 'merge', connection: [0, 0.2], marker: 'arrow' } },
      { id: 'merge-b', type: 'line', shape: 'elbow', source: { id: 'target-b', connection: 'E' }, target: { id: 'merge', connection: 'W', marker: 'arrow' } },
      { id: 'merge-c', type: 'line', shape: 'elbow', source: { id: 'target-c', connection: 'E' }, target: { id: 'merge', connection: [0, 0.8], marker: 'arrow' } },
    ],
  };
  const scene = buildExcalidrawScene(buildBoardIR(diagram), { timestamp: 1 });
  const arrows = scene.elements.filter((element) => element.type === 'arrow');
  const sourceArrows = arrows.filter((arrow) => arrow.startBinding.elementId === scene.elements.find((element) => element.type === 'rectangle' && element.x === 60 && element.y === 178)?.id);
  assert.equal(sourceArrows.length, 3);
  assert.deepEqual(sourceArrows.map((arrow) => arrow.startBinding.fixedPoint), [[1, 0.5], [1, 0.5], [1, 0.5]]);
  const mergeShape = scene.elements.find((element) => element.type === 'rectangle' && element.x === 650 && element.y === 178);
  const mergeArrows = arrows.filter((arrow) => arrow.endBinding.elementId === mergeShape.id);
  assert.equal(mergeArrows.length, 3);
  assert.deepEqual(mergeArrows.map((arrow) => arrow.endBinding.fixedPoint), [[0, 0.5], [0, 0.5], [0, 0.5]]);
});

test('同一节点混合方向连线分别使用对应边中心', () => {
  const diagram = {
    body: [
      { id: 'center', type: 'geometry', shape: 'process', html: '中心', x: 0, y: 0, width: 100, height: 40 },
      { id: 'right-a', type: 'geometry', shape: 'process', html: '右 A', x: 220, y: -60, width: 100, height: 40 },
      { id: 'right-b', type: 'geometry', shape: 'process', html: '右 B', x: 220, y: 60, width: 100, height: 40 },
      { id: 'down', type: 'geometry', shape: 'process', html: '下', x: 0, y: 180, width: 100, height: 40 },
      { id: 'r1', type: 'line', shape: 'elbow', source: { id: 'center', connection: 'E' }, target: { id: 'right-a', connection: 'W', marker: 'arrow' } },
      { id: 'r2', type: 'line', shape: 'elbow', source: { id: 'center', connection: 'E' }, target: { id: 'right-b', connection: 'W', marker: 'arrow' } },
      { id: 'd1', type: 'line', shape: 'elbow', source: { id: 'center', connection: 'S' }, target: { id: 'down', connection: 'N', marker: 'arrow' } },
    ],
  };
  const scene = buildExcalidrawScene(buildBoardIR(diagram), { timestamp: 1 });
  const arrows = scene.elements.filter((element) => element.type === 'arrow');
  const centerText = scene.elements.find((element) => element.type === 'text' && element.text === '中心');
  const centerShape = scene.elements.find((element) => element.id === centerText.containerId);
  const centerArrows = arrows.filter((arrow) => arrow.startBinding.elementId === centerShape.id);
  assert.deepEqual(centerArrows.map((arrow) => arrow.startBinding.fixedPoint), [[1, 0.5], [1, 0.5], [0.5, 1]]);
});

test('缺少原始路径且直线穿过节点时使用外部正交避障路径', () => {
  const diagram = {
    body: [
      { id: 'source', type: 'geometry', shape: 'process', html: '源', x: 0, y: 100, width: 100, height: 40 },
      { id: 'obstacle', type: 'geometry', shape: 'process', html: '中间节点', x: 220, y: 40, width: 100, height: 160 },
      { id: 'target', type: 'geometry', shape: 'process', html: '目标', x: 440, y: 100, width: 100, height: 40 },
      { id: 'route', type: 'line', shape: 'elbow', source: { id: 'source', connection: 'E' }, target: { id: 'target', connection: 'W', marker: 'arrow' } },
    ],
  };
  const scene = buildExcalidrawScene(buildBoardIR(diagram), { timestamp: 1, scale: 1 });
  const arrow = scene.elements.find((element) => element.type === 'arrow');
  const obstacle = scene.elements.find((element) => element.type === 'rectangle' && element.x === 280 && element.y === 60);

  assert.equal(arrow.startBinding.fixedPoint[0], 1);
  assert.equal(arrow.endBinding.fixedPoint[0], 0);
  assert.equal(arrow.elbowed, true);
  assert.equal(arrow.startBinding.mode, 'orbit');
  assert.equal(arrow.endBinding.mode, 'orbit');
  assert.ok(arrow.points.length > 2);
  const absolutePoints = arrow.points.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y }));
  const verticalPoints = absolutePoints.filter((point, index) => index > 0 && point.x === absolutePoints[index - 1].x);
  assert.ok(verticalPoints.some((point) => point.x < obstacle.x + obstacle.width + 2));
  for (let index = 1; index < arrow.points.length; index += 1) {
    const start = { x: arrow.x + arrow.points[index - 1][0], y: arrow.y + arrow.points[index - 1][1] };
    const end = { x: arrow.x + arrow.points[index][0], y: arrow.y + arrow.points[index][1] };
    const left = obstacle.x - 2;
    const right = obstacle.x + obstacle.width + 2;
    const top = obstacle.y - 2;
    const bottom = obstacle.y + obstacle.height + 2;
    const horizontal = start.y === end.y && start.y > top && start.y < bottom && Math.max(start.x, end.x) > left && Math.min(start.x, end.x) < right;
    const vertical = start.x === end.x && start.x > left && start.x < right && Math.max(start.y, end.y) > top && Math.min(start.y, end.y) < bottom;
    assert.equal(horizontal || vertical, false);
  }
});

test('writeExcalidrawDrawing refuses accidental overwrite by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuque-excalidraw-'));
  const target = path.join(root, '流程图.excalidraw.md');
  const ir = buildBoardIR(createDiagram());

  const result = writeExcalidrawDrawing(target, ir, { timestamp: 1 });
  assert.equal(fs.existsSync(target), true);
  assert.equal(result.validation.valid, true);
  assert.throws(() => writeExcalidrawDrawing(target, ir, { timestamp: 2 }), /拒绝覆盖/);
  assert.doesNotThrow(() => writeExcalidrawDrawing(target, ir, { timestamp: 2, allowOverwrite: true }));
});
