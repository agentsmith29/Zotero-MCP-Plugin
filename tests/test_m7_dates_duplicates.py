"""Date normalization (DD/MM/YYYY) and stricter duplicate prevention on insert."""

import os
import re
import threading
import unittest

from fixtures import build_library
from mcp_client import LegacySession, evaluate

K = {}
S = None
OFFLINE = os.environ.get("NO_NETWORK") == "1"


def setUpModule():
    global S
    K.update(build_library())
    S = LegacySession()


def stored_date(key, field="date"):
    """(display text, Zotero's internal YYYY-MM-DD part)"""
    return tuple(evaluate(f"""
        const i = Zotero.Items.getByLibraryAndKey(1, "{key}");
        return [i.getField("{field}"), i.getField("{field}", true, true).slice(0, 10)];
    """))


def create(title, date, **fields):
    r = S.tool("create_item", {"item_type": "journalArticle", "fields": dict(title=title, date=date, **fields),
                               "creators": [{"firstName": "Dora", "lastName": "Datum"}], "duplicate_force": True})
    return r["item"]["key"], r.get("dates", [])


class Dates(unittest.TestCase):
    def check(self, date, text, sql, note=None):
        key, notes = create(f"Date case {date}", date)
        self.assertEqual(stored_date(key), (text, sql), date)
        if note:
            self.assertIn(note, notes[0].get("note", ""), notes)
        return key, notes

    def test_formats(self):
        self.check("2020-03-05", "05/03/2020", "2020-03-05")
        self.check("2020-03-05T10:15:00Z", "05/03/2020", "2020-03-05")
        self.check("20200305", "05/03/2020", "2020-03-05")
        self.check("March 5, 2020", "05/03/2020", "2020-03-05")
        self.check("5 Mar 2020", "05/03/2020", "2020-03-05")
        self.check("25.03.2020", "25/03/2020", "2020-03-25")
        self.check("2020-03", "03/2020", "2020-03-00")
        self.check("Aug./1999", "08/1999", "1999-08-00")
        self.check("1999", "1999", "1999-00-00")

    def test_us_dates_are_corrected(self):
        _, notes = self.check("03/25/2020", "25/03/2020", "2020-03-25", "MM/DD/YYYY")
        self.assertEqual(notes[0]["interpreted_as"], "25 March 2020")

    def test_ambiguous_reads_as_day_first(self):
        _, notes = self.check("05/03/2020", "05/03/2020", "2020-03-05", "ambiguous")
        self.assertEqual(notes[0]["interpreted_as"], "5 March 2020")

    def test_unparseable_left_alone(self):
        key, notes = create("Seasonal", "Spring 2020")
        self.assertEqual(stored_date(key)[0], "Spring 2020")
        self.assertIn("unchanged", notes[0]["note"])
        key, _ = create("Impossible", "31/02/2020")
        self.assertEqual(stored_date(key)[0], "31/02/2020")

    def test_update_and_access_date(self):
        key, _ = create("Updated date", "2001")
        r = S.tool("update_item", {"key": key, "fields": {"date": "12/31/2001", "accessDate": "05/03/2020"}})
        self.assertEqual(r["dates"][0]["stored"], "31/12/2001")
        self.assertEqual(stored_date(key), ("31/12/2001", "2001-12-31"))
        self.assertTrue(stored_date(key, "accessDate")[0].startswith("2020-03-05"))

    def test_bibliography_and_citekey_see_the_right_date(self):
        key, _ = create("Exported Date Check", "05/03/2020")
        citekey = S.tool("get_item", {"key": key})["citekey"]
        self.assertIn("2020", citekey)
        bib = S.tool("export_bibliography", {})["bibliography"]
        entry = bib[bib.index("{" + citekey + ","):].split("\n}")[0]
        self.assertIn("date = {2020-03-05}", entry)

    def test_switch_off(self):
        evaluate("Zotero.Prefs.set('zoteromcp.dates.normalize', false); return true;")
        try:
            key, notes = create("Not normalized", "2020-03-05")
            self.assertEqual(stored_date(key)[0], "2020-03-05")
            self.assertEqual(notes, [])
        finally:
            evaluate("Zotero.Prefs.set('zoteromcp.dates.normalize', true); return true;")

    def test_merge_keeps_day_month_order(self):
        a, _ = create("Merge Date Case", "05/03/2020", DOI="10.5555/merge.date")
        b, _ = create("Merge Date Case", "2020", DOI="10.5555/merge.date")
        S.confirm("merge_items", {"master": a, "others": [b], "fields": {"volume": "3"}})
        self.assertEqual(stored_date(a), ("05/03/2020", "2020-03-05"))
        c, _ = create("Merge Date Case 2", "2021", DOI="10.5555/merge.date2")
        d, _ = create("Merge Date Case 2", "2021", DOI="10.5555/merge.date2")
        preview, _ = S.confirm("merge_items", {"master": c, "others": [d], "fields": {"date": "07/04/2021"}})
        self.assertEqual(preview["fields"]["date"]["result"], "07/04/2021")
        self.assertEqual(stored_date(c), ("07/04/2021", "2021-04-07"))


