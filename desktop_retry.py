import csv
import json
from collections import OrderedDict
from pathlib import Path
from urllib.parse import unquote, urlparse


FAILURE_CSV_URL_HEADERS = ("语雀路径", "yuque_path")


def extract_failed_document_urls(failure_csv_path):
    csv_path = Path(failure_csv_path).expanduser().resolve()
    if not csv_path.is_file():
        raise FileNotFoundError(f"失败日志 CSV 不存在：{csv_path}")

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError("失败日志 CSV 缺少表头，无法识别语雀文档路径。")

        url_column = _resolve_column_name(reader.fieldnames, FAILURE_CSV_URL_HEADERS)
        if not url_column:
            raise ValueError("失败日志 CSV 中未找到“语雀路径”列，无法生成重导列表。")

        ordered_urls = OrderedDict()
        row_count = 0
        for row in reader:
            row_count += 1
            raw_url = str((row or {}).get(url_column) or "").strip()
            normalized_url = _normalize_document_url(raw_url)
            if normalized_url:
                ordered_urls.setdefault(normalized_url, normalized_url)

    document_urls = list(ordered_urls.values())
    if not document_urls:
        raise ValueError("失败日志 CSV 中没有可重新导出的语雀文档路径。")

    return {
        "failureCsvPath": str(csv_path),
        "outputDir": str(csv_path.parent),
        "rowCount": row_count,
        "documentUrls": document_urls,
    }


def build_retry_export_plan(base_config, failure_csv_path, books):
    extracted = extract_failed_document_urls(failure_csv_path)
    selected_documents, selected_books, unmatched_documents = _match_documents_to_books(
        extracted["documentUrls"],
        books or [],
    )

    if not selected_documents:
        raise ValueError("失败日志中的文档当前都不在可访问的知识库列表中，暂时无法自动重导。")

    merged = dict(base_config or {})
    merged.update(
        {
            "outputDir": extracted["outputDir"],
            "selectedBooks": selected_books,
            "fullySelectedBooks": [],
            "selectedDocuments": selected_documents,
            "incrementalExport": False,
        }
    )

    return {
        "config": merged,
        "failureCsvPath": extracted["failureCsvPath"],
        "outputDir": extracted["outputDir"],
        "rowCount": extracted["rowCount"],
        "documentCount": len(selected_documents),
        "bookCount": len(selected_books),
        "selectedDocuments": selected_documents,
        "selectedBooks": selected_books,
        "unmatchedDocuments": unmatched_documents,
    }

def build_source_retry_plan(failure_csv_path):
    """仅当失败 CSV 中的每篇文档都能映射到来源状态时，生成不扫描知识库的重试计划。"""
    extracted = extract_failed_document_urls(failure_csv_path)
    state_path = Path(extracted["outputDir"]) / ".yuque-export-state.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None

    records_by_url = {}
    for record in (state.get("documents") or {}).values():
        document_key = str((record or {}).get("documentKey") or "").strip()
        yuque_path = _normalize_document_url((record or {}).get("yuquePath") or "")
        if not document_key.startswith("yuque:") or not yuque_path:
            continue
        records_by_url.setdefault(yuque_path, []).append(record)

    retry_documents = []
    for document_url in extracted["documentUrls"]:
        parsed_url = urlparse(document_url)
        if parsed_url.scheme != "https" or parsed_url.netloc.lower() != "www.yuque.com":
            return None
        matches = records_by_url.get(document_url) or []
        if len(matches) != 1:
            return None
        record = matches[0]
        parts = [unquote(part) for part in urlparse(document_url).path.split("/") if part]
        document_key = str(record.get("documentKey") or "").strip()
        key_parts = document_key.split(":", 2)
        if len(parts) != 3 or len(key_parts) != 3 or not str(record.get("bookId") or "").strip():
            return None
        if str(record.get("status") or "") not in {"failed", "incomplete"}:
            return None

        relations = record.get("sourceRelations")
        if not isinstance(relations, list) or not relations:
            return None
        source_type = "collaboration" if all(
            str(relation.get("sourceType") or "") == "collaboration" for relation in relations
        ) else "favorite"
        retry_documents.append({
            "itemType": "document",
            "documentKey": document_key,
            "documentId": key_parts[2],
            "documentSlug": parts[2],
            "documentType": "Doc",
            "bookId": str(record["bookId"]),
            "bookName": str(record.get("bookName") or ""),
            "owner": parts[0],
            "canonicalUrl": document_url,
            "title": str(record.get("docName") or ""),
            "sourceVersion": str(record.get("sourceVersion") or ""),
            "sourceType": source_type,
            "actionOption": str(relations[0].get("actionOption") or ""),
            "sourceRelations": relations,
            "status": "unverified",
        })

    return {
        "failureCsvPath": extracted["failureCsvPath"],
        "outputDir": extracted["outputDir"],
        "rowCount": extracted["rowCount"],
        "documentCount": len(retry_documents),
        "retrySourceDocuments": retry_documents,
        "selectedDocumentKeys": [document["documentKey"] for document in retry_documents],
    }


def _resolve_column_name(fieldnames, candidates):
    normalized_candidates = {_normalize_header(candidate) for candidate in candidates}
    for fieldname in fieldnames:
        if _normalize_header(fieldname) in normalized_candidates:
            return fieldname
    return ""


def _normalize_header(value):
    return str(value or "").strip().lower().replace("_", "").replace("-", "").replace(" ", "")


def _normalize_document_url(value):
    text = str(value or "").strip().strip('"').strip("'")
    if not text:
        return ""

    parsed = urlparse(text)
    if parsed.scheme and parsed.netloc:
        base = f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"
        path = parsed.path.rstrip("/")
        return f"{base}{path}" if path else base

    return text.rstrip("/")


def _match_documents_to_books(document_urls, books):
    book_lookup = {}
    for book in books:
        book_id = book.get("id")
        user_url = str(book.get("userUrl") or "").strip().strip("/")
        slug = str(book.get("slug") or "").strip().strip("/")
        if book_id is None or not user_url or not slug:
            continue
        book_lookup[(user_url.lower(), slug.lower())] = book_id

    selected_documents = []
    selected_books = OrderedDict()
    unmatched_documents = []

    for document_url in document_urls:
        key = _extract_book_key(document_url)
        book_id = book_lookup.get(key) if key else None
        if book_id is None:
            unmatched_documents.append(document_url)
            continue
        selected_documents.append(document_url)
        selected_books.setdefault(str(book_id), book_id)

    return selected_documents, list(selected_books.values()), unmatched_documents


def _extract_book_key(document_url):
    parsed = urlparse(document_url)
    parts = [segment for segment in parsed.path.split("/") if segment]
    if len(parts) < 3:
        return None
    return parts[0].lower(), parts[1].lower()
