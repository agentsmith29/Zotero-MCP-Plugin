"""Builds a known library in the TEST Zotero instance (refuses to run anywhere else)."""

import json
import os
import time

from mcp_client import evaluate

TEST_BASE = os.environ.get("TEST_BASE", "")

GUARD = """
const dataDir = Zotero.DataDirectory.dir;
if (!%s || !dataDir.startsWith(%s)) {
    throw new Error("Refusing to touch a library outside the test instance: " + dataDir);
}
""" % (json.dumps(TEST_BASE), json.dumps(TEST_BASE))

RESET = GUARD + """
const lib = Zotero.Libraries.userLibraryID;
const items = await Zotero.Items.getAll(lib, false, true, true);
if (items.length) await Zotero.Items.erase(items);
for (const c of Zotero.Collections.getByLibrary(lib, true, true).reverse()) {
    if (Zotero.Collections.get(c.id)) await c.eraseTx();
}
await Zotero.DB.queryAsync("DELETE FROM deletedCollections");
return true;
"""

BUILD = GUARD + r"""
const lib = Zotero.Libraries.userLibraryID;
const fixtures = PathUtils.join(PathUtils.parent(Zotero.DataDirectory.dir), "fixture-files");
await IOUtils.makeDirectory(fixtures, { createAncestors: true, ignoreExisting: true });
async function writeFile(name, text) {
    const p = PathUtils.join(fixtures, name);
    await IOUtils.writeUTF8(p, text);
    return p;
}
function pdf(label) {
    return "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% " + label + "\n%%EOF\n";
}
async function collection(name, parent) {
    const c = new Zotero.Collection({ libraryID: lib, name });
    if (parent) c.parentKey = parent.key;
    await c.saveTx();
    return c;
}
async function item(type, fields, creators, collections) {
    const i = new Zotero.Item(type);
    i.libraryID = lib;
    for (const [k, v] of Object.entries(fields)) i.setField(k, v);
    if (creators) i.setCreators(creators);
    if (collections) i.setCollections(collections.map(c => c.id));
    await i.saveTx();
    return i;
}
async function attach(parent, name, content, contentType, collections) {
    const file = await writeFile(name, content);
    const options = { file, contentType };
    if (parent) options.parentItemID = parent.id;
    if (collections) options.collections = collections.map(c => c.id);
    return Zotero.Attachments.importFromFile(options);
}
const A = await collection("Project A");
const R = await collection("Results", A);
const D = await collection("Deep", R);
const B = await collection("Project B");
const E = await collection("Empty");

const smith = await item("journalArticle", { title: "Example Paper", date: "2024", DOI: "10.1000/example.1", publicationTitle: "Journal of Tests" },
    [{ creatorType: "author", firstName: "Anna", lastName: "Smith" }], [A, B]);
const smithPDF = await attach(smith, "Smith - 2024 - Example Paper.pdf", pdf("smith"), "application/pdf");

const jones = await item("book", { title: "Big Book", date: "2020", ISBN: "978-3-16-148410-0" },
    [{ creatorType: "author", firstName: "Bob", lastName: "Jones" }], [R]);
const jonesPDF = await attach(jones, "Jones - 2020 - Big Book.pdf", pdf("jones"), "application/pdf");
const jonesEPUB = await attach(jones, "Jones - 2020 - Big Book.epub", "PK fake epub", "application/epub+zip");

const lee = await item("journalArticle", { title: "Deep Result", date: "2019" },
    [{ creatorType: "author", firstName: "Cara", lastName: "Lee" }], [D]);
const leePDF = await attach(lee, "Lee - 2019 - Deep Result.pdf", pdf("lee"), "application/pdf");

const report = await item("report", { title: "Unfiled Report", date: "2021" },
    [{ creatorType: "author", firstName: "Dan", lastName: "Unfiled" }]);
const reportPDF = await attach(report, "Unfiled - 2021 - Unfiled Report.pdf", pdf("report"), "application/pdf");

const standalone = await attach(null, "Standalone Scan.pdf", pdf("standalone"), "application/pdf", [B]);

const nofiles = await item("journalArticle", { title: "No Files Here", date: "2021", extra: "arXiv: 2101.00001" },
    [{ creatorType: "author", firstName: "Eve", lastName: "Arx" }], [A]);
const linked = await Zotero.Attachments.linkFromFile({ file: await writeFile("linked.pdf", pdf("linked")), parentItemID: nofiles.id });
// A linked file synced from Windows: its path is not a valid path on macOS/Linux
const winLinked = await Zotero.Attachments.linkFromFile({ file: await writeFile("win.pdf", pdf("win")), parentItemID: nofiles.id });
winLinked.attachmentPath = "C:\\Users\\someone\\Papers\\Windows Paper.pdf";
await winLinked.saveTx();

const snap = await item("webpage", { title: "Snapshot Page", url: "https://example.com/" },
    [{ creatorType: "author", firstName: "Fay", lastName: "Web" }], [B]);
const snapHTML = await attach(snap, "page.html", "<html><body>hi</body></html>", "text/html");
await IOUtils.writeUTF8(PathUtils.join(Zotero.Attachments.getStorageDirectory(snapHTML).path, "style.css"), "body{}");

const trashed = await item("journalArticle", { title: "Trashed Paper", date: "2018" },
    [{ creatorType: "author", firstName: "Gus", lastName: "Gone" }], [A]);
const trashedPDF = await attach(trashed, "Gone - 2018 - Trashed Paper.pdf", pdf("trashed"), "application/pdf");
await Zotero.Items.trashTx([trashed.id]);

const keys = { A: A.key, R: R.key, D: D.key, B: B.key, E: E.key,
    smith: smith.key, smithPDF: smithPDF.key, jones: jones.key, jonesPDF: jonesPDF.key, jonesEPUB: jonesEPUB.key,
    lee: lee.key, leePDF: leePDF.key, report: report.key, reportPDF: reportPDF.key, standalone: standalone.key,
    nofiles: nofiles.key, linked: linked.key, winLinked: winLinked.key, snap: snap.key, snapHTML: snapHTML.key,
    trashed: trashed.key, trashedPDF: trashedPDF.key };
return keys;
"""

WAIT_CITEKEYS = GUARD + """
const lib = Zotero.Libraries.userLibraryID;
const items = (await Zotero.Items.getAll(lib, true, false)).filter(i => i.isRegularItem());
return items.filter(i => !i.getField("citationKey")).length;
"""


def build_library():
    """Erases the test library and builds the fixture set; returns the keys."""
    if not TEST_BASE:
        raise RuntimeError("Set TEST_BASE to the test instance base directory")
    evaluate(RESET)
    keys = evaluate(BUILD)
    # Better BibTeX fills citation keys a moment after items are saved
    for _ in range(60):
        try:
            if evaluate(WAIT_CITEKEYS) == 0:
                break
        except RuntimeError:
            break
        time.sleep(0.5)
    return keys


if __name__ == "__main__":
    print(json.dumps(build_library(), indent=1))