class Duplicates(unittest.TestCase):
    def test_title_creator_year_match(self):
        r = S.tool("create_item", {"item_type": "journalArticle",
                                   "fields": {"title": "EXAMPLE paper!", "date": "2024"},
                                   "creators": [{"firstName": "A.", "lastName": "Smith"}]})
        self.assertEqual((r["status"], r["item"]["key"], r["matched_by"]), ("existing", K["smith"], ["title+creator+year"]))

    def test_no_match_when_year_author_or_doi_differ(self):
        base = {"item_type": "journalArticle", "creators": [{"lastName": "Smith"}]}
        r = S.tool("create_item", dict(base, fields={"title": "Example Paper", "date": "2023"}))
        self.assertEqual(r["status"], "created")
        r = S.tool("create_item", dict(base, fields={"title": "Example Paper", "date": "2024"}, creators=[{"lastName": "Other"}]))
        self.assertEqual(r["status"], "created")
        r = S.tool("create_item", dict(base, fields={"title": "Example Paper", "date": "2024", "DOI": "10.1000/erratum"}))
        self.assertEqual(r["status"], "created")

    def test_doi_in_url_field(self):
        r = S.tool("create_item", {"item_type": "journalArticle",
                                   "fields": {"title": "Elsewhere", "url": "https://doi.org/10.1000/EXAMPLE.1"}})
        self.assertEqual((r["status"], r["item"]["key"]), ("existing", K["smith"]))

    def test_parallel_inserts_create_one_item(self):
        results = []

        def insert():
            s = LegacySession()
            results.append(s.tool("create_item", {"item_type": "journalArticle",
                                                  "fields": {"title": "Race Condition Paper", "DOI": "10.5555/race.1"}}))
        threads = [threading.Thread(target=insert) for _ in range(4)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(r["status"] for r in results), ["created", "existing", "existing", "existing"])
        self.assertEqual(S.tool("search_items", {"query": "Race Condition Paper"})["total"], 1)


@unittest.skipIf(OFFLINE, "NO_NETWORK=1")
class MagicWand(unittest.TestCase):
    def test_lookup_matches_existing_by_isbn_of_the_found_record(self):
        # The real case: a DOI lookup returning a book that is already in the library with its ISBN only
        existing = S.tool("create_item", {"item_type": "book", "fields": {"title": "Placeholder title", "ISBN": "9780521773393"}})["item"]["key"]
        r = S.tool("add_by_identifier", {"identifiers": ["10.1017/CBO9780511815850"], "collections": [K["E"]], "save_attachments": False})
        res = r["results"][0]
        self.assertEqual(res["status"], "existing", r)
        self.assertEqual(res["item"]["key"], existing)
        self.assertIn("isbn:9780521773393", res["matched_by"])
        gone = evaluate(f'return !Zotero.Items.getByLibraryAndKey(1, "{res["discarded_copy"]}");')
        self.assertTrue(gone)
        self.assertIn("Empty", [c["path"] for c in S.tool("get_item", {"key": existing})["collections"]])

    def test_lookup_matches_by_title_and_takes_over_the_pdf(self):
        existing = S.tool("create_item", {"item_type": "journalArticle", "fields": {
            "title": "A Quick Introduction to Version Control with Git and GitHub", "date": "2016"},
            "creators": [{"firstName": "John D.", "lastName": "Blischak"}]})["item"]["key"]
        r = S.tool("add_by_identifier", {"identifiers": ["10.1371/journal.pcbi.1004668"]})
        res = r["results"][0]
        self.assertEqual((res["status"], res["item"]["key"]), ("existing", existing), r)
        self.assertEqual(res["matched_by"], ["title+creator+year"])
        attachments = S.tool("get_item", {"key": existing})["attachments"]
        self.assertIn("application/pdf", [a["content_type"] for a in attachments])
        self.assertEqual(S.tool("search_items", {"query": "Quick Introduction to Version Control"})["total"], 1)

    def test_new_items_get_normalized_dates(self):
        r = S.tool("add_by_identifier", {"identifiers": ["10.7717/peerj.4375"], "save_attachments": False})
        item = r["results"][0]["items"][0]
        text, sql = stored_date(item["key"])
        self.assertRegex(text, r"^(\d{2}/){0,2}\d{4}$")
        self.assertTrue(sql.startswith("2018"))


if __name__ == "__main__":
    unittest.main()
