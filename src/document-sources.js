const YUQUE_ORIGIN = 'https://www.yuque.com';
const MARKS_ENDPOINT = `${YUQUE_ORIGIN}/api/mine/marks`;
const MAX_MARKS_PAGE_SIZE = 100;

/**
 * 按收藏页已观察到的参数构造单页请求；不跟随分页，也不展开知识库。
 */
export function buildMarksPageUrl({ offset = 0, limit = MAX_MARKS_PAGE_SIZE, type = 'all' } = {}) {
  const normalizedOffset = Number(offset);
  const normalizedLimit = Number(limit);
  if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0) {
    throw new Error('收藏列表 offset 必须是非负整数。');
  }
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > MAX_MARKS_PAGE_SIZE) {
    throw new Error(`收藏列表 limit 必须在 1 到 ${MAX_MARKS_PAGE_SIZE} 之间。`);
  }
  if (type !== 'all') {
    throw new Error('当前探针仅支持已观察到的 type=all 请求。');
  }

  const url = new URL(MARKS_ENDPOINT);
  url.searchParams.set('offset', String(normalizedOffset));
  url.searchParams.set('limit', String(normalizedLimit));
  url.searchParams.set('type', type);
  return url.toString();
}

/**
 * 只提取用于确认接口契约的结构摘要，不输出收藏标题、URL 或用户标识。
 */
export function summarizeMarksPayload(payload) {
  const actions = payload?.data?.actions;
  if (!Array.isArray(actions)) {
    throw new Error('收藏列表响应缺少 data.actions 数组。');
  }

  const countValues = (key) => Object.fromEntries(actions.reduce((counts, item) => {
    const value = String(item?.[key] ?? 'unknown');
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map()));
  const actionFields = new Set();
  const targetFieldsByType = new Map();
  let missingTargetCount = 0;
  for (const item of actions) {
    if (!item || typeof item !== 'object') continue;
    Object.keys(item).forEach((key) => actionFields.add(key));
    if (!item.target || typeof item.target !== 'object') {
      missingTargetCount += 1;
      continue;
    }

    const targetType = String(item.target_type ?? 'unknown');
    if (!targetFieldsByType.has(targetType)) targetFieldsByType.set(targetType, new Set());
    Object.keys(item.target).forEach((key) => targetFieldsByType.get(targetType).add(key));
  }
  const actionTag = payload?.data?.actionTag;

  return {
    total: actions.length,
    missingTargetCount,
    actionNames: countValues('action_name'),
    // action_option 是区分普通收藏与协作条目的已观察字段（collaboration_Doc_doc / collaboration_Doc_sheet）。
    actionOptions: countValues('action_option'),
    targetTypes: countValues('target_type'),
    actionFields: [...actionFields].sort(),
    targetFieldsByType: Object.fromEntries(
      [...targetFieldsByType.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, fields]) => [type, [...fields].sort()]),
    ),
    actionTagFields: actionTag && typeof actionTag === 'object'
      ? Object.keys(actionTag).sort()
      : [],
  };
}

export function findMissingTargetActionIds(payload) {
  const actions = payload?.data?.actions;
  if (!Array.isArray(actions)) {
    throw new Error('收藏列表响应缺少 data.actions 数组。');
  }
  return actions
    .filter((action) => !action?.target || typeof action.target !== 'object')
    .map((action) => String(action?.id ?? ''))
    .filter(Boolean);
}

/**
 * 将当前页收藏项转成文档级选择项；知识库入口和缺少 target 的旧条目只标注，不尝试展开或补查。
 */
export function normalizeMarkActions(payload) {
  const actions = payload?.data?.actions;
  if (!Array.isArray(actions)) {
    throw new Error('收藏列表响应缺少 data.actions 数组。');
  }

  return actions.map((action) => {
    const target = action?.target;
    const targetType = String(action?.target_type ?? '');
    const actionOption = String(action?.action_option ?? '');
    const sourceType = actionOption.startsWith('collaboration_') ? 'collaboration' : 'favorite';

    if (targetType === 'Book') {
      return {
        itemType: 'book-entry',
        sourceType,
        status: 'not-expanded',
      };
    }

    if (targetType !== 'Doc' || !target || typeof target !== 'object') {
      return {
        itemType: targetType === 'Doc' ? 'document' : 'unsupported',
        sourceType,
        status: targetType === 'Doc' ? 'unresolved-target' : 'unsupported-target',
      };
    }

    const documentId = String(target.id ?? '').trim();
    const documentSlug = String(target.slug ?? '').trim();
    const bookId = String(target.book_id ?? '').trim();
    const bookSlug = String(target.book?.slug ?? '').trim();
    const userSlug = String(target.book?.user?.login ?? '').trim();

    if (!documentId || !documentSlug || !bookId || !bookSlug || !userSlug) {
      return {
        itemType: 'document',
        sourceType,
        status: 'incomplete-metadata',
      };
    }

    return {
      itemType: 'document',
      documentKey: `yuque:${bookId}:${documentId}`,
      documentId,
      documentSlug,
      documentType: String(target.type ?? 'Doc'),
      bookId,
      bookName: String(target.book?.name ?? ''),
      owner: userSlug,
      canonicalUrl: `${YUQUE_ORIGIN}/${encodeURIComponent(userSlug)}/${encodeURIComponent(bookSlug)}/${encodeURIComponent(documentSlug)}`,
      title: String(target.title ?? action.title ?? ''),
      sourceVersion: String(target.content_updated_at ?? '').trim(),
      sourceType,
      actionOption,
      status: 'unverified',
    };
  });
}

/**
 * 以站点内 bookId + documentId 去重，不按标题合并；同时保留收藏/协作来源关系。
 */
