"""Milestone 2: read tools, Better BibTeX bridge, degraded mode."""

import os
import re
import time
import unittest

from fixtures import build_library
from mcp_client import LegacySession, evaluate

K = {}
S = None
SCRATCH = os.environ.get("TEST_OUT", "/tmp")


def setUpModule():
    global S
    K.update(build_library())
    S = LegacySession()


def set_bbt_enabled(enabled):
    evaluate(f"""
        const {{ AddonManager }} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const addon = await AddonManager.getAddonByID("better-bibtex@iris-advies.com");
        await addon.{'enable' if enabled else 'disable'}();
        Zotero.ZoteroMCP.BBT.resetCache();
        return addon.isActive;
    """)


class Search(unittest.TestCase):
    def test_quick_search(self):
        r = S.tool("search_items", {"query": "Example"})
        self.assertEqual([i["key"] for i in r["items"]], [K["smith"]])
        item = r["items"][0]
        self.assertEqual(item["citekey"], "smithExamplePaper2024")
        self.assertEqual(sorted(c["path"] for c in item["collections"]), ["Project A", "Project B"])

    def test_trashed_excluded(self):
        r = S.tool("search_items", {"query": "Trashed"})
        self.assertEqual(r["total"], 0)

    def test_condition_and_collection(self):
        r = S.tool("search_items", {"conditions": [{"field": "ISBN", "operator": "contains", "value": "148410"}]})
        self.assertEqual([i["key"] for i in r["items"]], [K["jones"]])
        r = S.tool("search_items", {"collection": "Project A/Results"})
        self.assertEqual(sorted(i["key"] for i in r["items"]), sorted([K["jones"], K["lee"]]))
        r = S.tool("search_items", {"collection": K["R"], "include_subcollections": False})
        self.assertEqual([i["key"] for i in r["items"]], [K["jones"]])

    def test_attachment_match_returns_parent(self):
        r = S.tool("search_items", {"query": "Ebook", "mode": "fields"})
        self.assertIn(K["jones"], [i["key"] for i in r["items"]])

    def test_paging(self):
        r = S.tool("search_items", {"conditions": [{"field": "title", "operator": "contains", "value": "e"}], "limit": 2})
        self.assertEqual(r["returned"], 2)
        self.assertGreater(r["total"], 2)

    def test_needs_criteria(self):
        S.tool("search_items", {}, expect_error=True)


class Items(unittest.TestCase):
    def test_get_item(self):
        r = S.tool("get_item", {"key": K["jones"]})
        self.assertEqual(r["citekey"], "jonesBigBook2020")
        self.assertEqual(r["fields"]["ISBN"], "978-3-16-148410-0")
        self.assertEqual(sorted(a["key"] for a in r["attachments"]), sorted([K["jonesPDF"], K["jonesEPUB"]]))
        self.assertEqual(r["collections"], [{"key": K["R"], "path": "Project A/Results"}])

    def test_get_several(self):
        r = S.tool("get_item", {"keys": [K["smith"], K["standalone"]]})
        self.assertEqual(len(r["items"]), 2)
        self.assertEqual(r["items"][1]["attachment"]["content_type"], "application/pdf")

    def test_linked_file_with_foreign_path(self):
        # Zotero's attachmentFilename throws for such paths; get_item must still work
        r = S.tool("get_item", {"key": K["nofiles"]})
        files = {a["key"]: a for a in r["attachments"]}
        self.assertEqual(files[K["winLinked"]]["file_name"], "Windows Paper.pdf")
        self.assertEqual(files[K["winLinked"]]["link_mode"], "linked_file")
        r = S.tool("get_item", {"key": K["winLinked"]})
        self.assertEqual(r["attachment"]["file_name"], "Windows Paper.pdf")
        self.assertNotIn("path", r["attachment"])

    def test_unknown_key(self):
        e = S.tool("get_item", {"key": "ZZZZ2222"}, expect_error=True)
        self.assertIn("not found", e.text)
        e = S.tool("get_item", {"key": "bad"}, expect_error=True)
        self.assertIn("not a valid Zotero key", e.text)


class Collections(unittest.TestCase):
    def test_list(self):
        r = S.tool("list_collections")
        top = {c["name"]: c for c in r["collections"]}
        self.assertEqual(sorted(top), ["Empty", "Project A", "Project B"])
        self.assertEqual(top["Project A"]["collections"][0]["collections"][0]["path"], "Project A/Results/Deep")

    def test_parent_and_ambiguous_path(self):
        r = S.tool("list_collections", {"parent": "Project A", "recursive": False})
        self.assertEqual(r["collections"][0]["subcollection_count"], 1)
        S.tool("create_collection", {"name": "Results", "parent": K["B"]})
        e = S.tool("search_items", {"collection": "Results"}, expect_error=True)
        self.assertIn("not found", e.text)
        e = S.tool("list_collections", {"parent": "Missing/Thing"}, expect_error=True)
        self.assertIn("not found", e.text)


