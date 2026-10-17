/* global Zotero, ZoteroMCP, IOUtils, PathUtils */

// The 26 MCP tools: schemas, annotations, groups and the per-tool on/off switches.
ZoteroMCP.Tools = (function () {
	const { ToolError, Lib } = ZoteroMCP;

	const str = (description, extra) => Object.assign({ type: "string", description }, extra);
	const bool = (description, extra) => Object.assign({ type: "boolean", description }, extra);
	const int = (description, extra) => Object.assign({ type: "integer", description }, extra);
	const strArray = (description, extra) => Object.assign({ type: "array", items: { type: "string" }, description }, extra);
	const confirmation = str("Omit on the first call. Pass the confirmation_id from the preview to execute.");
	const collectionRef = "Collection key (8 characters) or unique path like 'Parent/Child'";

	const CREATORS = {
		type: "array",
		description: "Creators in order, e.g. [{\"creatorType\": \"author\", \"firstName\": \"Ada\", \"lastName\": \"Lovelace\"}] or {\"creatorType\": \"editor\", \"name\": \"WHO\"}",
		items: {
			type: "object",
			properties: {
				creatorType: str("author, editor, contributor, ..."),
				firstName: str("Given name"),
				lastName: str("Family name"),
				name: str("Single-field name (institutions)")
			}
		}
	};

	async function exportBibliography(args) {
		Lib.assertUserLibrary(args);
		const format = args.format || "biblatex";
		const collection = args.collection ? Lib.resolveCollection(args.collection) : null;
		let text;
		if (collection && args.include_subcollections === false) {
			text = await ZoteroMCP.BBT.exportItems(Lib.collectionItems(collection, false).filter(i => i.isRegularItem()), format);
		}
		else {
			text = await ZoteroMCP.BBT.pullExport({ collection, format });
		}
		const entries = (text.match(/^@\w+\s*\{/gm) || []).length;
		if (args.target) {
			if (!ZoteroMCP.Util.isAbsolutePath(args.target)) {
				throw new ToolError("target must be an absolute file path");
			}
			await IOUtils.makeDirectory(PathUtils.parent(args.target), { createAncestors: true, ignoreExisting: true });
			await IOUtils.writeUTF8(args.target, text);
			return { written: args.target, entries, bytes: text.length };
		}
		return { entries, format, bibliography: text };
	}

	async function getCitekeys(args) {
		Lib.assertUserLibrary(args);
		Lib.getItems(args.keys, { allowTrashed: true });
		const map = await ZoteroMCP.BBT.citekeys(args.keys);
		return { citekeys: map };
	}

	const TOOLS = [
		// ------------------------------------------------------------- read
		{
			name: "search_items",
			group: "read",
			title: "Search items",
			description: "Search My Library. Quick search (title/creator/year, all fields, or everything incl. full text) and/or field conditions. Returns item key, citekey, title, year, first creator and collection paths. Matches in attachments or notes return their parent item.",
			inputSchema: {
				type: "object",
				properties: {
					query: str("Quick-search text"),
					mode: str("Quick-search mode", { enum: ["titleCreatorYear", "fields", "everything"] }),
					conditions: {
						type: "array",
						description: "Zotero search conditions, all must match, e.g. [{\"field\": \"DOI\", \"operator\": \"contains\", \"value\": \"10.1000\"}]. Operators: is, isNot, contains, doesNotContain, isBefore, isAfter, isInTheLast",
						items: { type: "object", properties: { field: str("Field or condition name"), operator: str("Operator"), value: str("Value") }, required: ["field", "operator"] }
					},
					collection: str(collectionRef + "; limits results to this collection"),
					include_subcollections: bool("With collection: also search subcollections (default true)"),
					item_type: str("Only this item type, e.g. journalArticle"),
					tag: str("Only items with this tag"),
					include_notes: bool("Also return standalone notes (default false)"),
					limit: int("Max results (default 50, max 500)"),
					offset: int("Skip this many results (paging)")
				}
			},
			annotations: { readOnlyHint: true },
			handler: args => Lib.searchItems(args)
		},
		{
			name: "get_item",
			group: "read",
			title: "Get item",
			description: "Full metadata of one item (or several via keys): fields, creators, tags, all collection paths, attachments with file names, notes, citekey.",
			inputSchema: {
				type: "object",
				properties: { key: str("Item key"), keys: strArray("Several item keys") }
			},
			annotations: { readOnlyHint: true },
			handler: args => Lib.getItemTool(args)
		},
		{
			name: "list_collections",
			group: "read",
			title: "List collections",
			description: "Collection tree of My Library (or below one collection) with keys, paths and direct item counts.",
			inputSchema: {
				type: "object",
				properties: {
					parent: str(collectionRef + "; list only below this collection"),
					recursive: bool("Include all levels (default true)")
				}
			},
			annotations: { readOnlyHint: true },
			handler: args => Lib.listCollections(args)
		},
		{
			name: "get_library_tree",
			group: "read",
			title: "Get library tree",
			description: "Whole structure of My Library or of one collection in one call: nested collections holding item keys, an items map (citekey, type, creator, year, title, stored files) and unfiled items. Edit the JSON and pass it to apply_library_tree to restructure. format \"text\" gives a cheaper read-only outline. Large libraries return only collection counts; then request subtrees.",
			inputSchema: {
				type: "object",
				properties: {
					collection: str(collectionRef + "; the tree then starts at this collection"),
					format: str("json (editable, default) or text (read-only outline)", { enum: ["json", "text"] }),
					ignore_limit: bool("Return the full tree even above the size limit from the settings")
				}
			},
			annotations: { readOnlyHint: true },
			handler: args => ZoteroMCP.LibraryTree.getTool(args)
		},
		{
			name: "get_citekeys",
			group: "read",
			title: "Get citation keys",
			description: "Better BibTeX citation keys for item keys.",
			inputSchema: { type: "object", properties: { keys: strArray("Item keys") }, required: ["keys"] },
			annotations: { readOnlyHint: true },
			handler: getCitekeys
		},
		{
			name: "export_bibliography",
			group: "read",
			title: "Export bibliography",
			description: "Better BibTeX export (BibLaTeX or BibTeX) of My Library or a collection. Returns the text, or writes it to target (absolute .bib path) and returns the path.",
			inputSchema: {
				type: "object",
				properties: {
					collection: str(collectionRef + "; default: whole library"),
					include_subcollections: bool("Include items of subcollections (default true)"),
					format: str("biblatex (default) or bibtex", { enum: ["biblatex", "bibtex"] }),
					target: str("Absolute path of a .bib file to write instead of returning the text")
				}
			},
			annotations: { readOnlyHint: true },
			handler: exportBibliography
		},
		{
			name: "get_bbt_settings",
			group: "read",
			title: "Get Better BibTeX settings",
			description: "Better BibTeX version, status, all its preferences, differences from the expected profile and which settings set_bbt_settings may change.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			annotations: { readOnlyHint: true },
			handler: () => ZoteroMCP.BBT.getSettingsTool()
		},
		{
			name: "find_duplicates",
			group: "read",
			title: "Find duplicates",
			description: "Duplicate sets found by Zotero's duplicate detection, with a suggested master (oldest item) per set.",
			inputSchema: { type: "object", properties: { limit: int("Max sets (default 50)") } },
			annotations: { readOnlyHint: true },
			handler: args => ZoteroMCP.Destructive.findDuplicates(args)
		},

		// ------------------------------------------------------------ write
		{
			name: "create_item",
			group: "write",
			title: "Create item",
			description: "Create an item manually. If an item with the same DOI, ISBN or arXiv ID (from fields, incl. Extra and URL) exists, nothing is created: the existing item is filed into the collections and returned. duplicate_force: true creates a new item anyway.",
			inputSchema: {
				type: "object",
				properties: {
					item_type: str("Zotero item type, e.g. journalArticle, book, bookSection, conferencePaper, thesis, report, preprint, webpage"),
					fields: { type: "object", description: "Zotero fields, e.g. {\"title\": ..., \"date\": \"2024\", \"DOI\": ..., \"publicationTitle\": ...}", additionalProperties: { type: "string" } },
					creators: CREATORS,
					tags: strArray("Tags"),
					collections: strArray("Collections to file the item in (" + collectionRef + ")"),
					duplicate_force: bool("Create even if an item with the same identifier exists")
				},
				required: ["item_type"]
			},
			annotations: { destructiveHint: false },
			handler: args => ZoteroMCP.Edit.createItem(args)
		},
		{
			name: "add_by_identifier",
			group: "write",
			title: "Add by identifier",
			description: "Zotero's magic wand: look up DOIs, ISBNs, PMIDs or arXiv IDs online and create items (with available attachments). Existing items with the same identifier are only filed into the collections unless duplicate_force is true. Can take several seconds per identifier.",
			inputSchema: {
				type: "object",
				properties: {
					identifiers: strArray("DOIs, ISBNs, PMIDs or arXiv IDs (max 50)"),
					collections: strArray("Collections to file new or existing items in"),
					duplicate_force: bool("Create new items even if the identifier exists"),
					save_attachments: bool("Save attachments the lookup provides (default true)")
				},
				required: ["identifiers"]
			},
			annotations: { destructiveHint: false, openWorldHint: true },
			handler: args => ZoteroMCP.Lookup.addByIdentifier(args)
		},
		{
			name: "update_item",
			group: "write",
			title: "Update item",
			description: "Edit fields, creators (replaces the list), tags or item type. The citation key stays unchanged unless regenerate_citekey is true; then old and new key are reported.",
			inputSchema: {
				type: "object",
				properties: {
					key: str("Item key"),
					fields: { type: "object", description: "Fields to set; empty string clears", additionalProperties: { type: "string" } },
					creators: CREATORS,
					tags: { type: "object", properties: { add: strArray("Tags to add"), remove: strArray("Tags to remove") } },
					item_type: str("New item type"),
					regenerate_citekey: bool("Let Better BibTeX compute a new citation key (default false; breaks \\cite references)")
				},
				required: ["key"]
			},
			annotations: { destructiveHint: false, idempotentHint: true },
			handler: args => ZoteroMCP.Edit.updateItem(args)
		},
		{
			name: "set_citekey",
			group: "write",
			title: "Set citation key",
			description: "Write the citation key (Zotero's citationKey field) of an item. Refuses keys already used unless allow_duplicate.",
			inputSchema: {
				type: "object",
				properties: { key: str("Item key"), citekey: str("New citation key"), allow_duplicate: bool("Allow a key another item already has") },
				required: ["key", "citekey"]
			},
			annotations: { destructiveHint: false, idempotentHint: true },
			handler: args => ZoteroMCP.Edit.setCitekey(args)
		},
		{
			name: "find_pdf",
			group: "write",
			title: "Find available PDF",
			description: "Zotero's Find Available PDF for items with a DOI, URL or PMCID and no PDF/EPUB yet. Downloads and attaches the file when found.",
			inputSchema: {
				type: "object",
				properties: {
					keys: strArray("Item keys (max 50)"),
					methods: strArray("Resolvers to use (default all): doi, url, oa, custom")
				},
				required: ["keys"]
			},
			annotations: { destructiveHint: false, openWorldHint: true },
			handler: args => ZoteroMCP.Lookup.findPDF(args)
		},
		{
			name: "add_to_collections",
			group: "write",
			title: "Add to collections",
			description: "Add top-level items to collections; existing placements are kept (an item can be in several collections).",
			inputSchema: {
				type: "object",
				properties: { items: strArray("Item keys"), collections: strArray(collectionRef + " list") },
				required: ["items", "collections"]
			},
			annotations: { destructiveHint: false, idempotentHint: true },
			handler: args => ZoteroMCP.Edit.addToCollections(args)
		},
		{
			name: "remove_from_collections",
			group: "write",
			title: "Remove from collections",
			description: "Remove items from collections. The items stay in the library (use trash_items to delete).",
			inputSchema: {
				type: "object",
				properties: { items: strArray("Item keys"), collections: strArray(collectionRef + " list") },
				required: ["items", "collections"]
			},
			annotations: { destructiveHint: false, idempotentHint: true },
			handler: args => ZoteroMCP.Edit.removeFromCollections(args)
		},
		{
			name: "move_items",
			group: "write",
			title: "Move items",
			description: "Move items from one collection to another (add to target, remove from source) in one step.",
			inputSchema: {
				type: "object",
				properties: {
					items: strArray("Item keys"),
					from: str("Source " + collectionRef),
					to: strArray("Target collections")
				},
				required: ["items", "from", "to"]
			},
			annotations: { destructiveHint: false },
			handler: args => ZoteroMCP.Edit.moveItems(args)
		},
		{
			name: "create_collection",
			group: "write",
			title: "Create collection",
			description: "Create a collection, optionally under a parent.",
			inputSchema: {
				type: "object",
				properties: { name: str("Name"), parent: str("Parent " + collectionRef + "; omit for top level") },
				required: ["name"]
			},
			annotations: { destructiveHint: false },
			handler: args => ZoteroMCP.Edit.createCollection(args)
		},
		{
			name: "rename_collection",
			group: "write",
			title: "Rename collection",
			description: "Rename a collection.",
			inputSchema: {
				type: "object",
				properties: { collection: str(collectionRef), name: str("New name") },
				required: ["collection", "name"]
			},
			annotations: { destructiveHint: false, idempotentHint: true },
			handler: args => ZoteroMCP.Edit.renameCollection(args)
		},
		{
			name: "move_collection",
			group: "write",
			title: "Move collection",
			description: "Move a collection under another parent, or to the top level when parent is omitted.",
			inputSchema: {
				type: "object",
				properties: { collection: str(collectionRef), parent: str("New parent " + collectionRef + "; omit for top level") },
				required: ["collection"]
			},
			annotations: { destructiveHint: false, idempotentHint: true },
			handler: args => ZoteroMCP.Edit.moveCollection(args)
		},

		// -------------------------------------------------------- two-phase
		{
			name: "apply_library_tree",
			group: "confirm",
			title: "Apply library tree",
			description: "Apply an edited get_library_tree JSON as one confirmed change. Nodes without key are created; same key with new name renames; same key under another parent moves; item keys added to or removed from a collection's items change placements only (never deletes items); {\"copy_of\": key, \"duplicate_force\": true} makes a metadata-only copy, without duplicate_force it is just another placement of the same item; moving a file entry to another item's files re-parents it; \"delete\": true on a node trashes that collection (items kept). A node missing from the tree is an error. The tree's version must still be current. Two-phase: first call previews.",
			inputSchema: {
				type: "object",
				properties: {
					tree: { type: "object", description: "The edited JSON from get_library_tree" },
					confirmation_id: confirmation
				},
				required: ["tree"]
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.LibraryTree.applyTool(args)
		},
		{
			name: "merge_items",
			group: "confirm",
			title: "Merge items",
			description: "Merge duplicates into a master item like Zotero's merge pane: attachments, notes, tags, relations and collections move to the master, the others go to the trash. Field values come from the master unless chosen in fields ({\"title\": {\"from\": \"<key>\"}} or a literal string). Two-phase: first call previews.",
			inputSchema: {
				type: "object",
				properties: {
					master: str("Key of the item to keep"),
					others: strArray("Keys of the items merged into it"),
					fields: { type: "object", description: "Per-field choice: {\"field\": {\"from\": \"<item key>\"}} or {\"field\": \"value\"}" },
					confirmation_id: confirmation
				},
				required: ["master", "others"]
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.Destructive.mergeItems(args)
		},
		{
			name: "trash_items",
			group: "confirm",
			title: "Trash items",
			description: "Move items (with their attachments and notes) to Zotero's trash. Two-phase: first call previews.",
			inputSchema: {
				type: "object",
				properties: { keys: strArray("Item keys"), confirmation_id: confirmation },
				required: ["keys"]
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.Destructive.trashItems(args)
		},
		{
			name: "delete_collection",
			group: "confirm",
			title: "Delete collection",
			description: "Move a collection and its subcollections to the trash. Items stay in the library unless with_items is true. Two-phase: first call previews.",
			inputSchema: {
				type: "object",
				properties: {
					collection: str(collectionRef),
					with_items: bool("Also trash all items in the collection tree (default false)"),
					confirmation_id: confirmation
				},
				required: ["collection"]
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.Destructive.deleteCollection(args)
		},
		{
			name: "set_bbt_settings",
			group: "confirm",
			title: "Set Better BibTeX settings",
			description: "Change allow-listed Better BibTeX preferences (see get_bbt_settings writable_settings). The preview shows old and new values. Two-phase.",
			inputSchema: {
				type: "object",
				properties: {
					settings: { type: "object", description: "{\"citekeyFormat\": \"...\", ...}" },
					confirmation_id: confirmation
				},
				required: ["settings"]
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.BBT.setSettingsTool(args)
		},
		{
			name: "export_files",
			group: "confirm",
			title: "Export files",
			description: "Copy stored attachment files of My Library or a collection into <target_folder>/<folder_name>/, mirroring the collection tree (or flat). Repeated exports to the same place update, move and delete only files this plugin created; copies edited outside Zotero are kept as *_annotated_<date>. Optional Better BibTeX bibliography <folder_name>.bib. Two-phase: first call previews.",
			inputSchema: {
				type: "object",
				properties: {
					target_folder: str("Absolute path of the folder to export into (created if missing)"),
					collection: str(collectionRef + "; default: whole library"),
					folder_name: str("Name of the export folder (default: library or collection name)"),
					structure: str("collections (default) or flat", { enum: ["collections", "flat"] }),
					include_bibliography: bool("Also write <folder_name>.bib via Better BibTeX (includes subcollections)"),
					bibliography_format: str("biblatex (default) or bibtex", { enum: ["biblatex", "bibtex"] }),
					confirmation_id: confirmation
				},
				required: ["target_folder"]
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.FileExport.exportFilesTool(args)
		},
		{
			name: "sync_library_folder",
			group: "confirm",
			title: "Sync library folder",
			description: "Run the global mirror of My Library to the folder configured in Zotero's settings now. Two-phase: first call previews.",
			inputSchema: {
				type: "object",
				properties: { confirmation_id: confirmation }
			},
			annotations: { destructiveHint: true },
			handler: args => ZoteroMCP.FileExport.syncLibraryFolderTool(args)
		}
	];

	const BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
	const DEFAULT_OFF = new Set(["set_bbt_settings", "sync_library_folder"]);
	const GROUP_LABELS = { read: "Read", write: "Write", confirm: "Two-phase (preview, then confirm)" };

	function isEnabled(name) {
		return !!ZoteroMCP.Prefs.get(`tools.${name}`, !DEFAULT_OFF.has(name));
	}

	function typeOf(value) {
		if (Array.isArray(value)) {
			return "array";
		}
		if (value === null) {
			return "null";
		}
		if (typeof value === "number") {
			return Number.isInteger(value) ? "integer" : "number";
		}
		return typeof value;
	}

	function validate(tool, args) {
		const schema = tool.inputSchema;
		const props = schema.properties || {};
		const errors = [];
		for (const name of schema.required || []) {
			if (args[name] === undefined || args[name] === null || args[name] === "") {
				errors.push(`missing required argument '${name}'`);
			}
		}
		for (const [name, value] of Object.entries(args)) {
			if (name === "library_id") {
				continue;
			}
			const prop = props[name];
			if (!prop) {
				errors.push(`unknown argument '${name}' (allowed: ${Object.keys(props).join(", ") || "none"})`);
				continue;
			}
			if (value === null || value === undefined) {
				continue;
			}
			const actual = typeOf(value);
			const expected = prop.type;
			const ok = expected === actual
				|| (expected === "number" && actual === "integer")
				|| (expected === "integer" && actual === "number" && Number.isInteger(value));
			// Lenient: a single string where an array of strings is expected
			if (!ok && expected === "array" && actual === "string") {
				args[name] = [value];
				continue;
			}
			if (!ok) {
				errors.push(`'${name}' must be ${expected}, got ${actual}`);
				continue;
			}
			if (prop.enum && !prop.enum.includes(value)) {
				errors.push(`'${name}' must be one of ${prop.enum.join(", ")}`);
			}
		}
		if (errors.length) {
			throw new ToolError(`Invalid arguments for ${tool.name}: ${errors.join("; ")}`);
		}
	}

	function textResult(value, isError) {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return { content: [{ type: "text", text }], isError: !!isError };
	}

	return {
		GROUP_LABELS,
		DEFAULT_OFF,

		all() {
			return TOOLS;
		},

		exists(name) {
			return BY_NAME.has(name);
		},

		isEnabled,

		setEnabled(name, enabled) {
			ZoteroMCP.Prefs.set(`tools.${name}`, !!enabled);
		},

		list() {
			return TOOLS.filter(tool => isEnabled(tool.name)).map((tool) => {
				const annotations = Object.assign({ title: tool.title, readOnlyHint: false, openWorldHint: false }, tool.annotations);
				return {
					name: tool.name,
					title: tool.title,
					description: tool.description,
					inputSchema: tool.inputSchema,
					annotations
				};
			});
		},

		async call(name, args) {
			const tool = BY_NAME.get(name);
			if (!isEnabled(name)) {
				return textResult(`Tool \`${name}\` has been disabled by the user in Zotero settings`, true);
			}
			const started = Date.now();
			try {
				args = Object.assign({}, args);
				validate(tool, args);
				if (args.library_id !== undefined) {
					Lib.assertUserLibrary(args);
					delete args.library_id;
				}
				const result = await tool.handler(args);
				ZoteroMCP.log(`tool ${name} done in ${Date.now() - started} ms`);
				return textResult(result, false);
			}
			catch (e) {
				if (e instanceof ToolError) {
					return textResult(e.data ? { error: e.message, details: e.data } : e.message, true);
				}
				ZoteroMCP.logError(e);
				return textResult(`Internal error in ${name}: ${e.message}`, true);
			}
		}
	};
})();
