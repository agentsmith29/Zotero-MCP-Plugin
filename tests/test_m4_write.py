"""Milestone 4: writes, duplicate check, citekey stability, collections, library tree, two-phase, audit log."""

import copy
import json
import os
import time
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


def collections_of(key):
    return sorted(c["path"] for c in S.tool("get_item", {"key": key})["collections"])


def audit_lines(tool=None):
    path = evaluate("return Zotero.ZoteroMCP.Audit.path();")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        lines = [json.loads(line) for line in f if line.strip()]
    return [l for l in lines if tool is None or l["tool"] == tool]


class CreateItem(Fresh):
    def test_create_with_citekey_and_collections(self):
        r = S.tool("create_item", {
            "item_type": "journalArticle",
            "fields": {"title": "Brand New Study", "date": "2025", "DOI": "10.5555/new.1"},
            "creators": [{"creatorType": "author", "firstName": "Nina", "lastName": "Novel"}],
            "tags": ["fresh"],
            "collections": ["Project A/Results"],
        })
        self.assertEqual(r["status"], "created")
        self.assertEqual(r["item"]["citekey"], "novelBrandNewStudy2025")
        self.assertEqual(collections_of(r["item"]["key"]), ["Project A/Results"])

    def test_duplicate_doi_files_existing(self):
        before = len(audit_lines("create_item"))
        r = S.tool("create_item", {
            "item_type": "journalArticle",
            "fields": {"title": "Same paper again", "DOI": "https://doi.org/10.1000/EXAMPLE.1"},
            "collections": [K["E"]],
        })
        self.assertEqual(r["status"], "existing")
        self.assertEqual(r["item"]["key"], K["smith"])
        self.assertEqual(r["matched_by"], ["doi:10.1000/example.1"])
        self.assertIn("Empty", collections_of(K["smith"]))
        self.assertEqual(len(audit_lines("create_item")), before + 1)

    def test_duplicate_isbn_and_arxiv(self):
        r = S.tool("create_item", {"item_type": "book", "fields": {"title": "x", "ISBN": "3-16-148410-X"}})
        self.assertEqual((r["status"], r["item"]["key"]), ("existing", K["jones"]))
        r = S.tool("create_item", {"item_type": "preprint", "fields": {"title": "x", "url": "https://arxiv.org/abs/2101.00001v2"}})
        self.assertEqual((r["status"], r["item"]["key"]), ("existing", K["nofiles"]))

    def test_duplicate_force(self):
        r = S.tool("create_item", {"item_type": "journalArticle", "fields": {"title": "Forced copy", "DOI": "10.1000/example.1"},
                                   "duplicate_force": True})
        self.assertEqual(r["status"], "created")
        self.assertEqual(r["duplicates_ignored"][0]["key"], K["smith"])

    def test_invalid_input(self):
        e = S.tool("create_item", {"item_type": "spaceship"}, expect_error=True)
        self.assertIn("Unknown or unsupported item type", e.text)
        e = S.tool("create_item", {"item_type": "book", "fields": {"publicationTitle": "x"}}, expect_error=True)
        self.assertIn("not a field of book", e.text)
        e = S.tool("create_item", {"item_type": "book", "fields": {"citationKey": "x"}}, expect_error=True)
        self.assertIn("set_citekey", e.text)


