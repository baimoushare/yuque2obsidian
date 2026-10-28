import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFlowchartDiagram, buildBoardIR, classifyBoardIR, renderMindmapMarkmap } from '../src/board.js';
import { createBoardManifest, createBoardRenderPlan } from '../src/board-render.js';

function createPositionedFlowchart({ count = 3, partial = false } = {}) {
  const body = [];
  for (let index = 0; index < count; index += 1) {
    body.push({
      id: `node-${index + 1}`,
      type: 'geometry',
      shape: index === 0 ? 'start-end' : 'process',
      html: `节点 ${index + 1}`,
      x: index * 220,
      y: 20,
      width: 120,
      height: 44,
      fill: { color: '#FFFFFF' },
      stroke: { color: '#585A5A' },
      defaultContentStyle: { color: '#262626' },
    });
    if (index > 0) {
      body.push({
        id: `line-${index}`,
        type: 'line',
        shape: 'elbow',
        source: { id: `node-${index}`, connection: 'E' },
        target: { id: `node-${index + 1}`, connection: [0, 0.5], marker: 'arrow' },
        stroke: { color: '#585A5A' },
      });
    }
  }
  if (partial) {
    body.push({ id: 'floating-note', type: 'text', html: '仅供说明' });
  }
  return { body };
}

function createMindmap() {
  return {
    body: [
      {
        id: 'root',
        type: 'mindmap',
        html: '项目总览',
        children: [{ id: 'child', html: '实施阶段', children: [] }],
      },
    ],
  };
}

test('BoardIR preserves flowchart geometry, style, anchors, and original line type', () => {
  const analysis = analyzeFlowchartDiagram(createPositionedFlowchart());
  const firstNode = analysis.nodes[0];
  const firstEdge = analysis.edges[0];

  assert.deepEqual([firstNode.x, firstNode.y, firstNode.width, firstNode.height], [0, 20, 120, 44]);
  assert.equal(firstNode.fillColor, '#FFFFFF');
  assert.equal(firstNode.strokeColor, '#585A5A');
  assert.equal(firstEdge.sourceAnchor, 'E');
  assert.deepEqual(firstEdge.targetAnchor, [0, 0.5]);
  assert.equal(firstEdge.shape, 'elbow');
});

test('positioned simple flowchart becomes horizontal Mermaid instead of hard-coded TD', () => {
  const ir = buildBoardIR(createPositionedFlowchart());
  const classification = classifyBoardIR(ir);
  const plan = createBoardRenderPlan(createPositionedFlowchart(), { diagramExportMode: 'portable' });

  assert.equal(ir.direction, 'LR');
  assert.equal(classification.category, 'simple-flowchart');
  assert.equal(plan.primaryFormat, 'mermaid');
  assert.match(plan.mermaid, /^flowchart LR/m);
  assert.equal(plan.pngRequested, false);
});

test('partial flowchart keeps Mermaid and requires a PNG fallback', () => {
  const plan = createBoardRenderPlan(createPositionedFlowchart({ partial: true }), {
    diagramExportMode: 'portable',
  });

  assert.equal(plan.classification, 'partial-flowchart');
  assert.equal(plan.primaryFormat, 'mermaid');
  assert.equal(plan.structuredExport, true);
  assert.equal(plan.pngRequested, true);
});

test('layout-sensitive flowchart requests Excalidraw when its target Vault has the Excalidraw plugin', () => {
  const complex = createPositionedFlowchart({ count: 21 });
  const fallbackPlan = createBoardRenderPlan(complex, { diagramExportMode: 'auto' });
  const editablePlan = createBoardRenderPlan(complex, {
    diagramExportMode: 'obsidian-editable',
    // CLI 未注册不妨碍生成标准 .excalidraw.md；插件能力才是硬前提。
    capabilities: { excalidraw: true, obsidianCli: false },
  });

  assert.equal(fallbackPlan.classification, 'layout-sensitive-flowchart');
  assert.equal(fallbackPlan.primaryFormat, 'png');
  assert.equal(editablePlan.primaryFormat, 'excalidraw');
  assert.equal(editablePlan.excalidrawRequested, true);
  assert.equal(editablePlan.pngRequested, true);
});

test('mindmap uses markmap only in an enabled enhanced export', () => {
  const enhanced = createBoardRenderPlan(createMindmap(), {
    diagramExportMode: 'obsidian-editable',
    capabilities: { markmap: true },
  });
  const portable = createBoardRenderPlan(createMindmap(), { diagramExportMode: 'portable' });

  assert.match(enhanced.markdown, /^```markmap/m);
  assert.match(enhanced.markdown, /# 项目总览/);
  assert.equal(enhanced.structuredFormat, 'mindmap-markmap');
  assert.doesNotMatch(portable.markdown, /^```markmap/m);
  assert.equal(renderMindmapMarkmap(buildBoardIR(createMindmap()).roots).includes('实施阶段'), true);
});

test('board manifest records format, structural evidence, and generated files', () => {
  const plan = createBoardRenderPlan(createPositionedFlowchart(), { diagramExportMode: 'portable' });
  const manifest = createBoardManifest(plan, {
    title: '测试流程图',
    sourceHash: 'source-hash',
    generatedFiles: ['board-1.yuque.json'],
  });

  assert.equal(manifest.title, '测试流程图');
  assert.equal(manifest.primaryFormat, 'mermaid');
  assert.equal(manifest.nodeCount, 3);
  assert.equal(manifest.edgeCount, 2);
  assert.deepEqual(manifest.generatedFiles, ['board-1.yuque.json']);
});
