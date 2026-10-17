"""Milestone 6: duplicates, merging, trash, deleting collections, Better BibTeX settings."""

import unittest

from fixtures import build_library
from mcp_client import LegacySession, evaluate

K = {}
S = None


def setUpModule():
    global S
    S = LegacySession()


class Fresh(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        K.clear()
        K.update(build_library())


def is_trashed(key):
    return evaluate(f'return Zotero.Items.getByLibraryAndKey(1, "{key}").deleted;')


def make_duplicate():
    return S.tool("create_item", {
        "item_type": "journalArticle",
        "fields": {"title": "Example Paper", "date": "2024", "DOI": "10.1000/example.1", "volume": "12", "pages": "1-10"},
        "creators": [{"firstName": "Anna", "lastName": "Smith"}],
        "duplicate_force": True, "collections": [K["E"]], "tags": ["dup"],
    })["item"]["key"]


class Duplicates(Fresh):
    def test_find_and_merge(self):
        dup = make_duplicate()
        sets = S.tool("find_duplicates")["sets"]
        self.assertEqual(len(sets), 1)
        self.assertEqual(sorted(i["key"] for i in sets[0]["items"]), sorted([K["smith"], dup]))
        self.assertEqual(sets[0]["suggested_master"], K["smith"])

        preview, result = S.confirm("merge_items", {"master": K["smith"], "others": [dup],
                                                     "fields": {"volume": {"from": dup}, "pages": "1-10"}})
        self.assertEqual(set(preview["fields"]), {"volume", "pages"})
        self.assertEqual(preview["fields"]["volume"]["result"], "12")
        self.assertEqual(preview["citekey"]["kept"], "smithExamplePaper2024")
        self.assertEqual(preview["collections_after"], ["Empty", "Project A", "Project B"])
        self.assertEqual(result["trashed"], [dup])
        self.assertTrue(is_trashed(dup))
        master = S.tool("get_item", {"key": K["smith"]})
        self.assertEqual(master["fields"]["volume"], "12")
        self.assertEqual(master["fields"]["pages"], "1-10")
        self.assertEqual(master["citekey"], "smithExamplePaper2024")
        self.assertIn("dup", [t["tag"] for t in master["tags"]])
        self.assertEqual(sorted(c["path"] for c in master["collections"]), ["Empty", "Project A", "Project B"])
        self.assertEqual(len(master["attachments"]), 1)
        self.assertEqual(S.tool("find_duplicates")["total_sets"], 0)

    def test_merge_validation(self):
        e = S.tool("merge_items", {"master": K["smith"], "others": [K["jones"]]}, expect_error=True)
        self.assertIn("same type", e.text)
        e = S.tool("merge_items", {"master": K["smith"], "others": [K["smith"]]}, expect_error=True)
        self.assertIn("must not be listed", e.text)
        e = S.tool("merge_items", {"master": K["smith"], "others": [K["lee"]], "fields": {"title": {"from": K["jones"]}}}, expect_error=True)
        self.assertIn("not one of the merged items", e.text)


class Trash(Fresh):
    def test_trash_two_phase(self):
        preview = S.tool("trash_items", {"keys": [K["jones"], K["leePDF"]]})
        self.assertFalse(is_trashed(K["jones"]))
        entries = {x["key"]: x for x in preview["preview"]["to_trash"]}
        self.assertEqual(entries[K["jones"]]["attachments"], 2)
        self.assertEqual(entries[K["leePDF"]]["parent"], K["lee"])
        done = S.tool("trash_items", {"keys": [K["jones"], K["leePDF"]], "confirmation_id": preview["confirmation_id"]})
        self.assertEqual(sorted(done["result"]["trashed"]), sorted([K["jones"], K["leePDF"]]))
        self.assertTrue(is_trashed(K["jones"]))
        self.assertEqual(S.tool("search_items", {"query": "Big Book"})["total"], 0)
        # get_item still sees trashed items, marked as such
        self.assertTrue(S.tool("get_item", {"key": K["jones"]})["trashed"])


class DeleteCollection(Fresh):
    def test_keep_items(self):
        preview, result = S.confirm("delete_collection", {"collection": "Project A/Results"})
        self.assertEqual([c["path"] for c in preview["subcollections"]], ["Project A/Results/Deep"])
        self.assertEqual(sorted(preview["items_becoming_unfiled"]), sorted([K["jones"], K["lee"]]))
        self.assertEqual(result["trashed_items"], [])
        self.assertFalse(is_trashed(K["jones"]))
        names = [c["name"] for c in S.tool("list_collections", {"parent": "Project A"})["collections"]]
        self.assertEqual(names, [])
        self.assertIn(K["lee"], S.tool("get_library_tree")["unfiled"])

    def test_with_items(self):
        preview, result = S.confirm("delete_collection", {"collection": K["B"], "with_items": True})
        self.assertEqual(sorted(i["key"] for i in preview["items_to_trash"]), sorted([K["smith"], K["standalone"], K["snap"]]))
        self.assertTrue(is_trashed(K["smith"]))  # also in Project A, trashed anyway like Zotero does
        self.assertTrue(is_trashed(K["standalone"]))


class BBTSettings(Fresh):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        evaluate("Zotero.Prefs.set('zoteromcp.tools.set_bbt_settings', true); return true;")

    @classmethod
    def tearDownClass(cls):
        evaluate("""Zotero.Prefs.set('zoteromcp.tools.set_bbt_settings', false);
            Zotero.Prefs.set('translators.better-bibtex.citekeyFormat', 'auth.lower + shorttitle(3, 3) + year');
            Zotero.Prefs.set('translators.better-bibtex.resetKeyOnChange', false); return true;""")

    def test_allow_list_and_preview(self):
        e = S.tool("set_bbt_settings", {"settings": {"testing": True}}, expect_error=True)
        self.assertIn("not on the allow-list", e.text)
        e = S.tool("set_bbt_settings", {"settings": {"citekeyFold": "yes"}}, expect_error=True)
        self.assertIn("expects a boolean", e.text)
        before = S.tool("get_bbt_settings")["settings"]["citekeyFormat"]
        preview, result = S.confirm("set_bbt_settings", {"settings": {"citekeyFormat": "auth.lower + year", "autoExportDelay": 7}})
        old = {c["setting"]: c for c in preview["changes"]}
        self.assertEqual(old["citekeyFormat"]["old"], before)
        self.assertEqual(result["applied"][0]["old"], before)
        self.assertEqual(old["autoExportDelay"]["new"], 7)
        self.assertEqual(S.tool("get_bbt_settings")["settings"]["citekeyFormat"], "auth.lower + year")

    def test_reset_key_warning_and_expected_profile(self):
        preview = S.tool("set_bbt_settings", {"settings": {"resetKeyOnChange": True}})
        self.assertTrue(any("break" in w for w in preview["preview"]["warnings"]))
        S.tool("set_bbt_settings", {"settings": {"resetKeyOnChange": True}, "confirmation_id": preview["confirmation_id"]})
        diffs = S.tool("get_bbt_settings")["expected_profile_differences"]
        self.assertEqual(diffs, [{"setting": "resetKeyOnChange", "current": True, "expected": False}])
        # The settings pane / startup notice fixes it only after the user confirms
        evaluate("Zotero.ZoteroMCP.BBT.applyExpected(); return true;")
        self.assertEqual(S.tool("get_bbt_settings")["expected_profile_differences"], [])

    def test_off_by_default(self):
        evaluate("Zotero.Prefs.clear('zoteromcp.tools.set_bbt_settings'); return true;")
        try:
            e = S.tool("set_bbt_settings", {"settings": {"citekeyFold": True}}, expect_error=True)
            self.assertIn("disabled by the user", e.text)
        finally:
            evaluate("Zotero.Prefs.set('zoteromcp.tools.set_bbt_settings', true); return true;")


if __name__ == "__main__":
    unittest.main()
