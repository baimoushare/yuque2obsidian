import tempfile
import unittest
from pathlib import Path

from desktop_retry import build_retry_export_plan, extract_failed_document_urls


class DesktopRetryTests(unittest.TestCase):
    def test_extract_failed_document_urls_deduplicates_urls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "export-failures-latest.csv"
            csv_path.write_text(
                "\ufeff记录时间,知识库名称,笔记名称,语雀路径\n"
                "2026-04-08T13:46:03.990Z,职业工作,文档A,https://www.yuque.com/baimoushare/gongzuo/doc-a\n"
                "2026-04-08T13:46:04.990Z,职业工作,文档A,https://www.yuque.com/baimoushare/gongzuo/doc-a/\n"
                "2026-04-08T13:46:05.990Z,AI,文档B,https://www.yuque.com/baimoushare/ai/doc-b\n",
                encoding="utf-8",
            )

            result = extract_failed_document_urls(csv_path)

            self.assertEqual(result["outputDir"], temp_dir)
            self.assertEqual(result["rowCount"], 3)
            self.assertEqual(
                result["documentUrls"],
                [
                    "https://www.yuque.com/baimoushare/gongzuo/doc-a",
                    "https://www.yuque.com/baimoushare/ai/doc-b",
                ],
            )

    def test_build_retry_export_plan_matches_books_and_forces_full_reexport(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "export-failures-latest.csv"
            csv_path.write_text(
                "\ufeff记录时间,知识库名称,笔记名称,语雀路径\n"
                "2026-04-08T13:46:03.990Z,职业工作,文档A,https://www.yuque.com/baimoushare/gongzuo/doc-a\n"
                "2026-04-08T13:46:05.990Z,AI,文档B,https://www.yuque.com/baimoushare/ai/doc-b\n",
                encoding="utf-8",
            )
            books = [
                {"id": 10, "name": "职业工作", "slug": "gongzuo", "userUrl": "baimoushare"},
                {"id": 20, "name": "AI", "slug": "ai", "userUrl": "baimoushare"},
            ]

            plan = build_retry_export_plan({"incrementalExport": True, "outputDir": "ignored"}, csv_path, books)

            self.assertEqual(plan["documentCount"], 2)
            self.assertEqual(plan["bookCount"], 2)
            self.assertEqual(plan["selectedBooks"], [10, 20])
            self.assertEqual(plan["selectedDocuments"][0], "https://www.yuque.com/baimoushare/gongzuo/doc-a")
            self.assertEqual(plan["config"]["outputDir"], temp_dir)
            self.assertFalse(plan["config"]["incrementalExport"])
            self.assertEqual(plan["config"]["fullySelectedBooks"], [])

    def test_build_retry_export_plan_reports_unmatched_documents(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "export-failures-latest.csv"
            csv_path.write_text(
                "\ufeff记录时间,知识库名称,笔记名称,语雀路径\n"
                "2026-04-08T13:46:03.990Z,职业工作,文档A,https://www.yuque.com/baimoushare/gongzuo/doc-a\n"
                "2026-04-08T13:46:04.990Z,未知知识库,文档X,https://www.yuque.com/baimoushare/missing/doc-x\n",
                encoding="utf-8",
            )
            books = [
                {"id": 10, "name": "职业工作", "slug": "gongzuo", "userUrl": "baimoushare"},
            ]

            plan = build_retry_export_plan({}, csv_path, books)

            self.assertEqual(plan["selectedBooks"], [10])
            self.assertEqual(
                plan["unmatchedDocuments"],
                ["https://www.yuque.com/baimoushare/missing/doc-x"],
            )


if __name__ == "__main__":
    unittest.main()
