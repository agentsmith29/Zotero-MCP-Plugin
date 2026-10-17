"""Milestone 3: file export engine, mirror rules, global sync, right-click flow."""

import hashlib
import json
import os
import shutil
import time
import unittest
from datetime import date

from fixtures import build_library
from mcp_client import LegacySession, evaluate

K = {}
S = None
OUT = os.path.join(os.environ.get("TEST_OUT", "/tmp"), "m3")
INDEX = ".zotero-files-index.json"


def setUpModule():
    global S
    S = LegacySession()
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)


class FreshLibrary(unittest.TestCase):
    """Each test class starts from a newly built fixture library."""

    @classmethod
    def setUpClass(cls):
        K.clear()
        K.update(build_library())


def js(code):
    return evaluate(code)


def export(target, **kw):
    args = dict(target_folder=target, **kw)
    return S.confirm("export_files", args)


def files(root):
    out = []
    for base, _dirs, names in os.walk(root):
        for name in names:
            if name == INDEX:
                continue
            out.append(os.path.relpath(os.path.join(base, name), root))
    return sorted(out)


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def source_path(attachment_key):
    return js(f"""
        const a = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, "{attachment_key}");
        return a.getFilePath();
    """)


EXPECTED_LIBRARY = sorted([
    "Project A/Results/Deep/Lee - 2019 - Deep Result.pdf",
    "Project A/Results/Jones - 2020 - Big Book/Jones - 2020 - Big Book.epub",
    "Project A/Results/Jones - 2020 - Big Book/Jones - 2020 - Big Book.pdf",
    "Project A/Smith - 2024 - Example Paper.pdf",
    "Project B/Smith - 2024 - Example Paper.pdf",
    "Project B/Standalone Scan.pdf",
    "Unfiled - 2021 - Unfiled Report.pdf",
])


