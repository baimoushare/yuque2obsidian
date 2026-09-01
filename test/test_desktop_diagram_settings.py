import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import desktop_app
from desktop_app import DesktopApi


class DesktopDiagramSettingsTests(unittest.TestCase):
    def test_default_settings_enable_safe_diagram_defaults(self):
        settings = DesktopApi()._default_settings()

        self.assertEqual(settings["diagramExportMode"], "auto")
        self.assertEqual(settings["diagramSnapshotMode"], "fallback-only")

    def test_invalid_diagram_settings_are_normalized_without_touching_other_values(self):
        settings = DesktopApi()._normalize_settings(
            {
                "outputDir": "D:/exports",
                "diagramExportMode": "unsupported-mode",
                "diagramSnapshotMode": "always",
            }
        )

        self.assertEqual(settings["outputDir"], "D:/exports")
        self.assertEqual(settings["diagramExportMode"], "auto")
        self.assertEqual(settings["diagramSnapshotMode"], "fallback-only")

    def test_supported_editable_mode_is_preserved(self):
        settings = DesktopApi()._normalize_settings(
            {"diagramExportMode": "Obsidian-Editable", "diagramSnapshotMode": "supplemental"}
        )

        self.assertEqual(settings["diagramExportMode"], "obsidian-editable")
        self.assertEqual(settings["diagramSnapshotMode"], "supplemental")

    def test_load_settings_accepts_utf8_bom(self):
        """历史桌面配置带 BOM 时仍应能加载默认图形导出模式。"""
        with TemporaryDirectory() as temp_dir:
            settings_path = Path(temp_dir) / "desktop.settings.json"
            settings_path.write_text('{"diagramExportMode": "auto"}', encoding="utf-8-sig")

            with patch.object(desktop_app, "SETTINGS_FILE", settings_path):
                settings = DesktopApi().loadSettings()

        self.assertEqual(settings["diagramExportMode"], "auto")


if __name__ == "__main__":
    unittest.main()
