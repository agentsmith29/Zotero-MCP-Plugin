"""Milestone 5: magic wand (add_by_identifier) and Find Available PDF. Needs internet access."""

import os
import unittest

from fixtures import build_library
from mcp_client import LegacySession

K = {}
S = None
OFFLINE = os.environ.get("NO_NETWORK") == "1"


def setUpModule():
    global S
    K.update(build_library())
    S = LegacySession()


class Offline(unittest.TestCase):
    def test_existing_identifier_is_filed_not_duplicated(self):
        r = S.tool("add_by_identifier", {"identifiers": ["https://doi.org/10.1000/EXAMPLE.1"], "collections": [K["E"]]})
        self.assertEqual(r["summary"], {"created": 0, "existing": 1, "failed": 0})
        self.assertEqual(r["results"][0]["item"]["key"], K["smith"])
        self.assertEqual(r["results"][0]["added_to_collections"], ["Empty"])

    def test_isbn_variants_match(self):
        r = S.tool("add_by_identifier", {"identifiers": ["3-16-148410-X"]})
        self.assertEqual(r["results"][0]["status"], "existing")
        self.assertEqual(r["results"][0]["item"]["key"], K["jones"])

    def test_unrecognised(self):
        r = S.tool("add_by_identifier", {"identifiers": ["hello world"]})
        self.assertEqual(r["results"][0]["status"], "failed")

    def test_find_pdf_skips(self):
        bare = S.tool("create_item", {"item_type": "book", "fields": {"title": "Nothing to search with"}})["item"]["key"]
        r = S.tool("find_pdf", {"keys": [K["smith"], bare, K["standalone"]]})
        reasons = {x["key"]: x for x in r["results"]}
        self.assertIn("already has", reasons[K["smith"]]["reason"])
        self.assertIn("no DOI", reasons[bare]["reason"])
        self.assertIn("not a regular item", reasons[K["standalone"]]["reason"])
        e = S.tool("find_pdf", {"keys": [K["smith"]], "methods": ["nope"]}, expect_error=True)
        self.assertIn("allowed: doi, url, oa, custom", e.text)


@unittest.skipIf(OFFLINE, "NO_NETWORK=1")
class Online(unittest.TestCase):
    def test_lookup_all_identifier_types(self):
        r = S.tool("add_by_identifier", {
            "identifiers": ["10.1371/journal.pcbi.1004668", "arXiv:1706.03762", "9780262033848", "PMID: 17284678"],
            "collections": ["Project B"],
        })
        self.assertEqual(r["summary"]["created"], 4, r)
        titles = [x["items"][0]["title"] for x in r["results"]]
        self.assertIn("Attention Is All You Need", titles)
        for x in r["results"]:
            self.assertEqual(x["items"][0]["collections"][0]["path"], "Project B")
            self.assertTrue(x["items"][0]["citekey"])
        # The same DOI again is recognised, unless forced
        again = S.tool("add_by_identifier", {"identifiers": ["10.1371/journal.pcbi.1004668"]})
        self.assertEqual(again["results"][0]["status"], "existing")
        forced = S.tool("add_by_identifier", {"identifiers": ["10.1371/journal.pcbi.1004668"], "duplicate_force": True,
                                              "save_attachments": False})
        self.assertEqual(forced["results"][0]["status"], "created")

    def test_find_available_pdf(self):
        a = S.tool("create_item", {"item_type": "journalArticle", "fields": {"title": "The state of OA", "DOI": "10.7717/peerj.4375"}})
        b = S.tool("create_item", {"item_type": "journalArticle", "fields": {"title": "Fake", "DOI": "10.5555/12345678"}})
        r = S.tool("find_pdf", {"keys": [a["item"]["key"], b["item"]["key"]]})
        status = {x["key"]: x["status"] for x in r["results"]}
        self.assertEqual(status[a["item"]["key"]], "found")
        self.assertEqual(status[b["item"]["key"]], "not_found")
        detail = S.tool("get_item", {"key": a["item"]["key"]})
        self.assertEqual(detail["attachments"][0]["content_type"], "application/pdf")


if __name__ == "__main__":
    unittest.main()