class LibraryExport(FreshLibrary):
    """Runs in order on one export folder (unittest sorts by name)."""

    root = os.path.join(OUT, "lib", "My Library")

    def test_01_first_export(self):
        preview, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(preview["counts"], {"copy": 7})
        self.assertTrue(preview["first_export"])
        self.assertEqual(report["copied"], 7)
        self.assertEqual(files(self.root), EXPECTED_LIBRARY)
        self.assertEqual([s["item"] for s in report["skipped_snapshots"]], [K["snap"]])
        # mtime preserved, content identical
        src = source_path(K["smithPDF"])
        copy = os.path.join(self.root, "Project A/Smith - 2024 - Example Paper.pdf")
        self.assertAlmostEqual(os.stat(src).st_mtime, os.stat(copy).st_mtime, delta=1)
        self.assertEqual(sha(src), sha(copy))
        with open(os.path.join(self.root, INDEX), encoding="utf-8") as f:
            index = json.load(f)
        self.assertTrue(all(not e["path"].startswith("/") for e in index["entries"]))
        self.assertTrue(all(len(e["sha256"]) == 64 for e in index["entries"]))

    def test_02_rerun_unchanged(self):
        preview, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(preview["counts"], {"unchanged": 7})
        self.assertEqual(report["unchanged"], 7)
        self.assertEqual(report["copied"] + report["updated"] + report["deleted"], 0)

    def test_03_foreign_files_untouched(self):
        foreign = os.path.join(self.root, "Project B", "my notes.txt")
        with open(foreign, "w") as f:
            f.write("mine")
        # Collection renamed: owned files move, foreign file and its folder stay
        js(f"""const c = Zotero.Collections.getByLibraryAndKey(1, "{K['B']}"); c.name = "Project Beta"; await c.saveTx(); return true;""")
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["moved"], 2)
        self.assertTrue(os.path.exists(foreign))
        self.assertIn("Project Beta/Smith - 2024 - Example Paper.pdf", files(self.root))
        self.assertNotIn("Project B/Standalone Scan.pdf", files(self.root))
        os.remove(foreign)

    def test_04_empty_folders_removed(self):
        js(f"""const c = Zotero.Collections.getByLibraryAndKey(1, "{K['B']}"); c.name = "Project B"; await c.saveTx(); return true;""")
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["moved"], 2)
        self.assertFalse(os.path.exists(os.path.join(self.root, "Project Beta")))
        self.assertEqual(files(self.root), EXPECTED_LIBRARY)

    def test_05_edited_copy_becomes_annotated(self):
        copy = os.path.join(self.root, "Project A/Smith - 2024 - Example Paper.pdf")
        with open(copy, "ab") as f:
            f.write(b"\n% my highlights\n")
        _, report = export(os.path.join(OUT, "lib"))
        annotated = f"Project A/Smith - 2024 - Example Paper_annotated_{date.today().isoformat()}.pdf"
        self.assertEqual(report["annotated"], [{"from": "Project A/Smith - 2024 - Example Paper.pdf", "to": annotated}])
        with open(os.path.join(self.root, annotated), "rb") as f:
            self.assertIn(b"my highlights", f.read())
        self.assertEqual(sha(copy), sha(source_path(K["smithPDF"])))
        # A second edit on the same day gets _2; the first annotated copy is never touched
        with open(copy, "ab") as f:
            f.write(b"\n% more\n")
        _, report = export(os.path.join(OUT, "lib"))
        self.assertTrue(report["annotated"][0]["to"].endswith(f"_annotated_{date.today().isoformat()}_2.pdf"))
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["annotated"], [])
        self.assertTrue(os.path.exists(os.path.join(self.root, annotated)))

    def test_06_touched_but_unchanged_is_not_annotated(self):
        copy = os.path.join(self.root, "Project B/Standalone Scan.pdf")
        os.utime(copy, (time.time(), time.time()))
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["annotated"], [])
        self.assertEqual(report["copied"] + report["updated"], 0)

    def test_07_removed_from_collection_is_deleted(self):
        js(f"""const i = Zotero.Items.getByLibraryAndKey(1, "{K['smith']}"); i.removeFromCollection(Zotero.Collections.getByLibraryAndKey(1, "{K['B']}").id); await i.saveTx(); return true;""")
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["deleted"], 1)
        self.assertNotIn("Project B/Smith - 2024 - Example Paper.pdf", files(self.root))

    def test_08_second_file_moves_into_item_folder(self):
        js(f"""
            const parent = Zotero.Items.getByLibraryAndKey(1, "{K['lee']}");
            const dir = PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), "fixture-files");
            const p = PathUtils.join(dir, "Lee supplement.pdf");
            await IOUtils.writeUTF8(p, "%PDF-1.4 supplement");
            await Zotero.Attachments.importFromFile({{ file: p, parentItemID: parent.id }});
            return true;
        """)
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["moved"], 1)
        self.assertEqual(report["copied"], 1)
        names = files(self.root)
        self.assertIn("Project A/Results/Deep/Lee - 2019 - Deep Result/Lee - 2019 - Deep Result.pdf", names)
        self.assertIn("Project A/Results/Deep/Lee - 2019 - Deep Result/Lee supplement.pdf", names)

    def test_09_trashed_parent_removes_copies(self):
        js(f"""await Zotero.Items.trashTx([Zotero.Items.getByLibraryAndKey(1, "{K['report']}").id]); return true;""")
        # Assumption check: trashing the parent leaves the attachment itself not deleted
        child_deleted = js(f"""return Zotero.Items.getByLibraryAndKey(1, "{K['reportPDF']}").deleted;""")
        self.assertFalse(child_deleted)
        _, report = export(os.path.join(OUT, "lib"))
        self.assertEqual(report["deleted"], 1)
        self.assertNotIn("Unfiled - 2021 - Unfiled Report.pdf", files(self.root))
        js(f"""const i = Zotero.Items.getByLibraryAndKey(1, "{K['report']}"); i.deleted = false; await i.saveTx(); return true;""")

    def test_10_missing_source_keeps_copy(self):
        src = source_path(K["jonesEPUB"])
        os.rename(src, src + ".away")
        try:
            _, report = export(os.path.join(OUT, "lib"))
            self.assertEqual(report["kept_without_source"], 1)
            self.assertEqual(len(report["missing"]), 1)
            self.assertIn("Project A/Results/Jones - 2020 - Big Book/Jones - 2020 - Big Book.epub", files(self.root))
        finally:
            os.rename(src + ".away", src)

    def test_11_moving_the_export_folder(self):
        moved_parent = os.path.join(OUT, "lib-moved")
        shutil.move(os.path.join(OUT, "lib"), moved_parent)
        _, report = export(moved_parent)
        self.assertEqual(report["copied"], 0)
        self.assertEqual(report["deleted"], 0)
        self.assertGreater(report["unchanged"], 5)