class UpdateItem(Fresh):
    def test_edit_keeps_citekey(self):
        r = S.tool("update_item", {"key": K["smith"], "fields": {"title": "Example Paper, Revised", "volume": "7"}})
        self.assertEqual(r["status"], "updated")
        self.assertEqual(r["changes"]["title"], {"before": "Example Paper", "after": "Example Paper, Revised"})
        time.sleep(3)  # give Better BibTeX the chance to (not) change the key
        self.assertEqual(S.tool("get_item", {"key": K["smith"]})["citekey"], "smithExamplePaper2024")

    def test_regenerate_citekey(self):
        S.tool("update_item", {"key": K["lee"], "fields": {"title": "Shallow Result"}})
        r = S.tool("update_item", {"key": K["lee"], "regenerate_citekey": True})
        self.assertEqual(r["citekey"], {"old": "leeDeepResult2019", "new": "leeShallowResult2019"})
        self.assertIn("\\cite", r["citekey_warning"])

    def test_creators_tags_and_unchanged(self):
        r = S.tool("update_item", {"key": K["jones"], "creators": [{"lastName": "Jones", "firstName": "Bob"}, {"creatorType": "editor", "name": "Big Press"}],
                                   "tags": {"add": ["a", "b"], "remove": ["zzz"]}})
        self.assertEqual(len(r["changes"]["creators"]["after"]), 2)
        r = S.tool("update_item", {"key": K["jones"], "fields": {"title": "Big Book"}})
        self.assertEqual(r["status"], "unchanged")


class SetCitekey(Fresh):
    def test_set_and_clash(self):
        r = S.tool("set_citekey", {"key": K["report"], "citekey": "report2021"})
        self.assertEqual(r["citekey"], {"old": "unfiledUnfiledReport2021", "new": "report2021"})
        self.assertIn("will break", r["warning"])
        e = S.tool("set_citekey", {"key": K["jones"], "citekey": "report2021"}, expect_error=True)
        self.assertIn("already used", e.text)
        S.tool("set_citekey", {"key": K["jones"], "citekey": "report2021", "allow_duplicate": True})
        self.assertEqual(S.tool("get_citekeys", {"keys": [K["report"]]})["citekeys"][K["report"]], "report2021")
        last = audit_lines("set_citekey")[-1]
        self.assertEqual(last["after"], "report2021")


class Membership(Fresh):
    def test_add_remove_move(self):
        r = S.tool("add_to_collections", {"items": [K["report"], K["smith"]], "collections": [K["E"], "Project B"]})
        self.assertEqual(r["results"][1]["already_in"], ["Project B"])
        self.assertEqual(collections_of(K["report"]), ["Empty", "Project B"])
        r = S.tool("remove_from_collections", {"items": [K["report"]], "collections": [K["E"], K["B"]]})
        self.assertTrue(r["results"][0]["now_unfiled"])
        self.assertEqual(S.tool("get_item", {"key": K["report"]})["key"], K["report"])  # still in library
        r = S.tool("move_items", {"items": [K["smith"]], "from": "Project B", "to": [K["E"]]})
        self.assertEqual(collections_of(K["smith"]), ["Empty", "Project A"])
        e = S.tool("move_items", {"items": [K["jones"]], "from": "Project B", "to": [K["E"]]}, expect_error=True)
        self.assertIn("Not in source collection", e.text)

    def test_child_items_refused(self):
        e = S.tool("add_to_collections", {"items": [K["smithPDF"]], "collections": [K["E"]]}, expect_error=True)
        self.assertIn("Child items cannot be placed", e.text)


class CollectionTools(Fresh):
    def test_create_rename_move(self):
        c = S.tool("create_collection", {"name": "Chapter 1", "parent": "Project A"})
        self.assertEqual(c["path"], "Project A/Chapter 1")
        r = S.tool("rename_collection", {"collection": c["key"], "name": "Chapter One"})
        self.assertEqual(r["path"], "Project A/Chapter One")
        r = S.tool("move_collection", {"collection": c["key"], "parent": "Project B"})
        self.assertEqual(r["path"], "Project B/Chapter One")
        r = S.tool("move_collection", {"collection": c["key"]})
        self.assertEqual(r["path"], "Chapter One")
        e = S.tool("move_collection", {"collection": K["A"], "parent": K["D"]}, expect_error=True)
        self.assertIn("into itself or one of its subcollections", e.text)

    def test_duplicate_name_warning_and_ambiguity(self):
        r = S.tool("create_collection", {"name": "Results", "parent": "Project B"})
        self.assertNotIn("warning", r)  # same name under a different parent is fine
        e = S.tool("list_collections", {"parent": "Results"}, expect_error=True)
        self.assertIn("not found", e.text)
        r2 = S.tool("create_collection", {"name": "Project A"})
        self.assertIn("already exists", r2["warning"])
        e = S.tool("list_collections", {"parent": "Project A"}, expect_error=True)
        self.assertIn("ambiguous", e.text)
        self.assertEqual(len(e.data["details"]["candidates"]), 2)


