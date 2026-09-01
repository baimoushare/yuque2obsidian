import { type } from './const.js';
import { sanitizeFileName } from './utils.js';

class BookPage {
  constructor(id, uuid, name, url, nodeType, parentUuid, childUuid, siblingUuid, sourceVersion = '') {
    this.id = id;
    this.uuid = uuid;
    this.name = name;
    this.url = url;
    this.type = nodeType;
    this.parent_uuid = parentUuid;
    this.child_uuid = childUuid;
    this.sibling_uuid = siblingUuid;
    this.sourceVersion = sourceVersion;
  }
}

class Book {
  constructor(id, name, slug, userUrl) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.user_url = userUrl;
    this.root = null;
  }
}

export async function getAllBooks(client) {
  const payload = await client.getJson('https://www.yuque.com/api/mine/book_stacks');
  const books = [];

  for (const stack of payload.data ?? []) {
    for (const rawBook of stack.books ?? []) {
      const book = new Book(
        rawBook.id,
        sanitizeFileName(rawBook.name),
        rawBook.slug,
        rawBook.user?.login,
      );
      book.root = await getBookDetail(client, book);
      books.push(book);
    }
  }

  return books;
}

export function filterBooks(books, selectedBooks = []) {
  if (!selectedBooks || selectedBooks.length === 0) {
    return books;
  }

  const selectedSet = new Set(selectedBooks.map((value) => String(value)));
  return books.filter((book) => selectedSet.has(String(book.id)));
}

export function flattenDocumentNodes(node, result = []) {
  if (!node) {
    return result;
  }

  if (node.type === type.Document || node.type === type.TitleDoc) {
    result.push(node);
  }

  for (const child of node.children ?? []) {
    flattenDocumentNodes(child, result);
  }

  return result;
}

export function serializeBooks(books) {
  return books.map((book) => ({
    id: book.id,
    name: book.name,
    slug: book.slug,
    userUrl: book.user_url,
    documentCount: flattenDocumentNodes(book.root).length,
    root: serializeNode(book.root),
  }));
}

function serializeNode(node) {
  if (!node) {
    return null;
  }

  return {
    name: node.name,
    type: node.type,
    url: node.object?.url ?? null,
    id: node.object?.id ?? null,
    sourceVersion: node.object?.sourceVersion ?? '',
    children: (node.children ?? []).map(serializeNode),
  };
}

async function getBookDetail(client, book) {
  const payload = await client.getJson(`https://www.yuque.com/api/catalog_nodes?book_id=${book.id}`);
  const uuidMap = new Map();
  let firstSubItem;

  for (const item of payload.data ?? []) {
    if (firstSubItem === undefined && item.parent_uuid === '') {
      firstSubItem = item;
    }
    const page = new BookPage(
      item.id,
      item.uuid,
      sanitizeFileName(item.title),
      item.url,
      item.type,
      item.parent_uuid,
      item.child_uuid,
      item.sibling_uuid,
      item.updated_at || item.updatedAt || item.version_id || '',
    );
    uuidMap.set(page.uuid, page);
  }

  const root = { name: book.name, type: type.Book, object: book };
  if (firstSubItem) {
    buildDirectoryTree(uuidMap, firstSubItem.uuid, root);
  }

  return root;
}

function buildDirectoryTree(uuidMap, uuid, node) {
  const item = uuidMap.get(uuid);
  if (!item) {
    return;
  }

  const childNode = {
    name: item.name,
    type: item.type,
    object: item,
  };

  if (item.child_uuid) {
    if (item.type === type.Document) {
      childNode.type = type.TitleDoc;
    }
    buildDirectoryTree(uuidMap, item.child_uuid, childNode);
  }

  if (item.sibling_uuid) {
    buildDirectoryTree(uuidMap, item.sibling_uuid, node);
  }

  if (!node.children) {
    node.children = [];
  }
  node.children.push(childNode);
}