class Layouts(FreshLibrary):
    def test_collection_scope_with_bibliography(self):
        target = os.path.join(OUT, "coll")
        preview, report = export(target, collection=K["A"], include_bibliography=True)
        root = os.path.join(target, "Project A")
        self.assertTrue(report["bibliography"].endswith("Project A/Project A.bib"))
        self.assertIn("Results/Deep/Lee - 2019 - Deep Result.pdf", files(root))
        self.assertNotIn("Project B", " ".join(files(root)))
        with open(report["bibliography"], encoding="utf-8") as f:
            bib = f.read()
        self.assertIn("leeDeepResult2019", bib)  # subcollections included
        # The bibliography is foreign to the mirror: a re-run leaves it alone
        _, report = export(target, collection=K["A"])
        self.assertTrue(os.path.exists(os.path.join(root, "Project A.bib")))

    def test_flat_with_clashes(self):
        js(f"""
            const lib = Zotero.Libraries.userLibraryID;
            const other = new Zotero.Item("journalArticle"); other.libraryID = lib;
            other.setField("title", "Clash"); other.setCollections([Zotero.Collections.getByLibraryAndKey(lib, "{K['B']}").id]);
            await other.saveTx();
            const p = PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), "fixture-files", "clash", "Lee - 2019 - Deep Result.pdf");
            await IOUtils.makeDirectory(PathUtils.parent(p), {{ createAncestors: true, ignoreExisting: true }});
            await IOUtils.writeUTF8(p, "%PDF-1.4 other content");
            await Zotero.Attachments.importFromFile({{ file: p, parentItemID: other.id }});
            return true;
        """)
        target = os.path.join(OUT, "flat")
        _, report = export(target, structure="flat")
        names = files(os.path.join(target, "My Library"))
        self.assertTrue(all("/" not in n for n in names))
        self.assertIn("Lee - 2019 - Deep Result.pdf", names)
        self.assertIn("Lee - 2019 - Deep Result (2).pdf", names)
        before = {n: sha(os.path.join(target, "My Library", n)) for n in names}
        _, report = export(target, structure="flat")
        self.assertEqual(report["copied"] + report["updated"] + report["moved"], 0)
        after = {n: sha(os.path.join(target, "My Library", n)) for n in names}
        self.assertEqual(before, after)

    def test_foreign_file_at_target_name(self):
        target = os.path.join(OUT, "clash")
        os.makedirs(os.path.join(target, "My Library", "Project A"))
        foreign = os.path.join(target, "My Library", "Project A", "Smith - 2024 - Example Paper.pdf")
        with open(foreign, "w") as f:
            f.write("not from zotero")
        export(target)
        with open(foreign) as f:
            self.assertEqual(f.read(), "not from zotero")
        self.assertIn("Project A/Smith - 2024 - Example Paper (2).pdf", files(os.path.join(target, "My Library")))

    def test_custom_folder_name_and_validation(self):
        target = os.path.join(OUT, "named")
        os.makedirs(target)
        _, report = export(target, folder_name="Zotero Files")
        self.assertTrue(report["root"].endswith("named/Zotero Files"))
        e = S.tool("export_files", {"target_folder": "relative/path"}, expect_error=True)
        self.assertIn("absolute", e.text)
        preview = S.tool("export_files", {"target_folder": os.path.join(OUT, "new-folder")})
        self.assertEqual(preview["preview"]["creates_target_folder"], os.path.join(OUT, "new-folder"))
        self.assertFalse(os.path.exists(os.path.join(OUT, "new-folder")))

    def test_preview_invalidated_by_change(self):
        target = os.path.join(OUT, "stale")
        os.makedirs(target)
        preview = S.tool("export_files", {"target_folder": target})
        js(f"""const c = Zotero.Collections.getByLibraryAndKey(1, "{K['E']}");
            const i = Zotero.Items.getByLibraryAndKey(1, "{K['smith']}"); i.addToCollection(c.id); await i.saveTx(); return true;""")
        e = S.tool("export_files", {"target_folder": target, "confirmation_id": preview["confirmation_id"]}, expect_error=True)
        self.assertIn("changed since the preview", e.text)
        self.assertEqual(files(target), [])
        js(f"""const c = Zotero.Collections.getByLibraryAndKey(1, "{K['E']}");
            const i = Zotero.Items.getByLibraryAndKey(1, "{K['smith']}"); i.removeFromCollection(c.id); await i.saveTx(); return true;""")


