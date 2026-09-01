import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeFlowchartDiagram,
  analyzeMindmapDiagram,
  buildJsonCanvasDocument,
  extractBoardsFromDocDetail,
  renderFlowchartMermaid,
  renderMindmapMarkdown,
  sanitizeMindmapText,
} from '../src/board.js';

function createMindmapDiagram() {
  return {
    head: {
      version: '2.0.0',
      theme: { name: 'default' },
      rough: { name: 'default' },
    },
    body: [
      {
        id: 'root-1',
        type: 'mindmap',
        html: '\u6839\u8282\u70b9',
        treeEdge: { stroke: '#A287E1' },
        children: [
          {
            id: 'child-1',
            html: '&#8203;\u5b50\u8282\u70b9&nbsp;A',
            children: [],
          },
          {
            id: 'child-2',
            html: '\u5b50\u8282\u70b9 B',
            children: [
              {
                id: 'child-2-1',
                html: '\u5b59\u8282\u70b9',
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createPureFlowchartDiagram() {
  return {
    body: [
      {
        id: 'start',
        type: 'geometry',
        shape: 'roundRect',
        html: '\u5f00\u59cb',
      },
      {
        id: 'decision',
        type: 'geometry',
        shape: 'diamond',
        html: '\u662f\u5426\u901a\u8fc7',
      },
      {
        id: 'done',
        type: 'geometry',
        shape: 'rect',
        html: '\u5b8c\u6210',
      },
      {
        id: 'line-1',
        type: 'line',
        source: { id: 'start' },
        target: { id: 'decision' },
      },
      {
        id: 'line-2',
        type: 'line',
        source: { id: 'decision' },
        target: { id: 'done' },
      },
    ],
  };
}

test('extractBoardsFromDocDetail parses embedded board cards', () => {
  const payload = {
    diagramData: createMindmapDiagram(),
  };
  const docDetail = {
    type: 'Doc',
    format: 'lake',
    content: `<card type="block" name="board" value="data:${encodeURIComponent(JSON.stringify(payload))}" />`,
  };

  const boards = extractBoardsFromDocDetail(docDetail);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].sourceType, 'embedded-card');
  assert.deepEqual(boards[0].diagramData, payload.diagramData);
});

test('extractBoardsFromDocDetail parses board document json', () => {
  const diagramData = createMindmapDiagram();
  const docDetail = {
    type: 'Board',
    format: 'lakeboard',
    title: '\u9879\u76ee\u603b\u4f53\u5927\u7eb2',
    content: JSON.stringify({
      format: 'lakeboard',
      type: 'Board',
      version: '1.0',
      diagramData,
    }),
  };

  const boards = extractBoardsFromDocDetail(docDetail);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].sourceType, 'board-document');
  assert.equal(boards[0].title, '\u9879\u76ee\u603b\u4f53\u5927\u7eb2');
  assert.deepEqual(boards[0].diagramData, diagramData);
});

test('sanitizeMindmapText decodes html entities and removes zero width characters', () => {
  assert.equal(sanitizeMindmapText('&#8203;A&nbsp;&amp;&lt;B&gt;'), 'A &<B>');
});

test('analyzeMindmapDiagram and renderMindmapMarkdown handle pure mindmaps', () => {
  const analysis = analyzeMindmapDiagram(createMindmapDiagram());

  assert.equal(analysis.isPureMindmap, true);
  assert.equal(analysis.reason, '');
  assert.equal(
    renderMindmapMarkdown(analysis.roots),
    ['- \u6839\u8282\u70b9', '  - \u5b50\u8282\u70b9 A', '  - \u5b50\u8282\u70b9 B', '    - \u5b59\u8282\u70b9'].join('\n'),
  );
});

test('analyzeMindmapDiagram keeps structured export for mindmap trees with top-level line helpers', () => {
  const diagramData = createMindmapDiagram();
  diagramData.body.push({
    id: 'line-1',
    type: 'line',
    stroke: '#999999',
  });

  const analysis = analyzeMindmapDiagram(diagramData);

  assert.equal(analysis.isPureMindmap, true);
  assert.equal(analysis.reason, '');
});

test('analyzeMindmapDiagram rejects unsupported freeform board nodes', () => {
  const analysis = analyzeMindmapDiagram({
    body: [
      {
        id: 'root',
        type: 'mindmap',
        html: '\u6839\u8282\u70b9',
        children: [
          {
            id: 'sticky-1',
            type: 'sticky-note',
            html: '\u4fbf\u7b7e',
            children: [],
          },
        ],
      },
    ],
  });

  assert.equal(analysis.isPureMindmap, false);
  assert.match(analysis.reason, /unsupported-node-type:sticky-note/);
});

test('buildJsonCanvasDocument emits stable nodes and edges for mindmap trees', () => {
  const analysis = analyzeMindmapDiagram(createMindmapDiagram());
  const canvas = buildJsonCanvasDocument(analysis.roots);

  assert.equal(canvas.nodes.length, 4);
  assert.equal(canvas.edges.length, 3);
  assert.deepEqual(
    canvas.edges.map((edge) => [edge.fromSide, edge.toSide]),
    [
      ['right', 'left'],
      ['right', 'left'],
      ['right', 'left'],
    ],
  );
  assert.equal(new Set(canvas.nodes.map((node) => node.id)).size, canvas.nodes.length);
});

test('analyzeFlowchartDiagram and renderFlowchartMermaid handle pure flowcharts', () => {
  const analysis = analyzeFlowchartDiagram(createPureFlowchartDiagram());

  assert.equal(analysis.isFlowchart, true);
  assert.equal(analysis.reason, '');
  assert.equal(analysis.partialStructured, false);
  assert.equal(analysis.ignoredElementCount, 0);
  assert.match(renderFlowchartMermaid(analysis), /^flowchart TD/m);
  assert.match(renderFlowchartMermaid(analysis), /n1\("开始"\)/);
  assert.match(renderFlowchartMermaid(analysis), /n2\{"是否通过"\}/);
  assert.match(renderFlowchartMermaid(analysis), /n1 --> n2/);
  assert.match(renderFlowchartMermaid(analysis), /n2 --> n3/);
});

test('analyzeFlowchartDiagram keeps partial structured export for mixed boards', () => {
  const diagram = createPureFlowchartDiagram();
  diagram.body.push(
    {
      id: 'decor-1',
      type: 'geometry',
      shape: 'rect',
      html: '<div>&nbsp;</div>',
    },
    {
      id: 'floating-text',
      type: 'text',
      html: '\u5907\u6ce8',
    },
    {
      id: 'image-1',
      type: 'image',
      image: { src: 'https://example.com/demo.png' },
    },
    {
      id: 'line-bad',
      type: 'line',
      source: { id: 'missing-source' },
      target: { id: 'done' },
    },
  );

  const analysis = analyzeFlowchartDiagram(diagram);

  assert.equal(analysis.isFlowchart, true);
  assert.equal(analysis.partialStructured, true);
  assert.equal(analysis.ignoredElementCount, 4);
  assert.match(renderFlowchartMermaid(analysis), /flowchart TD/);
});

test('analyzeFlowchartDiagram rejects graphs without enough connectable structure', () => {
  const analysis = analyzeFlowchartDiagram({
    body: [
      {
        id: 'node-1',
        type: 'geometry',
        shape: 'rect',
        html: '\u5355\u8282\u70b9',
      },
    ],
  });

  assert.equal(analysis.isFlowchart, false);
  assert.equal(analysis.reason, 'insufficient-flow-graph');
});
