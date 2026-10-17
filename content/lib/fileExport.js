/* global Zotero, ZoteroMCP, IOUtils, PathUtils, setTimeout, clearTimeout */

// Copies stored attachment files into a folder tree that mirrors the collections.
// An index in the export root records every file the plugin created; only those are
// ever replaced or deleted, edited copies are kept as *_annotated_<date> files.
ZoteroMCP.FileExport = (function () {
	const { ToolError, Lib, Util } = ZoteroMCP;
	const INDEX_FILE = ".zotero-files-index.json";
	const INDEX_VERSION = 2;
	const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
	const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
	const AUTO_DELAY_MS = 30 * 1000;
	const SAMPLE = 25;

	const mutex = Util.createMutex();
	let autoTimer = null;
	let autoPendingReason = null;

	// --------------------------------------------------------------- naming

	function cleanSegment(name) {
		let clean = Zotero.File.getValidFileName(String(name || "").trim()).trim();
		if (!clean || clean === "." || clean === "..") {
			clean = "_";
		}
		return clean;
	}

	function withCounter(name, counter, isDir) {
		if (counter === 1) {
			return name;
		}
		if (isDir) {
			return `${name} (${counter})`;
		}
		const { base, ext } = Util.splitExtension(name);
		return ext ? `${base} (${counter}).${ext}` : `${base} (${counter})`;
	}

	// Does `candidate` equal `name` or `name (n)`?
	function isVariantOf(candidate, name, isDir) {
		if (candidate === name) {
			return true;
		}
		for (let n = 2; n < 1000; n++) {
			const variant = withCounter(name, n, isDir);
			if (variant === candidate) {
				return true;
			}
			if (variant.length > candidate.length + 4) {
				break;
			}
		}
		return false;
	}

	function pathTooLong(nativePath) {
		const parts = nativePath.split(/[\\/]/);
		if (parts.some(part => Util.utf8Length(part) > 255)) {
			return true;
		}
		if (Zotero.isWin) {
			return nativePath.length > 259;
		}
		return Util.utf8Length(nativePath) > (Zotero.isMac ? 1023 : 4095);
	}

	function joinRel(...parts) {
		return parts.filter(p => p !== "" && p !== undefined && p !== null).join("/");
	}

	function parentRel(rel) {
		const i = rel.lastIndexOf("/");
		return i < 0 ? "" : rel.slice(0, i);
	}

	function baseRel(rel) {
		const i = rel.lastIndexOf("/");
		return i < 0 ? rel : rel.slice(i + 1);
	}

	// ---------------------------------------------------------------- index

	async function readIndex(root) {
		const path = PathUtils.join(root, INDEX_FILE);
		const entries = new Map();
		if (!(await IOUtils.exists(path))) {
			return { entries, existed: false };
		}
		try {
			const json = JSON.parse(await IOUtils.readUTF8(path));
			for (const entry of json.entries || []) {
				// Only relative paths inside the root are trusted
				if (typeof entry.path !== "string" || !entry.path || entry.path.startsWith("/")
						|| entry.path.split("/").some(p => p === ".." || p === "." || p === "")) {
					continue;
				}
				entries.set(entry.path, entry);
			}
		}
		catch (e) {
			ZoteroMCP.logError(e);
			throw new ToolError(`The export index ${path} is unreadable; move it away to start over (files already there will then be treated as foreign and kept).`);
		}
		return { entries, existed: true };
	}

	async function writeIndex(root, entries) {
		const path = PathUtils.join(root, INDEX_FILE);
		const json = {
			version: INDEX_VERSION,
			generator: `${ZoteroMCP.PLUGIN_NAME} ${ZoteroMCP.version}`,
			generated: new Date().toISOString(),
			entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		};
		await IOUtils.writeUTF8(path, JSON.stringify(json, null, 1), { tmpPath: path + ".tmp" });
	}

	// --------------------------------------------------------------- layout

	async function isMultiFileSnapshot(attachment) {
		if (!HTML_TYPES.has(attachment.attachmentContentType)) {
			return false;
		}
		try {
			const dir = Zotero.Attachments.getStorageDirectory(attachment).path;
			const main = Lib.fileName(attachment);
			const children = await IOUtils.getChildren(dir);
			return children.map(PathUtils.filename).some(name => !name.startsWith(".") && name !== main);
		}
		catch (e) {
			return false;
		}
	}

	/**
	 * Folders (as segment arrays, relative to the export root) for an item
	 */
	function folderResolver(scope, structure) {
		if (structure === "flat") {
			return () => [[]];
		}
		if (scope.collection) {
			const rootDepth = Lib.collectionSegments(scope.collection).length;
			const subtree = new Set([scope.collection.id, ...Zotero.Collections.getByParent(scope.collection.id, true).map(c => c.id)]);
			return item => item.getCollections()
				.filter(id => subtree.has(id))
				.map(id => Lib.collectionSegments(Zotero.Collections.get(id)).slice(rootDepth).map(cleanSegment));
		}
		return (item) => {
			const ids = item.getCollections();
			if (!ids.length) {
				return [[]];
			}
			return ids.map(id => Lib.collectionSegments(Zotero.Collections.get(id)).map(cleanSegment));
		};
	}

	/**
	 * Works out where every stored file goes, reusing names from the previous index
	 * so paths stay stable between runs.
	 * @return {Promise<{desired: Map, report: Object}>}
	 */
	async function layout({ scope, structure, root, index }) {
		const report = { missing: [], skipped_snapshots: [], too_long: [], scanned_items: 0, files_found: 0 };
		const items = scope.collection ? Lib.collectionItems(scope.collection, true) : await Lib.getAllTopLevelItems();
		const foldersFor = folderResolver(scope, structure);

		// Per folder: the slots (files or per-item subfolders) to name there
		const folders = new Map(); // folderRel -> [{kind, ...}]
		const addSlot = (folderRel, slot) => {
			if (!folders.has(folderRel)) {
				folders.set(folderRel, []);
			}
			folders.get(folderRel).push(slot);
		};
		const flatSeen = new Set();

		for (const item of items) {
			report.scanned_items++;
			const files = [];
			for (const attachment of Lib.storedFiles(item)) {
				if (await isMultiFileSnapshot(attachment)) {
					report.skipped_snapshots.push({ attachment: attachment.key, item: item.key, name: Lib.fileName(attachment) });
					continue;
				}
				const sourcePath = await Lib.filePath(attachment);
				let srcSize = null;
				let srcMtime = null;
				if (sourcePath) {
					const st = await IOUtils.stat(sourcePath);
					srcSize = st.size;
					srcMtime = st.lastModified;
				}
				files.push({
					attachmentKey: attachment.key,
					itemKey: item.key,
					name: cleanSegment(Lib.fileName(attachment) || `${attachment.key}.bin`),
					sourcePath: sourcePath || null,
					srcSize,
					srcMtime
				});
			}
			if (!files.length) {
				continue;
			}
			report.files_found += files.length;
			for (const segments of foldersFor(item)) {
				const folderRel = segments.join("/");
				if (structure === "flat") {
					for (const file of files) {
						if (!flatSeen.has(file.attachmentKey)) {
							flatSeen.add(file.attachmentKey);
							addSlot(folderRel, Object.assign({ kind: "file" }, file));
						}
					}
				}
				else if (files.length === 1) {
					addSlot(folderRel, Object.assign({ kind: "file" }, files[0]));
				}
				else {
					let dirName;
					try {
						dirName = Zotero.Attachments.getFileBaseNameFromItem(item);
					}
					catch (e) {
						dirName = Lib.itemTitle(item);
					}
					addSlot(folderRel, { kind: "dir", itemKey: item.key, name: cleanSegment(dirName || item.key), files });
				}
			}
		}

		const previousByAttachment = new Map();
		for (const entry of index.entries.values()) {
			if (!previousByAttachment.has(entry.attachmentKey)) {
				previousByAttachment.set(entry.attachmentKey, []);
			}
			previousByAttachment.get(entry.attachmentKey).push(entry.path);
		}

		const desired = new Map();
		const nativeOf = rel => Util.nativeFromRelative(root, rel);

		// A name is free unless another slot took it or a foreign file sits there
		async function blocked(rel, isDir, taken) {
			if (taken.has(rel)) {
				return true;
			}
			if (index.entries.has(rel)) {
				return false;
			}
			let st;
			try {
				st = await IOUtils.stat(nativeOf(rel));
			}
			catch (e) {
				return false;
			}
			return isDir ? st.type !== "directory" : true;
		}

		async function assignNames(folderRel, slots) {
			const taken = new Set();
			const assigned = new Map();
			const keyOf = slot => (slot.kind === "dir" ? "d:" + slot.itemKey : "f:" + slot.attachmentKey);
			const sorted = slots.slice().sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));

			// 1. Keep the name a slot had last time, if it still fits the pattern
			for (const slot of sorted) {
				const isDir = slot.kind === "dir";
				const previous = isDir
					? slot.files.flatMap(f => previousByAttachment.get(f.attachmentKey) || [])
						.map(p => parentRel(p))
						.filter(p => parentRel(p) === folderRel)
					: (previousByAttachment.get(slot.attachmentKey) || []).filter(p => parentRel(p) === folderRel);
				for (const rel of previous) {
					const name = baseRel(rel);
					if (isVariantOf(name, slot.name, isDir) && !(await blocked(rel, isDir, taken))) {
						taken.add(rel);
						assigned.set(slot, name);
						break;
					}
				}
			}
			// 2. Everything else gets the first free name: name, name (2), name (3), ...
			for (const slot of sorted) {
				if (assigned.has(slot)) {
					continue;
				}
				const isDir = slot.kind === "dir";
				for (let n = 1; ; n++) {
					const name = withCounter(slot.name, n, isDir);
					const rel = joinRel(folderRel, name);
					if (!(await blocked(rel, isDir, taken))) {
						taken.add(rel);
						assigned.set(slot, name);
						break;
					}
				}
			}
			return assigned;
		}

		function addDesired(rel, file) {
			if (pathTooLong(nativeOf(rel))) {
				report.too_long.push({ path: rel, attachment: file.attachmentKey });
				return;
			}
			desired.set(rel, file);
		}

		for (const folderRel of [...folders.keys()].sort()) {
			const slots = folders.get(folderRel);
			const names = await assignNames(folderRel, slots);
			for (const slot of slots) {
				const rel = joinRel(folderRel, names.get(slot));
				if (slot.kind === "file") {
					addDesired(rel, slot);
				}
				else {
					const inner = await assignNames(rel, slot.files.map(f => Object.assign({ kind: "file" }, f)));
					for (const [fileSlot, name] of inner) {
						addDesired(joinRel(rel, name), fileSlot);
					}
				}
			}
		}

		for (const file of desired.values()) {
			if (!file.sourcePath) {
				report.missing.push({ attachment: file.attachmentKey, item: file.itemKey, name: file.name });
			}
		}
		return { desired, report };
	}

	// ---------------------------------------------------------------- mirror

	function sameMtime(a, b) {
		return Math.abs(Number(a || 0) - Number(b || 0)) < 1000;
	}

	async function annotatedName(rel, reserved, today) {
		const folder = parentRel(rel);
		const { base, ext } = Util.splitExtension(baseRel(rel));
		for (let n = 1; ; n++) {
			const name = `${base}_annotated_${today}${n > 1 ? "_" + n : ""}${ext ? "." + ext : ""}`;
			const candidate = joinRel(folder, name);
			if (reserved.has(candidate)) {
				continue;
			}
			if (!(await IOUtils.exists(Util.nativeFromRelative(reserved.root, candidate)))) {
				reserved.add(candidate);
				return candidate;
			}
		}
	}

	/**
	 * Compares the index and the disk with the desired layout and lists the actions.
	 * Reads files (stat, hashes of changed copies) but writes nothing.
	 */
	async function planActions(root, index, desired) {
		const actions = [];
		const keepEntries = new Map();
		const today = Util.localDate();
		const reserved = new Set(desired.keys());
		reserved.root = root;

		// State of every file the plugin created
		const owned = new Map(); // rel -> {entry, state: present|gone|edited}
		for (const [rel, entry] of index.entries) {
			let st = null;
			try {
				st = await IOUtils.stat(Util.nativeFromRelative(root, rel));
			}
			catch (e) {
				st = null;
			}
			if (!st || st.type !== "regular") {
				owned.set(rel, { entry, state: "gone" });
				continue;
			}
			if (st.size === entry.size && sameMtime(st.lastModified, entry.mtime)) {
				owned.set(rel, { entry, state: "present" });
				continue;
			}
			const sha = await Util.sha256File(Util.nativeFromRelative(root, rel));
			if (sha === entry.sha256) {
				owned.set(rel, { entry: Object.assign({}, entry, { size: st.size, mtime: st.lastModified }), state: "present" });
			}
			else {
				owned.set(rel, { entry, state: "edited" });
			}
		}

		// Edited copies are renamed and leave the index for good
		for (const [rel, info] of owned) {
			if (info.state === "edited") {
				const to = await annotatedName(rel, reserved, today);
				actions.push({ op: "annotate", path: rel, to, attachment: info.entry.attachmentKey });
			}
		}

		const stale = new Map(); // rel -> entry (present, unedited, no longer wanted there)
		for (const [rel, info] of owned) {
			if (info.state === "present" && !desired.has(rel)) {
				stale.set(rel, info.entry);
			}
		}
		const usedAsMoveSource = new Set();

		for (const rel of [...desired.keys()].sort()) {
			const want = desired.get(rel);
			const prev = owned.get(rel);
			const present = prev && prev.state === "present";
			if (!want.sourcePath) {
				// Source file missing in Zotero: keep an existing copy rather than delete it
				if (present && prev.entry.attachmentKey === want.attachmentKey) {
					keepEntries.set(rel, prev.entry);
					actions.push({ op: "keep", path: rel, attachment: want.attachmentKey, reason: "source missing" });
				}
				continue;
			}
			if (present) {
				const e = prev.entry;
				if (e.attachmentKey === want.attachmentKey && e.srcSize === want.srcSize && sameMtime(e.srcMtime, want.srcMtime)) {
					keepEntries.set(rel, e);
					actions.push({ op: "unchanged", path: rel, attachment: want.attachmentKey });
				}
				else {
					actions.push({ op: "update", path: rel, attachment: want.attachmentKey });
				}
				continue;
			}
			// New path: move an unedited copy of the same file if one is no longer needed elsewhere
			let source = null;
			for (const [staleRel, entry] of stale) {
				if (!usedAsMoveSource.has(staleRel) && entry.attachmentKey === want.attachmentKey
						&& entry.srcSize === want.srcSize && sameMtime(entry.srcMtime, want.srcMtime)) {
					source = staleRel;
					break;
				}
			}
			if (source) {
				usedAsMoveSource.add(source);
				actions.push({ op: "move", path: rel, from: source, attachment: want.attachmentKey });
			}
			else {
				actions.push({ op: "copy", path: rel, attachment: want.attachmentKey });
			}
		}

		for (const rel of stale.keys()) {
			if (!usedAsMoveSource.has(rel)) {
				actions.push({ op: "delete", path: rel, attachment: stale.get(rel).attachmentKey });
			}
		}
		return { actions, keepEntries };
	}

	async function removeEmptyFolders(root, folders) {
		let removed = 0;
		const candidates = [...folders].filter(Boolean).sort((a, b) => b.split("/").length - a.split("/").length);
		const done = new Set();
		for (let rel of candidates) {
			while (rel && !done.has(rel)) {
				done.add(rel);
				const native = Util.nativeFromRelative(root, rel);
				let children;
				try {
					children = await IOUtils.getChildren(native);
				}
				catch (e) {
					break;
				}
				const names = children.map(PathUtils.filename);
				if (names.some(name => !JUNK_FILES.has(name))) {
					break;
				}
				for (const child of children) {
					await IOUtils.remove(child, { ignoreAbsent: true });
				}
				await IOUtils.remove(native, { ignoreAbsent: true });
				removed++;
				rel = parentRel(rel);
			}
		}
		return removed;
	}

	async function executeActions(root, actions, desired, keepEntries, report) {
		const entries = new Map(keepEntries);
		const touchedFolders = new Set();
		const hashCache = new Map();
		const native = rel => Util.nativeFromRelative(root, rel);

		async function sourceHash(file) {
			const cacheKey = `${file.attachmentKey}|${file.srcSize}|${file.srcMtime}`;
			if (!hashCache.has(cacheKey)) {
				hashCache.set(cacheKey, await Util.sha256File(file.sourcePath));
			}
			return hashCache.get(cacheKey);
		}

		async function record(rel, file, sha) {
			const st = await IOUtils.stat(native(rel));
			entries.set(rel, {
				path: rel,
				attachmentKey: file.attachmentKey,
				itemKey: file.itemKey,
				size: st.size,
				mtime: st.lastModified,
				sha256: sha,
				srcSize: file.srcSize,
				srcMtime: file.srcMtime
			});
		}

		async function copyInto(rel, file, overwrite) {
			const target = native(rel);
			await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true, ignoreExisting: true });
			if (overwrite) {
				await IOUtils.remove(target, { ignoreAbsent: true });
			}
			await IOUtils.copy(file.sourcePath, target, { noOverwrite: true });
			try {
				await IOUtils.setModificationTime(target, file.srcMtime);
			}
			catch (e) {
				ZoteroMCP.log("Could not preserve mtime of " + target + ": " + e);
			}
			await record(rel, file, await sourceHash(file));
		}

		const fail = (action, e) => {
			report.failures.push({ op: action.op, path: action.path, error: e.message || String(e) });
		};

		for (const action of actions.filter(a => a.op === "annotate")) {
			try {
				await IOUtils.move(native(action.path), native(action.to), { noOverwrite: true });
				report.annotated.push({ from: action.path, to: action.to });
			}
			catch (e) {
				fail(action, e);
			}
		}
		for (const action of actions.filter(a => a.op === "delete")) {
			try {
				await IOUtils.remove(native(action.path), { ignoreAbsent: true });
				touchedFolders.add(parentRel(action.path));
				report.deleted++;
			}
			catch (e) {
				fail(action, e);
			}
		}
		const leftoverSources = [];
		for (const action of actions.filter(a => a.op === "move")) {
			const file = desired.get(action.path);
			try {
				if (await IOUtils.exists(native(action.path))) {
					await copyInto(action.path, file, false);
					leftoverSources.push(action.from);
					report.copied++;
				}
				else {
					await IOUtils.makeDirectory(PathUtils.parent(native(action.path)), { createAncestors: true, ignoreExisting: true });
					await IOUtils.move(native(action.from), native(action.path), { noOverwrite: true });
					await record(action.path, file, await sourceHash(file));
					report.moved++;
				}
				touchedFolders.add(parentRel(action.from));
			}
			catch (e) {
				fail(action, e);
			}
		}
		for (const rel of leftoverSources) {
			await IOUtils.remove(native(rel), { ignoreAbsent: true });
		}
		for (const action of actions.filter(a => a.op === "update" || a.op === "copy")) {
			try {
				await copyInto(action.path, desired.get(action.path), action.op === "update");
				report[action.op === "update" ? "updated" : "copied"]++;
			}
			catch (e) {
				fail(action, e);
			}
		}
		report.unchanged = actions.filter(a => a.op === "unchanged").length;
		report.kept_without_source = actions.filter(a => a.op === "keep").length;
		report.removed_folders = await removeEmptyFolders(root, touchedFolders);
		await writeIndex(root, entries);
	}

	function summarize(actions) {
		const counts = {};
		const samples = {};
		for (const action of actions) {
			counts[action.op] = (counts[action.op] || 0) + 1;
			if (action.op !== "unchanged") {
				samples[action.op] = samples[action.op] || [];
				if (samples[action.op].length < SAMPLE) {
					samples[action.op].push(action.from ? `${action.from} -> ${action.path}` : action.to ? `${action.path} -> ${action.to}` : action.path);
				}
			}
		}
		return { counts, samples };
	}

	// -------------------------------------------------------------- public run

	function scopeLabel(scope) {
		return scope.collection ? `collection ${Lib.collectionPath(scope.collection)} [${scope.collection.key}]` : Lib.libraryName();
	}

	/**
	 * @param {Object} options
	 * @param {{collection: Zotero.Collection|null}} options.scope
	 * @param {String} options.root - export root folder (the folder named after the library or collection)
	 * @param {String} [options.structure] - "collections" (default) or "flat"
	 * @param {Boolean} [options.dryRun]
	 */
	async function run({ scope, root, structure = "collections", dryRun = false, reason = "manual" }) {
		if (!Util.isAbsolutePath(root)) {
			throw new ToolError(`Export folder must be an absolute path: ${root}`);
		}
		if (!["collections", "flat"].includes(structure)) {
			throw new ToolError("structure must be 'collections' or 'flat'");
		}
		const started = Date.now();
		if (!dryRun) {
			await IOUtils.makeDirectory(root, { createAncestors: true, ignoreExisting: true });
		}
		const index = await readIndex(root);
		const { desired, report: layoutReport } = await layout({ scope, structure, root, index });
		const { actions, keepEntries } = await planActions(root, index, desired);

		const report = {
			root,
			scope: scopeLabel(scope),
			structure,
			reason,
			copied: 0,
			updated: 0,
			moved: 0,
			unchanged: 0,
			deleted: 0,
			annotated: [],
			kept_without_source: 0,
			missing: layoutReport.missing,
			skipped_snapshots: layoutReport.skipped_snapshots,
			too_long: layoutReport.too_long,
			failures: [],
			files_found: layoutReport.files_found,
			items_scanned: layoutReport.scanned_items
		};
		if (dryRun) {
			const { counts, samples } = summarize(actions);
			return {
				root,
				scope: report.scope,
				structure,
				first_export: !index.existed,
				counts,
				samples,
				missing_source_files: layoutReport.missing.length,
				skipped_snapshots: layoutReport.skipped_snapshots,
				too_long: layoutReport.too_long,
				actions_digest: Util.sha256Hex(Util.stableStringify(actions)).slice(0, 20)
			};
		}
		await executeActions(root, actions, desired, keepEntries, report);
		report.started = new Date(started).toISOString();
		report.duration_ms = Date.now() - started;
		return report;
	}

	function runExclusive(options) {
		return mutex.run(() => run(options));
	}

	async function writeBibliography({ scope, root, name, format = "biblatex" }) {
		const text = await ZoteroMCP.BBT.pullExport({ collection: scope.collection || null, format });
		const path = PathUtils.join(root, cleanSegment(name) + ".bib");
		await IOUtils.makeDirectory(root, { createAncestors: true, ignoreExisting: true });
		await IOUtils.writeUTF8(path, text);
		return path;
	}

	function formatReport(report) {
		const lines = [
			`Export to ${report.root}`,
			"",
			`Copied: ${report.copied}`,
			`Updated: ${report.updated}`,
			`Moved: ${report.moved}`,
			`Unchanged: ${report.unchanged}`,
			`Deleted: ${report.deleted}`,
			`Annotated copies kept: ${report.annotated.length}`,
			`Missing source files: ${report.missing.length}`,
			`Skipped multi-file snapshots: ${report.skipped_snapshots.length}`,
			`Paths too long: ${report.too_long.length}`,
			`Failures: ${report.failures.length}`
		];
		if (report.bibliography) {
			lines.push("", `Bibliography: ${report.bibliography}`);
		}
		if (report.bibliography_error) {
			lines.push("", `Bibliography failed: ${report.bibliography_error}`);
		}
		for (const failure of report.failures.slice(0, 10)) {
			lines.push(`  ${failure.op} ${failure.path}: ${failure.error}`);
		}
		return lines.join("\n");
	}

	// ----------------------------------------------------- global library sync

	function globalSettings() {
		const path = String(ZoteroMCP.Prefs.get("sync.path", "") || "").trim();
		const folderName = String(ZoteroMCP.Prefs.get("sync.folderName", "") || "").trim() || "My library";
		const mode = ZoteroMCP.Prefs.get("sync.mode", "manual") === "automatic" ? "automatic" : "manual";
		return { path, folderName, mode, root: path ? PathUtils.join(path, cleanSegment(folderName)) : null };
	}

	async function syncGlobal({ dryRun = false, reason = "manual" } = {}) {
		const settings = globalSettings();
		if (!settings.path) {
			throw new ToolError("No global sync folder is set (Zotero Settings > Zotero MCP > Folder sync)");
		}
		if (!Util.isAbsolutePath(settings.path)) {
			throw new ToolError(`The global sync folder must be an absolute path: ${settings.path}`);
		}
		if (!(await IOUtils.exists(settings.path))) {
			throw new ToolError(`The global sync folder does not exist: ${settings.path}`);
		}
		const options = { scope: { collection: null }, root: settings.root, structure: "collections", dryRun, reason };
		if (dryRun) {
			return run(options);
		}
		const report = await runExclusive(options);
		const summary = {
			finished: new Date().toISOString(),
			reason,
			root: report.root,
			copied: report.copied,
			updated: report.updated,
			moved: report.moved,
			unchanged: report.unchanged,
			deleted: report.deleted,
			annotated: report.annotated.length,
			missing: report.missing.length,
			skipped_snapshots: report.skipped_snapshots.length,
			too_long: report.too_long.length,
			failures: report.failures.length
		};
		ZoteroMCP.Prefs.set("sync.lastReport", JSON.stringify(summary));
		return report;
	}

	function scheduleAutoSync(reason) {
		const settings = globalSettings();
		if (settings.mode !== "automatic" || !settings.path) {
			return;
		}
		autoPendingReason = reason;
		if (autoTimer) {
			clearTimeout(autoTimer);
		}
		autoTimer = setTimeout(() => {
			autoTimer = null;
			const why = autoPendingReason;
			autoPendingReason = null;
			syncGlobal({ reason: "automatic: " + why }).catch((e) => {
				ZoteroMCP.logError(e);
				ZoteroMCP.Prefs.set("sync.lastReport", JSON.stringify({ finished: new Date().toISOString(), reason: why, error: e.message }));
			});
		}, AUTO_DELAY_MS);
	}

	function cancelAutoSync() {
		if (autoTimer) {
			clearTimeout(autoTimer);
			autoTimer = null;
		}
	}

	// ------------------------------------------------------------ MCP tools

	function toolScope(args) {
		const collection = args.collection ? Lib.resolveCollection(args.collection) : null;
		const defaultName = collection ? collection.name : Lib.libraryName();
		const name = String(args.folder_name || defaultName).trim() || defaultName;
		if (!Util.isAbsolutePath(args.target_folder || "")) {
			throw new ToolError("target_folder must be an absolute path; the export goes into <target_folder>/<folder_name>/");
		}
		return {
			scope: { collection },
			root: PathUtils.join(args.target_folder, cleanSegment(name)),
			name,
			structure: args.structure || "collections"
		};
	}

	async function exportFilesTool(args) {
		Lib.assertUserLibrary(args);
		return ZoteroMCP.Confirm.run("export_files", args, {
			preview: async (a) => {
				const { scope, root, name, structure } = toolScope(a);
				const preview = await run({ scope, root, structure, dryRun: true });
				if (!(await IOUtils.exists(a.target_folder))) {
					preview.creates_target_folder = a.target_folder;
				}
				if (a.include_bibliography) {
					preview.bibliography = PathUtils.join(root, cleanSegment(name) + ".bib");
				}
				return preview;
			},
			execute: async (a) => {
				const { scope, root, name, structure } = toolScope(a);
				const report = await runExclusive({ scope, root, structure, reason: "mcp" });
				if (a.include_bibliography) {
					try {
						report.bibliography = await writeBibliography({ scope, root, name, format: a.bibliography_format || "biblatex" });
					}
					catch (e) {
						report.bibliography_error = e.message;
					}
				}
				await ZoteroMCP.Audit.record("export_files", { root, copied: report.copied, updated: report.updated, deleted: report.deleted, moved: report.moved });
				return report;
			}
		});
	}

	async function syncLibraryFolderTool(args) {
		Lib.assertUserLibrary(args);
		return ZoteroMCP.Confirm.run("sync_library_folder", args, {
			preview: async () => {
				const preview = await syncGlobal({ dryRun: true });
				preview.mode = globalSettings().mode;
				return preview;
			},
			execute: async () => {
				const report = await syncGlobal({ reason: "mcp" });
				await ZoteroMCP.Audit.record("sync_library_folder", { root: report.root, copied: report.copied, updated: report.updated, deleted: report.deleted, moved: report.moved });
				return report;
			}
		});
	}

	return {
		INDEX_FILE,
		cleanSegment,
		run,
		runExclusive,
		writeBibliography,
		formatReport,
		globalSettings,
		syncGlobal,
		scheduleAutoSync,
		cancelAutoSync,
		exportFilesTool,
		syncLibraryFolderTool,
		get busy() {
			return mutex.busy;
		}
	};
})();