class GlobalSync(FreshLibrary):
    base = os.path.join(OUT, "global")

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        os.makedirs(cls.base, exist_ok=True)
        js(f"""Zotero.Prefs.set('zoteromcp.sync.path', {json.dumps(cls.base)});
            Zotero.Prefs.set('zoteromcp.sync.folderName', 'My library');
            Zotero.Prefs.set('zoteromcp.tools.sync_library_folder', true); return true;""")

    @classmethod
    def tearDownClass(cls):
        js("""Zotero.Prefs.set('zoteromcp.sync.mode', 'manual'); Zotero.Prefs.set('zoteromcp.sync.path', '');
            Zotero.Prefs.set('zoteromcp.tools.sync_library_folder', false); return true;""")

    def test_1_tool_sync(self):
        preview, report = S.confirm("sync_library_folder", {})
        self.assertEqual(preview["mode"], "manual")
        self.assertTrue(report["root"].endswith("global/My library"))
        self.assertGreater(report["copied"], 5)
        last = json.loads(js("return Zotero.Prefs.get('zoteromcp.sync.lastReport');"))
        self.assertEqual(last["copied"], report["copied"])

    def test_2_automatic_mode(self):
        js("Zotero.Prefs.set('zoteromcp.sync.mode', 'automatic'); return true;")
        js(f"""const c = Zotero.Collections.getByLibraryAndKey(1, "{K['E']}");
            const i = Zotero.Items.getByLibraryAndKey(1, "{K['lee']}"); i.addToCollection(c.id); await i.saveTx(); return true;""")
        folder = os.path.join(self.base, "My library", "Empty")
        synced = lambda: os.path.isdir(folder) and any(n.startswith("Lee - 2019 - Deep Result") for n in os.listdir(folder))
        self.assertFalse(synced())
        time.sleep(20)
        self.assertFalse(synced(), "synced before the 30 s debounce")
        for _ in range(30):
            if synced():
                break
            time.sleep(1)
        self.assertTrue(synced())
        last = json.loads(js("return Zotero.Prefs.get('zoteromcp.sync.lastReport');"))
        self.assertTrue(last["reason"].startswith("automatic"))

    def test_3_not_configured(self):
        js("Zotero.Prefs.set('zoteromcp.sync.path', ''); return true;")
        try:
            e = S.tool("sync_library_folder", {}, expect_error=True)
            self.assertIn("No global sync folder", e.text)
        finally:
            js(f"Zotero.Prefs.set('zoteromcp.sync.path', {json.dumps(self.base)}); return true;")