export function deduplicateDocumentEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('文档来源条目必须是数组。');
  }

  const documents = new Map();
  const excluded = [];
  for (const entry of entries) {
    if (entry?.itemType !== 'document' || entry?.status !== 'unverified') {
      excluded.push(entry);
      continue;
    }
    if (!entry.documentKey || !entry.canonicalUrl) {
      excluded.push({ ...entry, status: entry?.status || 'incomplete-metadata' });
      continue;
    }

    const sourceRelations = Array.isArray(entry.sourceRelations) && entry.sourceRelations.length > 0
      ? entry.sourceRelations
      : [{ sourceType: entry.sourceType, actionOption: entry.actionOption }];
    const existing = documents.get(entry.documentKey);
    if (!existing) {
      documents.set(entry.documentKey, {
        ...entry,
        sourceRelations: sourceRelations.map((relation) => ({ ...relation })),
      });
      continue;
    }

    if (existing.canonicalUrl !== entry.canonicalUrl) {
      throw new Error(`文档身份 ${entry.documentKey} 对应多个规范地址；拒绝自动合并。`);
    }
    for (const sourceRelation of sourceRelations) {
      if (!existing.sourceRelations.some((relation) =>
        relation.sourceType === sourceRelation.sourceType && relation.actionOption === sourceRelation.actionOption)) {
        existing.sourceRelations.push({ ...sourceRelation });
      }
    }
  }

  return {
    documents: [...documents.values()],
    excluded,
  };
}

export async function fetchMarksPage(client, options = {}) {
  const url = buildMarksPageUrl(options);
  return summarizeMarksPayload(await client.getJson(url));
}

/**
 * 按 offset 分页获取收藏项；达到本地安全上限或发现分页异常时明确失败，不返回伪完整结果。
 */
export async function fetchAllMarks(client, {
  pageSize = MAX_MARKS_PAGE_SIZE,
  maxItems = 500,
  control = null,
  shouldStop = null,
  onProgress = null,
} = {}) {
  const normalizedPageSize = Number(pageSize);
  const normalizedMaxItems = Number(maxItems);
  if (!Number.isInteger(normalizedPageSize) || normalizedPageSize < 1 || normalizedPageSize > MAX_MARKS_PAGE_SIZE) {
    throw new Error(`收藏列表 pageSize 必须在 1 到 ${MAX_MARKS_PAGE_SIZE} 之间。`);
  }
  if (!Number.isInteger(normalizedMaxItems) || normalizedMaxItems < 1) {
    throw new Error('收藏列表 maxItems 必须是正整数。');
  }

  const actions = [];
  const seenIds = new Set();
  let totalItems = null;
  let offset = 0;
  let pagesRead = 0;

  const isStopRequested = () =>
    (typeof shouldStop === 'function' && shouldStop() === true)
    || control?.getAction?.() === 'stop';

  while (totalItems === null || offset < totalItems) {
    if (isStopRequested()) {
      return {
        totalItems,
        actions,
        cancelled: true,
        pagesRead,
      };
    }
    if (offset >= normalizedMaxItems) {
      throw new Error(`收藏列表超过本地安全上限 ${normalizedMaxItems} 条；结果不完整，已停止。`);
    }

    const limit = Math.min(normalizedPageSize, normalizedMaxItems - offset);
    const payload = await client.getJson(buildMarksPageUrl({ offset, limit }));
    if (isStopRequested()) {
      // 请求期间收到停止信号时，不提交刚返回的页面，避免把取消竞争误记成完整扫描。
      return {
        totalItems,
        actions,
        cancelled: true,
        pagesRead,
      };
    }
    const pageActions = payload?.data?.actions;
    const rawTotal = payload?.data?.totalItems;
    const reportedTotal = rawTotal;
    if (
      !Array.isArray(pageActions)
      || !Number.isSafeInteger(reportedTotal)
      || reportedTotal < 0
    ) {
      throw new Error('收藏列表分页响应缺少有效的 data.actions 或 data.totalItems。');
    }
    if (totalItems === null) {
      totalItems = reportedTotal;
      if (totalItems > normalizedMaxItems) {
        throw new Error(`收藏列表共 ${totalItems} 条，超过本地安全上限 ${normalizedMaxItems} 条；已停止。`);
      }
    } else if (reportedTotal !== totalItems) {
      throw new Error('收藏列表分页期间 totalItems 发生变化；结果不完整，已停止。');
    }

    if (pageActions.length === 0 && offset < totalItems) {
      throw new Error(`收藏列表在 offset=${offset} 返回空页；结果不完整，已停止。`);
    }

    for (const action of pageActions) {
      const id = String(action?.id ?? '').trim();
      if (!id) {
        throw new Error('收藏列表分页项缺少稳定 id；无法验证分页完整性，已停止。');
      }
      if (seenIds.has(id)) {
        throw new Error('收藏列表分页出现重复条目；结果不完整，已停止。');
      }
      seenIds.add(id);
      actions.push(action);
    }

    offset += pageActions.length;
    pagesRead += 1;
    onProgress?.({
      completedItems: offset,
      totalItems,
      pageCount: pagesRead,
    });
    if (isStopRequested()) {
      return {
        totalItems,
        actions,
        cancelled: true,
        pagesRead,
      };
    }
    if (offset < totalItems && pageActions.length < limit) {
      throw new Error(`收藏列表在 offset=${offset} 前返回短页；结果不完整，已停止。`);
    }
  }

  if (actions.length !== totalItems) {
    throw new Error(`收藏列表仅取得 ${actions.length}/${totalItems} 条；结果不完整，已停止。`);
  }

  return { totalItems, actions };
}
