/* global Zotero, ZoteroMCP, IOUtils */

// Read access to My Library: lookups by key or path, item summaries, identifiers.
// Every tool goes through these helpers, so the personal-library scope guard lives here.
ZoteroMCP.Lib = (function () {
	const { ToolError } = ZoteroMCP;
	const KEY_RE = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
	const STORED_LINK_MODES = new Set([0, 1]); // imported_file, imported_url
	const LINK_MODE_NAMES = ["imported_file", "imported_url", "linked_file", "linked_url", "embedded_image"];

	function libraryID() {
		return Zotero.Libraries.userLibraryID;
	}

	function libraryName() {
		return Zotero.Libraries.getName(libraryID()) || "My Library";
	}

	// Rejects any attempt to address a group library
	function assertUserLibrary(args) {
		for (const name of ["library_id", "libraryID", "library"]) {
			if (args && args[name] !== undefined && args[name] !== null) {
				const value = args[name];
				if (value !== libraryID() && String(value) !== String(libraryID()) && value !== "My Library") {
					throw new ToolError("Only My Library (the personal library) is supported; group libraries are out of scope.");
				}
			}
		}
	}

	function isKey(value) {
		return typeof value === "string" && KEY_RE.test(value);
	}

	// ------------------------------------------------------------------ items

	function getItem(key, { allowTrashed = false, allowChild = true, label = "Item" } = {}) {
		if (!isKey(key)) {
			throw new ToolError(`${label} key '${key}' is not a valid Zotero key (8 characters, e.g. ABCD2345)`);
		}
		const item = Zotero.Items.getByLibraryAndKey(libraryID(), key);
		if (!item) {
			throw new ToolError(`${label} '${key}' not found in My Library`);
		}
		if (!allowTrashed && item.deleted) {
			throw new ToolError(`${label} '${key}' is in the trash`);
		}
		if (!allowChild && !item.isTopLevelItem()) {
			throw new ToolError(`${label} '${key}' is a child item (attachment or note) of '${item.parentKey}'`);
		}
		return item;
	}

	// Resolves all keys, reporting every unknown key at once
	function getItems(keys, options = {}) {
		if (!Array.isArray(keys) || !keys.length) {
			throw new ToolError("Provide at least one item key");
		}
		const items = [];
		const errors = [];
		for (const key of [...new Set(keys)]) {
			try {
				items.push(getItem(key, options));
			}
			catch (e) {
				if (!(e instanceof ToolError)) {
					throw e;
				}
				errors.push(e.message);
			}
		}
		if (errors.length) {
			throw new ToolError(errors.join("; "), { errors });
		}
		return items;
	}

	async function getAllTopLevelItems() {
		const items = await Zotero.Items.getAll(libraryID(), true, false);
		await Zotero.Items.loadDataTypes(items);
		return items;
	}

	function citekey(item) {
		try {
			return item.getField("citationKey") || "";
		}
		catch (e) {
			return "";
		}
	}

	function year(item) {
		try {
			const date = item.getField("date", true, true);
			const y = date ? date.slice(0, 4) : "";
			return y && y !== "0000" ? parseInt(y) : null;
		}
		catch (e) {
			return null;
		}
	}

	function firstCreator(item) {
		try {
			return item.getField("firstCreator") || "";
		}
		catch (e) {
			return "";
		}
	}

	function itemTitle(item) {
		if (item.isNote()) {
			return Zotero.Utilities.Item.noteToTitle(item.getNote()) || "(note)";
		}
		return item.getDisplayTitle ? item.getDisplayTitle() : item.getField("title");
	}

	function isStoredFile(attachment) {
		return attachment.isAttachment() && STORED_LINK_MODES.has(attachment.attachmentLinkMode);
	}

	// Zotero's attachmentFilename throws for linked files whose stored path is not a valid
	// absolute path here (e.g. a Windows path synced to a Mac, or an old relative path)
	function fileName(attachment) {
		try {
			return attachment.attachmentFilename || "";
		}
		catch (e) {
			const path = attachment.attachmentPath || "";
			return path.replace(/^(?:attachments|storage):/, "").split(/[/\\]/).pop();
		}
	}

	// Path of an existing file, or null; never throws for unusable linked paths
	async function filePath(attachment) {
		try {
			return (await attachment.getFilePathAsync()) || null;
		}
		catch (e) {
			return null;
		}
	}

	// Stored files (imported_file / imported_url) belonging to a top-level item
	function storedFiles(item) {
		if (item.isAttachment()) {
			return isStoredFile(item) && !item.deleted ? [item] : [];
		}
		if (!item.isRegularItem()) {
			return [];
		}
		return Zotero.Items.get(item.getAttachments(false)).filter(att => isStoredFile(att) && !att.deleted);
	}

	async function fileInfo(attachment, { stat = true } = {}) {
		const info = {
			key: attachment.key,
			name: fileName(attachment),
			content_type: attachment.attachmentContentType || ""
		};
		if (stat) {
			const path = await filePath(attachment);
			info.exists = !!path;
			if (path) {
				try {
					info.size = (await IOUtils.stat(path)).size;
				}
				catch (e) {
					info.exists = false;
				}
			}
		}
		return info;
	}

	// ------------------------------------------------------------ collections

	function allCollections() {
		return Zotero.Collections.getByLibrary(libraryID(), true);
	}

	function childCollections(parent) {
		const list = parent
			? Zotero.Collections.getByParent(parent.id, false)
			: Zotero.Collections.getByLibrary(libraryID(), false);
		return list.slice().sort((a, b) => Zotero.localeCompare(a.name, b.name));
	}

	function collectionSegments(collection) {
		const segments = [];
		const seen = new Set();
		let current = collection;
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			segments.unshift(current.name);
			current = current.parentKey ? Zotero.Collections.getByLibraryAndKey(libraryID(), current.parentKey) : null;
		}
		return segments;
	}

	function collectionPath(collection) {
		return collectionSegments(collection).join("/");
	}

	function isAncestorOrSelf(ancestor, collection) {
		let current = collection;
		const seen = new Set();
		while (current && !seen.has(current.id)) {
			if (current.id === ancestor.id) {
				return true;
			}
			seen.add(current.id);
			current = current.parentKey ? Zotero.Collections.getByLibraryAndKey(libraryID(), current.parentKey) : null;
		}
		return false;
	}

	/**
	 * Resolves a collection by key, or by path ("Parent/Child") only when exactly one matches
	 */
	function resolveCollection(ref, { label = "Collection" } = {}) {
		if (ref && typeof ref === "object" && ref.key) {
			ref = ref.key;
		}
		if (typeof ref !== "string" || !ref.trim()) {
			throw new ToolError(`${label} must be a collection key or path`);
		}
		ref = ref.trim();
		if (isKey(ref)) {
			const collection = Zotero.Collections.getByLibraryAndKey(libraryID(), ref);
			if (collection && !collection.deleted) {
				return collection;
			}
			if (collection && collection.deleted) {
				throw new ToolError(`${label} '${ref}' is in the trash`);
			}
		}
		let path = ref.replace(/^\/+|\/+$/g, "");
		const libName = libraryName();
		if (path.startsWith(libName + "/")) {
			path = path.slice(libName.length + 1);
		}
		const wanted = path.split("/").map(s => s.trim()).join("/");
		const matches = allCollections().filter(c => collectionSegments(c).map(s => s.trim()).join("/") === wanted);
		if (matches.length === 1) {
			return matches[0];
		}
		if (!matches.length) {
			const leaf = wanted.split("/").pop().toLowerCase();
			const similar = allCollections()
				.filter(c => c.name.toLowerCase().includes(leaf))
				.slice(0, 10)
				.map(c => ({ key: c.key, path: collectionPath(c) }));
			throw new ToolError(`${label} '${ref}' not found`, similar.length ? { similar } : undefined);
		}
		throw new ToolError(`${label} path '${ref}' is ambiguous; use one of these keys`, {
			candidates: matches.map(c => ({ key: c.key, path: collectionPath(c) }))
		});
	}

	function resolveCollections(refs, options) {
		if (!Array.isArray(refs)) {
			refs = refs ? [refs] : [];
		}
		const result = [];
		const seen = new Set();
		for (const ref of refs) {
			const collection = resolveCollection(ref, options);
			if (!seen.has(collection.id)) {
				seen.add(collection.id);
				result.push(collection);
			}
		}
		return result;
	}

	function itemCollectionPaths(item) {
		if (!item.isTopLevelItem()) {
			return [];
		}
		return Zotero.Collections.get(item.getCollections())
			.filter(c => c && !c.deleted)
			.map(c => ({ key: c.key, path: collectionPath(c) }));
	}

	// Top-level, non-trashed items in a collection, optionally with its subcollections
	function collectionItems(collection, recursive) {
		const ids = new Set(collection.getChildItems(true, false));
		if (recursive) {
			for (const child of Zotero.Collections.getByParent(collection.id, true)) {
				for (const id of child.getChildItems(true, false)) {
					ids.add(id);
				}
			}
		}
		return Zotero.Items.get([...ids]).filter(item => item && !item.deleted && item.isTopLevelItem());
	}

	// ------------------------------------------------------------ identifiers

	function normalizeDOI(value) {
		const doi = value ? Zotero.Utilities.cleanDOI(String(value)) : null;
		return doi ? doi.toLowerCase() : null;
	}

	function normalizeISBN(value) {
		if (!value) {
			return null;
		}
		const isbn = Zotero.Utilities.cleanISBN(String(value));
		if (!isbn) {
			return null;
		}
		return Zotero.Utilities.toISBN13(isbn) || isbn;
	}

	const ARXIV_RE = /(?:arxiv[:/\s.]*|abs\/|pdf\/)?((?:\d{4}\.\d{4,5})|(?:[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?/i;

	function normalizeArXiv(value) {
		if (!value) {
			return null;
		}
		const m = ARXIV_RE.exec(String(value));
		return m ? m[1].toLowerCase() : null;
	}

	function extraLines(extra, label) {
		const out = [];
		const re = new RegExp("^\\s*" + label + "\\s*:\\s*(.+)$", "gim");
		let m;
		while ((m = re.exec(extra || ""))) {
			out.push(m[1].trim());
		}
		return out;
	}

	function getFieldSafe(item, field) {
		try {
			return item.getField(field) || "";
		}
		catch (e) {
			return "";
		}
	}

	/**
	 * Identifiers of an item, or of a plain {field: value} object about to become one
	 * @return {{doi: String[], isbn: String[], arxiv: String[], pmid: String[]}}
	 */
	function identifiersOf(itemOrFields) {
		const get = itemOrFields instanceof Zotero.Item
			? field => getFieldSafe(itemOrFields, field)
			: field => (itemOrFields && itemOrFields[field]) || "";
		const extra = get("extra");
		const ids = { doi: new Set(), isbn: new Set(), arxiv: new Set(), pmid: new Set() };

		for (const value of [get("DOI"), ...extraLines(extra, "DOI")]) {
			const doi = normalizeDOI(value);
			if (doi) {
				ids.doi.add(doi);
				const arxivFromDOI = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
				if (arxivFromDOI) {
					ids.arxiv.add(normalizeArXiv(arxivFromDOI[1]));
				}
			}
		}
		for (const chunk of String(get("ISBN")).split(/[\s,;]+/)) {
			const isbn = normalizeISBN(chunk);
			if (isbn) {
				ids.isbn.add(isbn);
			}
		}
		const url = get("url");
		const arxivCandidates = [
			...extraLines(extra, "arXiv"),
			/^arxiv:/i.test(get("archiveID")) ? get("archiveID") : "",
			/arxiv\.org\/(abs|pdf)\//i.test(url) ? url.replace(/^.*arxiv\.org\/(abs|pdf)\//i, "") : ""
		];
		for (const value of arxivCandidates) {
			const id = normalizeArXiv(value);
			if (id) {
				ids.arxiv.add(id);
			}
		}
		for (const value of extraLines(extra, "PMID")) {
			if (/^\d+$/.test(value)) {
				ids.pmid.add(value);
			}
		}
		return {
			doi: [...ids.doi],
			isbn: [...ids.isbn],
			arxiv: [...ids.arxiv].filter(Boolean),
			pmid: [...ids.pmid]
		};
	}

	function hasIdentifiers(ids) {
		return ids.doi.length || ids.isbn.length || ids.arxiv.length || ids.pmid.length;
	}

	/**
	 * Regular, non-trashed items sharing any DOI, ISBN, arXiv ID or PMID with `ids`
	 * @return {Array<{item: Zotero.Item, matchedBy: String[]}>}
	 */
	async function findByIdentifiers(ids, { excludeIDs = [] } = {}) {
		if (!hasIdentifiers(ids)) {
			return [];
		}
		const exclude = new Set(excludeIDs);
		const matches = [];
		for (const item of await getAllTopLevelItems()) {
			if (!item.isRegularItem() || exclude.has(item.id)) {
				continue;
			}
			const other = identifiersOf(item);
			const matchedBy = [];
			for (const type of ["doi", "isbn", "arxiv", "pmid"]) {
				const hit = ids[type].find(value => other[type].includes(value));
				if (hit) {
					matchedBy.push(`${type}:${hit}`);
				}
			}
			if (matchedBy.length) {
				matches.push({ item, matchedBy });
			}
		}
		return matches;
	}

	// ---------------------------------------------------------------- output

	function itemSummary(item, { collections = true } = {}) {
		const summary = {
			key: item.key,
			type: item.itemType,
			title: itemTitle(item),
			creator: firstCreator(item) || undefined,
			year: year(item) || undefined,
			citekey: item.isRegularItem() ? (citekey(item) || undefined) : undefined
		};
		if (!item.isTopLevelItem()) {
			summary.parent = item.parentKey;
		}
		if (collections && item.isTopLevelItem()) {
			summary.collections = itemCollectionPaths(item);
		}
		return summary;
	}

	async function itemDetail(item) {
		const json = item.toJSON();
		const detail = {
			key: item.key,
			type: item.itemType,
			citekey: item.isRegularItem() ? citekey(item) : undefined,
			trashed: item.deleted || undefined,
			parent: item.parentKey || undefined,
			fields: {},
			creators: json.creators,
			tags: json.tags,
			collections: itemCollectionPaths(item),
			relations: json.relations && Object.keys(json.relations).length ? json.relations : undefined,
			date_added: item.dateAdded,
			date_modified: item.dateModified
		};
		for (const [field, value] of Object.entries(json)) {
			if (["key", "version", "itemType", "creators", "tags", "collections", "relations", "dateAdded",
				"dateModified", "parentItem", "deleted", "note", "linkMode", "contentType", "charset", "filename",
				"path", "md5", "mtime"].includes(field)) {
				continue;
			}
			if (value !== "" && value !== undefined) {
				detail.fields[field] = value;
			}
		}
		if (item.isNote()) {
			detail.note = item.getNote();
		}
		if (item.isAttachment()) {
			detail.attachment = {
				link_mode: LINK_MODE_NAMES[item.attachmentLinkMode] || String(item.attachmentLinkMode),
				content_type: item.attachmentContentType || "",
				file_name: fileName(item) || undefined,
				path: (await filePath(item)) || undefined
			};
		}
		if (item.isRegularItem()) {
			const children = Zotero.Items.get(item.getAttachments(false).concat(item.getNotes(false)));
			detail.attachments = [];
			detail.notes = [];
			for (const child of children) {
				if (child.isAttachment()) {
					detail.attachments.push({
						key: child.key,
						title: child.getField("title"),
						link_mode: LINK_MODE_NAMES[child.attachmentLinkMode] || String(child.attachmentLinkMode),
						content_type: child.attachmentContentType || "",
						file_name: fileName(child) || undefined,
						file_exists: isStoredFile(child) ? !!(await filePath(child)) : undefined
					});
				}
				else {
					detail.notes.push({ key: child.key, title: itemTitle(child) });
				}
			}
		}
		return detail;
	}

	// ------------------------------------------------------------- read tools

	const QUICK_MODES = {
		titleCreatorYear: "quicksearch-titleCreatorYear",
		fields: "quicksearch-fields",
		everything: "quicksearch-everything"
	};

	async function searchItems(args) {
		assertUserLibrary(args);
		const limit = Math.min(Math.max(parseInt(args.limit) || 50, 1), 500);
		const offset = Math.max(parseInt(args.offset) || 0, 0);
		const search = new Zotero.Search();
		search.libraryID = libraryID();
		if (args.query) {
			const mode = QUICK_MODES[args.mode || "titleCreatorYear"];
			if (!mode) {
				throw new ToolError(`mode must be one of ${Object.keys(QUICK_MODES).join(", ")}`);
			}
			search.addCondition(mode, "contains", String(args.query));
		}
		for (const cond of args.conditions || []) {
			if (!cond || !cond.field || !cond.operator) {
				throw new ToolError("Each condition needs field and operator (e.g. {field: 'title', operator: 'contains', value: 'x'})");
			}
			try {
				search.addCondition(cond.field, cond.operator, cond.value === undefined ? "" : String(cond.value));
			}
			catch (e) {
				throw new ToolError(`Invalid condition ${JSON.stringify(cond)}: ${e.message}`);
			}
		}
		if (args.item_type) {
			search.addCondition("itemType", "is", args.item_type);
		}
		if (args.tag) {
			search.addCondition("tag", "is", args.tag);
		}
		if (args.collection) {
			const collection = resolveCollection(args.collection);
			search.addCondition("collection", "is", collection.key);
			if (args.include_subcollections !== false) {
				search.addCondition("recursive", "true");
			}
		}
		if (!args.query && !(args.conditions || []).length && !args.item_type && !args.tag && !args.collection) {
			throw new ToolError("Provide query, conditions, item_type, tag or collection");
		}
		const ids = await search.search();
		const items = Zotero.Items.get(ids);
		// Matches in attachments or notes count for their parent item
		const seen = new Set();
		const results = [];
		for (const item of items) {
			let top = item;
			if (!item.isTopLevelItem()) {
				top = Zotero.Items.get(item.parentID);
			}
			if (!top || top.deleted || seen.has(top.id)) {
				continue;
			}
			if (top.isNote() && !args.include_notes) {
				continue;
			}
			seen.add(top.id);
			results.push(top);
		}
		results.sort((a, b) => Zotero.localeCompare(itemTitle(a), itemTitle(b)));
		const page = results.slice(offset, offset + limit);
		return {
			total: results.length,
			offset,
			returned: page.length,
			items: page.map(item => itemSummary(item))
		};
	}

	function collectionNode(collection, recursive) {
		const node = {
			key: collection.key,
			name: collection.name,
			path: collectionPath(collection),
			item_count: collectionItems(collection, false).length
		};
		const children = childCollections(collection);
		if (recursive) {
			node.collections = children.map(child => collectionNode(child, true));
		}
		else {
			node.subcollection_count = children.length;
		}
		return node;
	}

	function listCollections(args) {
		assertUserLibrary(args);
		const recursive = args.recursive !== false;
		const parent = args.parent ? resolveCollection(args.parent, { label: "Parent collection" }) : null;
		return {
			library: libraryName(),
			parent: parent ? { key: parent.key, path: collectionPath(parent) } : null,
			collections: childCollections(parent).map(c => collectionNode(c, recursive))
		};
	}

	async function getItemTool(args) {
		assertUserLibrary(args);
		const keys = args.keys || (args.key ? [args.key] : []);
		const items = getItems(keys, { allowTrashed: true });
		const details = [];
		for (const item of items) {
			details.push(await itemDetail(item));
		}
		return keys.length === 1 && args.key ? details[0] : { items: details };
	}

	return {
		KEY_RE,
		LINK_MODE_NAMES,
		libraryID,
		libraryName,
		assertUserLibrary,
		isKey,
		getItem,
		getItems,
		getAllTopLevelItems,
		citekey,
		year,
		firstCreator,
		itemTitle,
		isStoredFile,
		fileName,
		filePath,
		storedFiles,
		fileInfo,
		allCollections,
		childCollections,
		collectionSegments,
		collectionPath,
		isAncestorOrSelf,
		resolveCollection,
		resolveCollections,
		itemCollectionPaths,
		collectionItems,
		normalizeDOI,
		normalizeISBN,
		normalizeArXiv,
		identifiersOf,
		hasIdentifiers,
		findByIdentifiers,
		itemSummary,
		itemDetail,
		searchItems,
		listCollections,
		getItemTool
	};
})();