class Tree(unittest.TestCase):
    def test_json_tree(self):
        t = S.tool("get_library_tree")
        self.assertTrue(t["version"].startswith("t1-"))
        self.assertEqual(t["unfiled"], [K["report"]])
        a = next(c for c in t["collections"] if c["key"] == K["A"])
        self.assertEqual(sorted(a["items"]), sorted([K["smith"], K["nofiles"]]))
        self.assertEqual([f["key"] for f in t["items"][K["nofiles"]]["files"]], [])  # linked file excluded
        self.assertEqual(sorted(f["key"] for f in t["items"][K["jones"]]["files"]), sorted([K["jonesPDF"], K["jonesEPUB"]]))
        self.assertEqual(t["items"][K["standalone"]]["files"][0]["key"], K["standalone"])
        self.assertNotIn(K["trashed"], t["items"])
        self.assertTrue(all(f["exists"] for f in t["items"][K["smith"]]["files"]))

    def test_subtree(self):
        t = S.tool("get_library_tree", {"collection": K["R"]})
        self.assertEqual(t["scope"]["collection"], K["R"])
        self.assertEqual(len(t["collections"]), 1)
        self.assertEqual(t["collections"][0]["collections"][0]["key"], K["D"])
        self.assertNotIn("unfiled", t)

    def test_text(self):
        t = S.tool("get_library_tree", {"format": "text"})
        self.assertIn("Deep [%s]" % K["D"], t)
        self.assertIn("(unfiled)", t)

    def test_size_guard(self):
        evaluate("Zotero.Prefs.set('zoteromcp.tree.nodeLimit', 3); return true;")
        try:
            t = S.tool("get_library_tree")
            self.assertTrue(t["partial"])
            self.assertNotIn("items", t)
            full = S.tool("get_library_tree", {"ignore_limit": True})
            self.assertIn("items", full)
        finally:
            evaluate("Zotero.Prefs.set('zoteromcp.tree.nodeLimit', 5000); return true;")

    def test_version_ignores_metadata_edits(self):
        v1 = S.tool("get_library_tree")["version"]
        S.tool("update_item", {"key": K["lee"], "fields": {"abstractNote": "changed"}})
        self.assertEqual(S.tool("get_library_tree")["version"], v1)


class BetterBibTeX(unittest.TestCase):
    def test_citekeys(self):
        r = S.tool("get_citekeys", {"keys": [K["smith"], K["jones"]]})
        self.assertEqual(r["citekeys"], {K["smith"]: "smithExamplePaper2024", K["jones"]: "jonesBigBook2020"})

    def test_bibliography_scopes(self):
        keys = lambda text: sorted(re.findall(r"^@\w+\{([^,]+),", text, re.M))
        lib = S.tool("export_bibliography")
        self.assertEqual(lib["entries"], 6)
        a = S.tool("export_bibliography", {"collection": "Project A"})
        self.assertEqual(keys(a["bibliography"]), ["arxNoFilesHere2021", "jonesBigBook2020", "leeDeepResult2019", "smithExamplePaper2024"])
        flat = S.tool("export_bibliography", {"collection": "Project A", "include_subcollections": False})
        self.assertEqual(keys(flat["bibliography"]), ["arxNoFilesHere2021", "smithExamplePaper2024"])
        bib = S.tool("export_bibliography", {"collection": K["R"], "format": "bibtex"})
        self.assertIn("@book{jonesBigBook2020", bib["bibliography"])

    def test_bibliography_to_file(self):
        target = os.path.join(SCRATCH, "m2", "results.bib")
        r = S.tool("export_bibliography", {"collection": K["R"], "target": target})
        self.assertEqual(r["written"], target)
        with open(target, encoding="utf-8") as f:
            self.assertIn("leeDeepResult2019", f.read())

    def test_settings(self):
        r = S.tool("get_bbt_settings")
        self.assertTrue(r["better_bibtex"]["ready"])
        self.assertIs(r["settings"]["resetKeyOnChange"], False)
        self.assertEqual(r["expected_profile_differences"], [])

    def test_degraded_mode(self):
        set_bbt_enabled(False)
        try:
            time.sleep(1)
            e = S.tool("get_citekeys", {"keys": [K["smith"]]}, expect_error=True)
            self.assertIn("Better BibTeX", e.text)
            e = S.tool("export_bibliography", {}, expect_error=True)
            self.assertIn("Better BibTeX", e.text)
            # Everything else keeps working
            self.assertEqual(S.tool("search_items", {"query": "Example"})["total"], 1)
            r = S.tool("get_bbt_settings")
            self.assertFalse(r["better_bibtex"]["active"])
        finally:
            set_bbt_enabled(True)
            for _ in range(60):
                if S.tool("get_bbt_settings")["better_bibtex"]["ready"]:
                    break
                time.sleep(1)


if __name__ == "__main__":
    unittest.main()