class LibraryTree(Fresh):
    def tree(self, **kw):
        return S.tool("get_library_tree", kw)

    def node(self, tree, key):
        stack = list(tree["collections"])
        while stack:
            n = stack.pop()
            if n.get("key") == key:
                return n
            stack.extend(n["collections"])
        return None

    def test_01_noop(self):
        t = self.tree()
        preview = S.tool("apply_library_tree", {"tree": t})
        self.assertEqual(preview["preview"]["total_changes"], 0)
        self.assertNotIn("warnings", preview["preview"])

    def test_02_restructure(self):
        t = self.tree()
        a = self.node(t, K["A"])
        b = self.node(t, K["B"])
        # rename, create nested, move Results under B, move items, link copy, forced copy, delete Empty
        a["name"] = "Project Alpha"
        results = self.node(t, K["R"])
        a["collections"].remove(results)
        b["collections"].append(results)
        a["collections"].append({"name": "New Topic", "items": [K["report"]],
                                 "collections": [{"name": "Sub Topic", "items": [{"copy_of": K["jones"]}], "collections": []}]})
        a["items"].remove(K["nofiles"])
        b["items"].append(K["nofiles"])
        b["items"].append({"copy_of": K["smith"], "duplicate_force": True})
        self.node(t, K["E"])["delete"] = True
        preview, result = S.confirm("apply_library_tree", {"tree": t})
        self.assertEqual(len(preview["create_collections"]), 2)
        self.assertEqual(preview["rename_collections"], [{"key": K["A"], "from": "Project A", "to": "Project Alpha"}])
        self.assertEqual(len(preview["move_collections"]), 1)
        self.assertEqual(len(preview["copies"]), 1)
        self.assertEqual(len(preview["linked_instead_of_copy"]), 1)
        self.assertEqual(preview["delete_collections"], [{"key": K["E"], "name": "Empty"}])
        self.assertEqual(result["applied"], preview["total_changes"])

        after = self.tree()
        names = {n["name"] for n in after["collections"]}
        self.assertEqual(names, {"Project Alpha", "Project B"})
        self.assertEqual(collections_of(K["nofiles"]), ["Project B"])
        self.assertIn("Project Alpha/New Topic/Sub Topic", collections_of(K["jones"]))
        self.assertIn("Project B/Results", collections_of(K["jones"]))
        copy_key = result["copies"][0]["key"]
        copy_item = S.tool("get_item", {"key": copy_key})
        self.assertEqual(copy_item["fields"]["title"], "Example Paper")
        self.assertEqual(copy_item["attachments"], [])
        time.sleep(3)
        self.assertNotEqual(S.tool("get_item", {"key": copy_key})["citekey"], "smithExamplePaper2024")
        self.assertEqual(after["unfiled"], [])
        self.assertEqual(result["new_version"], after["version"])

    def test_03_stale_tree_refused(self):
        t = self.tree()
        S.tool("create_collection", {"name": "Sneaky"})
        e = S.tool("apply_library_tree", {"tree": t}, expect_error=True)
        self.assertIn("out of date", e.text)

    def test_04_missing_node_is_error(self):
        t = self.tree()
        t["collections"] = [n for n in t["collections"] if n["key"] != K["B"]]
        e = S.tool("apply_library_tree", {"tree": t}, expect_error=True)
        self.assertIn("missing from the tree", e.text)

    def test_05_file_reparent_and_swap(self):
        t = self.tree()
        files = t["items"][K["jones"]]["files"]
        epub = next(f for f in files if f["key"] == K["jonesEPUB"])
        files.remove(epub)
        t["items"][K["smith"]]["files"].append(epub)
        # swap parent/child collections to exercise cycle-free moves
        alpha = self.node(t, K["A"])
        newtopic = next(c for c in alpha["collections"] if c["name"] == "New Topic")
        sub = newtopic["collections"][0]
        newtopic["collections"] = []
        alpha["collections"].remove(newtopic)
        sub["collections"].append(newtopic)
        alpha["collections"].append(sub)
        preview, _ = S.confirm("apply_library_tree", {"tree": t})
        self.assertEqual(preview["move_files"][0]["file"], K["jonesEPUB"])
        detail = S.tool("get_item", {"key": K["smith"]})
        self.assertIn(K["jonesEPUB"], [a["key"] for a in detail["attachments"]])
        self.assertIn("Project Alpha/Sub Topic/New Topic", collections_of(K["report"]))

    def test_06_errors_are_collected(self):
        t = self.tree()
        t["collections"][0]["items"].append("NOTAKEY1")
        t["collections"][0]["items"].append(K["smithPDF"])
        t["items"][K["smith"]]["files"] = []
        e = S.tool("apply_library_tree", {"tree": t}, expect_error=True)
        errors = e.data["details"]["errors"]
        self.assertTrue(any("NOTAKEY1" in x for x in errors))
        self.assertTrue(any("child item" in x for x in errors))
        self.assertTrue(any("cannot be deleted through the tree" in x for x in errors))

    def test_07_subtree_scope_and_duplicate_warning(self):
        twin = S.tool("create_item", {"item_type": "journalArticle", "fields": {"title": "Twin", "DOI": "10.1000/example.1"},
                                      "duplicate_force": True, "collections": [K["B"]]})["item"]["key"]
        # Duplicates already sitting together are not this change's business
        t = self.tree(collection=K["B"])
        self.assertEqual(t["collections"][0]["key"], K["B"])
        self.assertNotIn("warnings", S.tool("apply_library_tree", {"tree": t})["preview"])
        # Adding the twin next to the original warns once, naming the shared identifier
        t = self.tree(collection="Project Alpha")
        t["collections"][0]["items"].append(twin)
        t["collections"][0]["name"] = "Project Alpha 2"
        warnings = S.tool("apply_library_tree", {"tree": t})["preview"]["warnings"]
        self.assertEqual(len(warnings), 1)
        self.assertIn("doi:10.1000/example.1", warnings[0])
        self.assertIn("merge_items", warnings[0])
        S.tool("apply_library_tree", {"tree": t, "confirmation_id": "wrong"}, expect_error=True)