class RightClick(FreshLibrary):
    def test_menu_on_library_and_collections(self):
        result = js(f"""
            const win = Zotero.getMainWindow();
            const pane = win.ZoteroPane;
            const out = {{}};
            async function check(rowID) {{
                await pane.collectionsView.selectByID(rowID);
                await Zotero.Promise.delay(300);
                await pane.buildCollectionContextMenu();
                const menu = win.document.getElementById("zotero-collectionmenu");
                const item = [...menu.querySelectorAll(".zotero-custom-menu-item")].find(e => e.getAttribute("data-l10n-id") === "zotero-mcp-menu-export-files");
                if (!item) return "missing";
                const ev = new win.Event("popupshowing");
                menu.dispatchEvent(ev);
                return item.hidden ? "hidden" : "visible";
            }}
            out.library = await check("L1");
            out.collection = await check("C" + Zotero.Collections.getByLibraryAndKey(1, "{K['A']}").id);
            out.trash = await check("T1");
            return out;
        """)
        self.assertEqual(result["library"], "visible")
        self.assertEqual(result["collection"], "visible")
        self.assertNotEqual(result["trash"], "visible")

    def test_setup_dialog(self):
        result = js("""
            const win = Zotero.getMainWindow();
            const io = { folder: "/tmp", name: "My Library", scopeLabel: "My Library", structure: "collections",
                includeBibliography: true, bbtAvailable: true, pickFolder: async () => null, accepted: false };
            const dlg = win.openDialog("chrome://zotero-mcp/content/exportSetup.xhtml", "", "chrome,centerscreen", io);
            await new Promise(r => dlg.addEventListener("load", r, { once: true }));
            await Zotero.Promise.delay(300);
            dlg.document.getElementById("zmcp-name").value = "Renamed";
            dlg.document.getElementById("zmcp-structure").value = "flat";
            dlg.document.querySelector("dialog").acceptDialog();
            await Zotero.Promise.delay(300);
            return { accepted: io.accepted, name: io.name, structure: io.structure, bib: io.includeBibliography };
        """)
        self.assertEqual(result, {"accepted": True, "name": "Renamed", "structure": "flat", "bib": True})

    def test_bbt_export_window_keep_updated(self):
        bib = os.path.join(OUT, "rc", "Project A.bib")
        os.makedirs(os.path.dirname(bib), exist_ok=True)
        result = js(f"""
            const win = Zotero.getMainWindow();
            const UI = Zotero.ZoteroMCP.UI;
            const pending = UI.chooseBibliographyOptions(win);
            let dlg = null;
            for (let i = 0; i < 50 && !dlg; i++) {{
                await Zotero.Promise.delay(200);
                for (const w of Services.wm.getEnumerator(null)) {{
                    if (w.location.href === "chrome://zotero/content/exportOptions.xhtml") dlg = w;
                }}
            }}
            if (!dlg) return {{ error: "export options window did not open" }};
            await Zotero.Promise.delay(500);
            const doc = dlg.document;
            const labels = [...doc.querySelectorAll("#format-popup menuitem")].map(m => m.getAttribute("label"));
            const fileData = doc.getElementById("export-option-exportFileData");
            const keep = doc.getElementById("export-option-keepUpdated");
            keep.checked = true;
            doc.querySelector("dialog").acceptDialog();
            const io = await pending;
            const collection = Zotero.Collections.getByLibraryAndKey(1, "{K['A']}");
            const path = await UI.runBibliographyExport({{ collection, bibPath: {json.dumps(bib)}, io }});
            await Zotero.Promise.delay(1000);
            return {{ labels, fileDataHidden: !fileData || fileData.hidden, exportFileData: io.displayOptions.exportFileData,
                keepUpdated: io.displayOptions.keepUpdated, path }};
        """)
        self.assertNotIn("error", result)
        self.assertEqual(sorted(result["labels"]), ["Better BibLaTeX", "Better BibTeX"])
        self.assertTrue(result["fileDataHidden"])
        self.assertFalse(result["exportFileData"])
        self.assertTrue(result["keepUpdated"])
        with open(bib, encoding="utf-8") as f:
            self.assertIn("leeDeepResult2019", f.read())
        # Better BibTeX registered an auto-export for that path
        ae = js(f"""const ae = Zotero.BetterBibTeX.AutoExport.get({json.dumps(bib)});
            return ae ? {{ type: ae.type, translatorID: ae.translatorID }} : null;""")
        self.assertEqual(ae, {"type": "collection", "translatorID": "f895aa0d-f28e-47fe-b247-2ea77c6ed583"})

if __name__ == "__main__":
    unittest.main()
