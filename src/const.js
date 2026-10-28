/**
 * 语雀目录节点的类型约定。
 *
 * 语雀 /api/catalog_nodes 的 item.type 只会返回 DOC 与 TITLE 两种取值，
 * 属于接口事实，必须原样保留，否则无法与接口响应比对。
 *
 * 导出内核在构建目录树时，还会额外派生两类角色：知识库根节点，以及
 * 「本身是一篇文档、同时又能容纳子节点」的分组。这两类不是接口值，
 * 因此使用本项目自有的标记串，避免与任何外部实现撞名。
 */

// 接口原样值：与语雀响应逐字对应，不可修改。
const API_KIND = Object.freeze({
  DOC: 'DOC',
  TITLE: 'TITLE',
});

/**
 * 目录树节点角色。
 *
 * - Book：知识库根节点，由扫描结果人工构造
 * - Title：纯分组节点，没有对应文档
 * - Document：独立文档节点
 * - TitleDoc：既是分组又是一篇文档，导出时需要同时建目录与写文件
 */
export const type = Object.freeze({
  Book: 'yuque:book-root',
  Title: API_KIND.TITLE,
  Document: API_KIND.DOC,
  TitleDoc: 'yuque:group-with-document',
});
