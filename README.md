# Zotero MCP

A Zotero 10 plugin that runs an MCP server inside Zotero, so an agent such as Claude Code can maintain your personal library, and that exports or mirrors your attachment files into a folder tree that follows your collections.

- **Agent tools (26):** search and cite, edit metadata and citation keys, manage collections, restructure the whole library in one confirmed step, add items by DOI/ISBN/PMID/arXiv (Zotero's magic wand), Find Available PDF, find and merge duplicates, trash items, Better BibTeX bibliographies and settings, file export.
- **For you:** right-click My Library or a collection → **Export Files…**, and an optional automatic mirror of the whole library to one folder.

Scope: My Library only (no group libraries). Better BibTeX is required for bibliographies and citation keys; everything else works without it.

## Requirements

- Zotero 10.0 (the manifest allows 10.0.x)
- [Better BibTeX](https://retorque.re/zotero-better-bibtex/) 7.0 or newer (the plugin offers to install it)

## Install

1. Build the XPI: `./scripts/build-xpi.sh` → `dist/zotero-mcp.xpi`
2. Zotero → Tools → Plugins → gear menu → Install Plugin From File… → choose the XPI.
3. Open Zotero Settings → **Zotero MCP**.

## Connect Claude Code

The settings pane shows the endpoint, the token and two ready-made commands. Use one of them:

```bash
# only for Claude Code sessions started in the current project folder
claude mcp add -s local --transport http zotero http://127.0.0.1:23119/zotero-mcp/mcp --header "Authorization: Bearer <token>"

# for all projects
claude mcp add -s user --transport http zotero http://127.0.0.1:23119/zotero-mcp/mcp --header "Authorization: Bearer <token>"
```

There is deliberately no `-s project` variant: that scope writes a `.mcp.json` meant to be committed, which would publish the token. If both entries exist, the project one wins in its folder.

Claude Code then lists the tools in its next session. Claude Desktop cannot reach servers on your computer directly; it will need a small local bridge (planned, not part of this version).

### Transport details

- Endpoint `http://127.0.0.1:23119/zotero-mcp/mcp` on Zotero's own server, plain JSON responses (no SSE); health check `GET /zotero-mcp/ping`.
- Every request needs `Authorization: Bearer <token>`; requests with an `Origin` header (web pages) are refused.
- Both MCP protocol eras: the stateless 2026-07-28 revision (per-request metadata, `server/discover`, caching hints), which current Claude Code uses, and the `initialize`/`Mcp-Session-Id` revisions 2025-03-26, 2025-06-18 and 2025-11-25.

## Tools

| Group | Tools |
| --- | --- |
| Read | `search_items`, `get_item`, `list_collections`, `get_library_tree`, `get_citekeys`, `export_bibliography`, `get_bbt_settings`, `find_duplicates` |
| Write | `create_item`, `add_by_identifier`, `update_item`, `set_citekey`, `find_pdf`, `add_to_collections`, `remove_from_collections`, `move_items`, `create_collection`, `rename_collection`, `move_collection` |
| Two-phase | `apply_library_tree`, `merge_items`, `trash_items`, `delete_collection`, `set_bbt_settings`, `export_files`, `sync_library_folder` |

Every tool can be switched off in the settings; `set_bbt_settings` and `sync_library_folder` start switched off. A switched-off tool disappears from the agent's tool list (within a minute for current clients, otherwise at the next session) and is refused if called anyway.

### Safety model

- **Two-phase tools:** the first call changes nothing and returns a preview plus a `confirmation_id`. Only a second call with the same arguments and that ID executes. The ID is single-use, expires after 5 minutes and is invalidated if the library changes in between.
- **No duplicates on insert:** `create_item` and `add_by_identifier` look for the DOI, ISBN, arXiv ID (and PMID) first and file the existing item instead; `duplicate_force: true` overrides.
- **Separate verbs:** removing from a collection never deletes; only `trash_items`, `delete_collection` and `merge_items` move things to Zotero's trash. Nothing empties the trash.
- **Stable citation keys:** edits never touch `citationKey`; `regenerate_citekey` and `set_citekey` report old and new key with a warning about `\cite{}` references. The plugin checks that Better BibTeX's `resetKeyOnChange` is off and offers to fix it, never silently.
- **Audit log:** every executed write is appended to `zotero-mcp-audit.log` in the Zotero data directory.

### Restructuring with the library tree

`get_library_tree` returns collections (holding item keys), an `items` map with stored files, and unfiled items. Edit it and pass it to `apply_library_tree`:

- node without `key` → new collection; same `key`, new `name` → rename; same `key` elsewhere → move
- item key added to / removed from a collection's `items` → placement changes only (items are never deleted this way)
- `{"copy_of": "<key>", "duplicate_force": true}` → metadata-only copy with its own citekey; without `duplicate_force` it is just another placement of the same item
- moving a file entry to another item's `files` → re-parents the attachment
- `"delete": true` on a node → that collection goes to the trash (items kept); a node simply missing from the tree is an error
- the tree carries a structural `version`; a tree read before the last structural change is refused

## File export and folder sync

- **Right-click** My Library or a collection → **Export Files…** → choose a folder → set folder name, structure (preserve collections or flat) and whether to write a Better BibTeX bibliography → Better BibTeX's own export window (its **Keep updated** registers a normal BBT auto-export at that `.bib`).
- **Settings → Folder sync:** a global folder, the library folder name (default `My library`), manual or automatic mode (30 s after changes), **Sync Now**, and **Set Up Bibliography…** for a kept-updated `.bib`.
- **Tools:** `export_files` and `sync_library_folder` use the same engine.

Layout: subcollections become nested folders; items in no collection sit in the root; an item in several collections is copied into each; an item with several files gets its own subfolder (named by Zotero's file-name template). Only stored files are copied (PDF, EPUB, single-file snapshots, any other imported file); linked files and multi-file snapshots are skipped and reported.

Mirror rules: `.zotero-files-index.json` in the export root lists every file the plugin created (relative path, attachment key, size, mtime, SHA-256). Only those files are ever updated, moved or deleted; anything else in the folder is left alone. A copy you changed outside Zotero is renamed to `<name>_annotated_<YYYY-MM-DD>.<ext>` (`_2`, `_3`, … on the same day), kept for good, and Zotero's current file is copied to the original name. Folders left empty are removed. A source file missing in Zotero keeps its existing copy.

## Development

```
bootstrap.js            lifecycle, loads content/lib/*
content/lib/core.js     namespace, prefs, hashing, helpers
content/lib/mcpServer.js  MCP endpoint (auth, both protocol eras)
content/lib/tools.js    tool catalogue, schemas, switches
content/lib/library.js  read access, keys/paths, identifiers
content/lib/edit.js     single-step writes
content/lib/lookup.js   magic wand, Find Available PDF
content/lib/destructive.js  duplicates, merge, trash, delete collection
content/lib/libraryTree.js  get/apply library tree
content/lib/fileExport.js   export engine, mirror, global sync
content/lib/bbt.js      Better BibTeX bridge (JSON-RPC over loopback, pull export, prefs)
content/lib/confirm.js  two-phase confirmation
content/lib/audit.js    audit log
content/lib/ui.js       right-click flow, BBT export window, notices
content/preferences.*   settings pane;  content/exportSetup.*  export setup window
```

### Tests

The end-to-end suite starts a separate Zotero 10 with its own profile, data directory and port (23129), loads this plugin from source plus a test-only helper plugin (`tests/helper-plugin`, never shipped), builds a fixture library and drives everything over MCP:

```bash
# macOS
ZOTERO_APP=/Applications/Zotero.app TEST_BASE=/tmp/zmcp-test BBT_XPI=~/Downloads/zotero-better-bibtex.xpi tests/run-tests.sh

# Linux: downloads Zotero and Better BibTeX, runs headless under Xvfb
ZOTERO_VERSION=10.0.6 BBT_VERSION=9.0.71 scripts/ci-test-linux.sh
```

`NO_NETWORK=1` skips the online lookups; `KEEP_RUNNING=1` leaves the test Zotero open; `PLUGIN_XPI=dist/zotero-mcp.xpi` tests the built package instead of the sources. Your own Zotero profile and library are never touched.

### CI

`.github/workflows/ci.yml` runs on every push and pull request: the end-to-end suite on `ubuntu-latest` (`scripts/ci-test-linux.sh`), then, only if it passes, the XPI build, uploaded as the `zotero-mcp-xpi` artifact. Online lookup tests are skipped by default because they depend on external services; start the workflow manually with **online** ticked to include them. Zotero and Better BibTeX versions are pinned in the workflow's `env`.
