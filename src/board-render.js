import {
  buildBoardIR,
  buildJsonCanvasDocument,
  classifyBoardIR,
  renderFlowchartMermaid,
  renderMindmapMarkdown,
  renderMindmapMarkmap,
} from './board.js';

export const DIAGRAM_EXPORT_MODES = new Set(['auto', 'portable', 'obsidian-editable']);

/**
 * 图形导出模式只描述用户意图；实际格式仍由 BoardIR 分类和插件能力共同决定。
 */
export function normalizeDiagramExportMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DIAGRAM_EXPORT_MODES.has(normalized) ? normalized : 'auto';
}

export function normalizeDiagramSnapshotMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['disabled', 'fallback-only', 'supplemental'].includes(normalized) ? normalized : 'fallback-only';
}

/**
 * 根据语雀原始数据和当前 Obsidian 能力决定唯一的可见主产物。
 * 该函数不写文件，便于单元测试，也避免解析和导出策略耦合。
 */
export function createBoardRenderPlan(diagramData, options = {}) {
  const ir = buildBoardIR(diagramData);
  const classification = classifyBoardIR(ir);
  const mode = normalizeDiagramExportMode(options.diagramExportMode);
  const capabilities = normalizeCapabilities(options.capabilities);
  const snapshotMode = normalizeDiagramSnapshotMode(options.diagramSnapshotMode);
  const base = {
    ir,
    classification: classification.category,
    primaryFormat: classification.primaryFormat,
    mode,
    capabilities,
    markdown: '',
    mermaid: '',
    canvasDocument: null,
    structuredExport: false,
    structuredFormat: '',
    partialStructured: Boolean(ir.partialStructured),
    ignoredElementCount: Number(ir.ignoredElementCount || 0),
    failureReason: ir.reason || '',
    fallbackRequired: Boolean(classification.fallbackRequired),
    pngPreference: snapshotMode,
    pngRequested: false,
    excalidrawRequested: false,
    warnings: [],
  };

  if (ir.kind === 'mindmap') {
    const useMarkmap = mode === 'obsidian-editable' || (mode === 'auto' && capabilities.markmap);
    base.primaryFormat = useMarkmap ? 'markmap' : 'markdown-outline';
    base.markdown = useMarkmap ? renderMindmapMarkmap(ir.roots) : renderMindmapMarkdown(ir.roots);
    base.structuredExport = Boolean(base.markdown);
    base.structuredFormat = useMarkmap ? 'mindmap-markmap' : 'mindmap-markdown';
    base.canvasDocument = options.emitCanvasCompatibility === true ? buildJsonCanvasDocument(ir.roots) : null;
    base.pngRequested = shouldRequestSnapshot(base, snapshotMode);
    if (!useMarkmap && mode === 'obsidian-editable' && !capabilities.markmap) {
      base.warnings.push('未检测到支持 markmap 的 Obsidian 插件，已降级为普通 Markdown 层级。');
    }
    return base;
  }

  if (ir.kind === 'flowchart') {
    if (classification.category === 'simple-flowchart' || classification.category === 'partial-flowchart') {
      base.primaryFormat = 'mermaid';
      base.mermaid = renderFlowchartMermaid({ ...ir, direction: ir.direction });
      base.structuredExport = Boolean(base.mermaid);
      base.structuredFormat = 'mermaid-flowchart';
      base.fallbackRequired = Boolean(ir.partialStructured || classification.category === 'partial-flowchart');
      base.pngRequested = shouldRequestSnapshot(base, snapshotMode);
      if (base.fallbackRequired) {
        base.warnings.push('流程图仅部分结构化，PNG 快照将作为版式对照与回退材料。');
      }
      return base;
    }

    if (classification.category === 'layout-sensitive-flowchart') {
      // 本程序直接生成 Excalidraw 标准 compressed-json 文件，真正的硬条件是目标 Vault 已启用
      // Excalidraw 插件。CLI 的 Vault 注册状态只影响后续自动打开/命令调用，不应阻断文件生成。
      const canGenerateExcalidraw = mode === 'obsidian-editable' && capabilities.excalidraw;
      base.primaryFormat = canGenerateExcalidraw ? 'excalidraw' : 'png';
      base.excalidrawRequested = canGenerateExcalidraw;
      base.fallbackRequired = true;
      base.pngRequested = shouldRequestSnapshot(base, snapshotMode);
      if (!canGenerateExcalidraw) {
        base.warnings.push('流程图保留了大量布局信息，但未检测到已启用的 Excalidraw 插件，已使用 PNG 保真。');
      }
      return base;
    }
  }

  base.primaryFormat = 'png';
  base.fallbackRequired = true;
  base.pngRequested = shouldRequestSnapshot(base, snapshotMode);
  base.warnings.push('画板包含无法稳定结构化的元素，已保留 PNG 与语雀原始 JSON。');
  return base;
}

export function createBoardManifest(plan = {}, options = {}) {
  const ir = plan.ir || {};
  return {
    schemaVersion: 1,
    generatorVersion: String(options.generatorVersion || 'diagram-export-v0.7'),
    sourceHash: String(options.sourceHash || ''),
    generatedHash: String(options.generatedHash || ''),
    sourceType: String(options.sourceType || ''),
    title: String(options.title || ''),
    primaryFormat: String(plan.primaryFormat || ''),
    classification: String(plan.classification || ''),
    structuredFormat: String(plan.structuredFormat || ''),
    structuredExport: Boolean(plan.structuredExport),
    partialStructured: Boolean(plan.partialStructured),
    fallbackRequired: Boolean(plan.fallbackRequired),
    excalidrawRequested: Boolean(plan.excalidrawRequested),
    nodeCount: Number(ir.nodeCount || 0),
    edgeCount: Number(ir.edgeCount || 0),
    sourceElementCount: Number(ir.sourceElementCount || 0),
    structureCompleteness: Number(ir.structureCompleteness || 0),
    layoutCompleteness: Number(ir.layoutCompleteness || 0),
    ignoredElementCount: Number(plan.ignoredElementCount || 0),
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    generatedFiles: Array.isArray(options.generatedFiles) ? options.generatedFiles : [],
  };
}

function normalizeCapabilities(capabilities = {}) {
  return {
    markmap: Boolean(capabilities?.markmap),
    excalidraw: Boolean(capabilities?.excalidraw),
    obsidianCli: Boolean(capabilities?.obsidianCli),
  };
}

function shouldRequestSnapshot(plan, snapshotMode) {
  if (snapshotMode === 'disabled') {
    return false;
  }
  if (snapshotMode === 'supplemental') {
    return true;
  }
  return Boolean(plan.fallbackRequired || !plan.structuredExport || plan.primaryFormat === 'png' || plan.primaryFormat === 'excalidraw');
}