class TwoPhase(Fresh):
    def test_confirmation_rules(self):
        t = S.tool("get_library_tree")
        first = S.tool("apply_library_tree", {"tree": t})
        cid = first["confirmation_id"]
        e = S.tool("trash_items", {"keys": [K["report"]], "confirmation_id": cid}, expect_error=True)
        self.assertIn("different call", e.text)
        t2 = copy.deepcopy(t)
        t2["collections"][0]["name"] = "Other"
        e = S.tool("apply_library_tree", {"tree": t2, "confirmation_id": cid}, expect_error=True)
        self.assertIn("different call", e.text)
        done = S.tool("apply_library_tree", {"tree": t, "confirmation_id": cid})
        self.assertEqual(done["phase"], "executed")
        e = S.tool("apply_library_tree", {"tree": t, "confirmation_id": cid}, expect_error=True)
        self.assertIn("already used", e.text)

    def test_unknown_id(self):
        e = S.tool("trash_items", {"keys": [K["report"]], "confirmation_id": "0" * 24}, expect_error=True)
        self.assertIn("expired", e.text)
        self.assertEqual(S.tool("get_item", {"key": K["report"]})["key"], K["report"])


class Audit(Fresh):
    def test_log_has_before_after(self):
        S.tool("update_item", {"key": K["smith"], "fields": {"pages": "1-2"}})
        line = audit_lines("update_item")[-1]
        self.assertEqual(line["keys"], [K["smith"]])
        self.assertEqual(line["changes"]["pages"], {"before": None, "after": "1-2"})
        self.assertIn("time", line)


if __name__ == "__main__":
    unittest.main()
