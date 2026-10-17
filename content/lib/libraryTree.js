/* global Zotero, ZoteroMCP */

// get_library_tree returns collections, item placements and stored files in one
// editable document; apply_library_tree applies an edited copy as one confirmed change.
ZoteroMCP.LibraryTree = (function () {
	const { ToolError, Lib, Util, Audit, Confirm } = ZoteroMCP;

	// --------------------------------------------------------------- build

	/**
	 * @param {Zotero.Collection|null} scope - null for the whole library
	 * @param {Object} [options]
	 * @param {Boolean} [options.stat] - Include file size/existence
	 */
	async function build(scope, { stat = true } = {}) {
		const items = new Map(); // key -> Zotero.Item
		const stats = { collections: 0, placements: 0, files: 0 };

		function nodeFor(collection) {
			stats.collections++;
			const memberItems = collection.getChildItems(false, false).filter(item => item.isTopLevelItem());
			memberItems.forEach(item => items.set(item.key, item));
			stats.placements += memberItems.length;
			return {
				key: collection.key,
				name: collection.name,
				items: memberItems.map(item => item.key).sort(),
				collections: Lib.childCollections(collection).map(nodeFor)
			};
		}

		let collections;
		let unfiled;
		if (scope) {
			collections = [nodeFor(scope)];
		}
		else {
			collections = Lib.childCollections(null).map(nodeFor);
			unfiled = [];
			for (const item of await Lib.getAllTopLevelItems()) {
				if (!item.getCollections().length) {
					items.set(item.key, item);
					unfiled.push(item.key);
				}
			}
			unfiled.sort();
			stats.placements += unfiled.length;
		}

		const itemMap = {};
		for (const key of [...items.keys()].sort()) {
			const item = items.get(key);
			const files = [];
			for (const attachment of Lib.storedFiles(item)) {
				files.push(await Lib.fileInfo(attachment, { stat }));
			}
			stats.files += files.length;
			itemMap[key] = {
				citekey: item.isRegularItem() ? (Lib.citekey(item) || undefined) : undefined,
				type: item.itemType,
				creator: Lib.firstCreator(item) || undefined,
				year: Lib.year(item) || undefined,
				title: Util.truncate(Lib.itemTitle(item), 120),
				files
			};
		}

		const tree = {
			scope: scope
				? { collection: scope.key, path: Lib.collectionPath(scope) }
				: { collection: null, library: Lib.libraryName() },
			version: null,
			collections
		};
		if (unfiled) {
			tree.unfiled = unfiled;
		}
		tree.items = itemMap;
		tree.version = fingerprint(tree);
		return { tree, stats };
	}

	// Structural fingerprint: collections, placements and files only, so metadata
	// edits (including Better BibTeX filling citekeys) do not invalidate a tree
	function fingerprint(tree) {
		const parts = [];
		const walk = (nodes, parent) => {
			for (const node of nodes) {
				parts.push(["c", node.key, node.name, parent, [...node.items].sort()]);
				walk(node.collections, node.key);
			}
		};
		walk(tree.collections, tree.scope.collection);
		parts.push(["u", tree.unfiled || null]);
		for (const key of Object.keys(tree.items).sort()) {
			parts.push(["i", key, tree.items[key].files.map(f => f.key).sort()]);
		}
		return "t1-" + Util.sha256Hex(Util.stableStringify(parts)).slice(0, 20);
	}

	function countsOnly(collection) {
		return {
			key: collection.key,
			name: collection.name,
			item_count: Lib.collectionItems(collection, false).length,
			subtree_item_count: Lib.collectionItems(collection, true).length,
			collections: Lib.childCollections(collection).map(countsOnly)
		};
	}

	function renderText(tree) {
		const lines = [];
		const scopeLabel = tree.scope.collection ? `Collection ${tree.scope.path} [${tree.scope.collection}]` : tree.scope.library;
		lines.push(`${scopeLabel}  (version ${tree.version})`);
		const itemLine = (key, indent) => {
			const info = tree.items[key] || {};
			const meta = [info.creator, info.year].filter(Boolean).join(" ");
			const files = info.files && info.files.length ? `  [${info.files.length} file${info.files.length > 1 ? "s" : ""}: ${info.files.map(f => f.key).join(", ")}]` : "";
			lines.push(`${indent}- ${key}${info.citekey ? " @" + info.citekey : ""} ${meta ? meta + " — " : ""}${info.title || ""}${files}`);
		};
		const walk = (nodes, indent) => {
			for (const node of nodes) {
				lines.push(`${indent}${node.name} [${node.key}] (${node.items.length} item${node.items.length === 1 ? "" : "s"})`);
				node.items.forEach(key => itemLine(key, indent + "    "));
				walk(node.collections, indent + "  ");
			}
		};
		walk(tree.collections, "  ");
		if (tree.unfiled) {
			lines.push(`  (unfiled) (${tree.unfiled.length} items)`);
			tree.unfiled.forEach(key => itemLine(key, "      "));
		}
		lines.push("", "Read-only outline. Use format \"json\" to get a tree that apply_library_tree accepts.");
		return lines.join("\n");
	}

	async function getTool(args) {
		Lib.assertUserLibrary(args);
		const scope = args.collection ? Lib.resolveCollection(args.collection) : null;
		const format = args.format || "json";
		if (!["json", "text"].includes(format)) {
			throw new ToolError("format must be json or text");
		}
		const limit = parseInt(ZoteroMCP.Prefs.get("tree.nodeLimit", 5000)) || 0;
		const { tree, stats } = await build(scope, { stat: format === "json" });
		const nodes = stats.collections + stats.placements + stats.files;
		if (limit > 0 && nodes > limit && !args.ignore_limit) {
			const roots = scope ? [scope] : Lib.childCollections(null);
			return {
				partial: true,
				message: `The tree has ${nodes} nodes, above the limit of ${limit} set in Zotero settings. Only collections with counts are returned; request a subtree with collection=<key>, or ask the user to raise the limit.`,
				scope: tree.scope,
				version: tree.version,
				collections: roots.map(countsOnly),
				unfiled_count: tree.unfiled ? tree.unfiled.length : undefined,
				nodes
			};
		}
		return format === "text" ? renderText(tree) : tree;
	}

	// --------------------------------------------------------------- apply

	function normalizeItemEntry(entry, where, errors) {
		if (typeof entry === "string") {
			return { key: entry };
		}
		if (entry && typeof entry === "object" && typeof entry.copy_of === "string") {
			return { copyOf: entry.copy_of, force: entry.duplicate_force === true };
		}
		errors.push(`${where}: item entries must be keys or {"copy_of": "<key>", "duplicate_force": true}`);
		return null;
	}

	async function plan(args) {
		const desired = args.tree;
		if (!desired || typeof desired !== "object" || !Array.isArray(desired.collections)) {
			throw new ToolError("tree must be the JSON object returned by get_library_tree (format json)");
		}
		if (desired.partial) {
			throw new ToolError("A partial (size-limited) tree cannot be applied; request a smaller subtree");
		}
		const scopeKey = desired.scope && desired.scope.collection ? desired.scope.collection : null;
		const scope = scopeKey ? Lib.resolveCollection(scopeKey) : null;
		const { tree: current } = await build(scope, { stat: false });
		if (desired.version !== current.version) {
			throw new ToolError(`The tree is out of date (read as ${desired.version}, library is now at ${current.version}). Call get_library_tree again and re-apply your edits.`);
		}

		const errors = [];
		const libraryID = Lib.libraryID();

		// Current state, indexed
		const currentNodes = new Map(); // key -> {name, parent, items:Set}
		const walkCurrent = (nodes, parent) => {
			for (const node of nodes) {
				currentNodes.set(node.key, { name: node.name, parent, items: new Set(node.items), children: node.collections.map(c => c.key) });
				walkCurrent(node.collections, node.key);
			}
		};
		walkCurrent(current.collections, scopeKey);

		// Desired state, indexed
		const desiredNodes = new Map(); // key or temp id -> {...}
		const newNodes = [];
		const deleted = [];
		let tempCounter = 0;
		const walkDesired = (nodes, parent, where, depth) => {
			if (!Array.isArray(nodes)) {
				errors.push(`${where}: collections must be an array`);
				return;
			}
			for (const [i, node] of nodes.entries()) {
				const path = `${where}[${i}]`;
				if (!node || typeof node !== "object") {
					errors.push(`${path}: must be an object`);
					continue;
				}
				let id;
				if (node.key) {
					id = node.key;
					if (desiredNodes.has(id)) {
						errors.push(`${path}: collection ${id} appears twice`);
						continue;
					}
					if (!currentNodes.has(id)) {
						const exists = Zotero.Collections.getByLibraryAndKey(libraryID, id);
						errors.push(`${path}: collection ${id} ${exists ? "is outside this tree's scope" : "does not exist"}`);
						continue;
					}
				}
				else {
					if (node.delete) {
						errors.push(`${path}: a new collection cannot be deleted`);
						continue;
					}
					id = `new${++tempCounter}`;
					newNodes.push(id);
				}
				const name = typeof node.name === "string" ? node.name.trim() : "";
				if (!name && !node.delete) {
					errors.push(`${path}: name must not be empty`);
				}
				const entries = [];
				for (const [j, entry] of (node.items || []).entries()) {
					const normalized = normalizeItemEntry(entry, `${path}.items[${j}]`, errors);
					if (normalized) {
						entries.push(normalized);
					}
				}
				desiredNodes.set(id, { id, isNew: !node.key, name, parent, entries, delete: !!node.delete, depth, where: path });
				if (node.delete) {
					deleted.push(id);
				}
				walkDesired(node.collections || [], id, `${path}.collections`, depth + 1);
			}
		};
		walkDesired(desired.collections, scopeKey, "collections", 0);

		if (scope) {
			const rootNodes = desired.collections.filter(n => n && n.key === scope.key);
			if (desired.collections.length !== 1 || rootNodes.length !== 1) {
				errors.push(`collections must contain exactly the scope collection ${scope.key} at the top`);
			}
			else if (rootNodes[0].delete) {
				errors.push("The scope collection cannot be deleted through its own tree; use delete_collection");
			}
		}

		for (const key of currentNodes.keys()) {
			if (!desiredNodes.has(key)) {
				errors.push(`Collection ${key} (${currentNodes.get(key).name}) is missing from the tree. Removing a node does not delete it; keep it, or set "delete": true on it.`);
			}
		}

		// Items
		const itemCache = new Map();
		const getItem = (key, where) => {
			if (itemCache.has(key)) {
				return itemCache.get(key);
			}
			let item = null;
			try {
				item = Lib.getItem(key);
				if (!item.isTopLevelItem()) {
					errors.push(`${where}: ${key} is a child item and cannot be placed in a collection`);
					item = null;
				}
			}
			catch (e) {
				errors.push(`${where}: ${e.message}`);
			}
			itemCache.set(key, item);
			return item;
		};

		const changes = {
			create_collections: [],
			rename_collections: [],
			move_collections: [],
			delete_collections: [],
			add_items: [],
			remove_items: [],
			copies: [],
			linked_instead_of_copy: [],
			move_files: [],
			warnings: []
		};

		const isDeletedSubtree = (id) => {
			let current = desiredNodes.get(id);
			const seen = new Set();
			while (current && !seen.has(current.id)) {
				if (current.delete) {
					return true;
				}
				seen.add(current.id);
				current = desiredNodes.get(current.parent);
			}
			return false;
		};

		const describe = id => (desiredNodes.get(id) ? `${desiredNodes.get(id).name} [${desiredNodes.get(id).isNew ? "new" : id}]` : (id || Lib.libraryName()));

		// Final membership per surviving collection
		const finalMembers = new Map(); // collection id -> Set(item keys)
		for (const node of desiredNodes.values()) {
			if (isDeletedSubtree(node.id)) {
				continue;
			}
			const members = new Set();
			for (const entry of node.entries) {
				if (entry.key) {
					if (getItem(entry.key, node.where)) {
						members.add(entry.key);
					}
				}
				else if (getItem(entry.copyOf, node.where)) {
					if (entry.force) {
						changes.copies.push({ copy_of: entry.copyOf, collection: node.id, collection_label: describe(node.id) });
					}
					else {
						members.add(entry.copyOf);
						changes.linked_instead_of_copy.push({ item: entry.copyOf, collection: describe(node.id), note: "No duplicate_force: placed as a link to the same item, not a copy" });
					}
				}
			}
			finalMembers.set(node.id, members);
		}

		// Collection structure changes
		for (const node of desiredNodes.values()) {
			if (node.isNew) {
				if (!isDeletedSubtree(node.id)) {
					changes.create_collections.push({ id: node.id, name: node.name, parent: node.parent, parent_label: describe(node.parent) });
				}
				continue;
			}
			const cur = currentNodes.get(node.id);
			if (node.delete) {
				if (!isDeletedSubtree(node.parent)) {
					changes.delete_collections.push({ key: node.id, name: cur.name });
				}
				continue;
			}
			if (isDeletedSubtree(node.id)) {
				continue;
			}
			if (node.name && node.name !== cur.name) {
				changes.rename_collections.push({ key: node.id, from: cur.name, to: node.name });
			}
			if (node.parent !== cur.parent) {
				changes.move_collections.push({ key: node.id, name: node.name, from: describe(cur.parent), to: describe(node.parent), parent: node.parent });
			}
			const members = finalMembers.get(node.id);
			for (const key of members) {
				if (!cur.items.has(key)) {
					changes.add_items.push({ item: key, collection: node.id, collection_label: describe(node.id) });
				}
			}
			for (const key of cur.items) {
				if (!members.has(key)) {
					changes.remove_items.push({ item: key, collection: node.id, collection_label: describe(node.id) });
				}
			}
		}
		for (const node of desiredNodes.values()) {
			if (node.isNew && !isDeletedSubtree(node.id)) {
				for (const key of finalMembers.get(node.id)) {
					changes.add_items.push({ item: key, collection: node.id, collection_label: describe(node.id) });
				}
			}
		}

		// Files moved between items (re-parenting attachments)
		const desiredItems = desired.items && typeof desired.items === "object" ? desired.items : {};
		const fileOwner = new Map();
		for (const [itemKey, entry] of Object.entries(desiredItems)) {
			for (const file of (entry && entry.files) || []) {
				const fileKey = typeof file === "string" ? file : file && file.key;
				if (!fileKey) {
					continue;
				}
				if (fileOwner.has(fileKey)) {
					errors.push(`File ${fileKey} is listed under both ${fileOwner.get(fileKey)} and ${itemKey}`);
					continue;
				}
				fileOwner.set(fileKey, itemKey);
			}
		}
		for (const [itemKey, info] of Object.entries(current.items)) {
			if (!(itemKey in desiredItems)) {
				continue;
			}
			for (const file of info.files) {
				const owner = fileOwner.get(file.key);
				if (!owner) {
					errors.push(`File ${file.key} (${file.name}) was removed from item ${itemKey} without being placed under another item; files cannot be deleted through the tree`);
				}
				else if (owner !== itemKey) {
					const target = getItem(owner, `items.${owner}`);
					if (target && !target.isRegularItem()) {
						errors.push(`File ${file.key} can only move to a regular item, not to ${owner} (${target.itemType})`);
					}
					else if (target) {
						changes.move_files.push({ file: file.key, name: file.name, from: itemKey, to: owner });
					}
				}
			}
		}
		for (const [fileKey, owner] of fileOwner) {
			const known = Object.values(current.items).some(info => info.files.some(f => f.key === fileKey));
			if (!known) {
				let attachment = null;
				try {
					attachment = Lib.getItem(fileKey, { label: "File" });
				}
				catch (e) {
					errors.push(`items.${owner}.files: ${e.message}`);
					continue;
				}
				if (!Lib.isStoredFile(attachment)) {
					errors.push(`items.${owner}.files: ${fileKey} is not a stored file attachment`);
				}
				else if (attachment.parentKey !== owner && attachment.key !== owner) {
					errors.push(`items.${owner}.files: file ${fileKey} belongs to an item outside this tree; read a tree that contains both items`);
				}
			}
		}

		if (errors.length) {
			throw new ToolError(`The tree has ${errors.length} problem${errors.length > 1 ? "s" : ""}; nothing was changed.`, { errors });
		}

		// Warnings: items left in no collection, conflicting identifiers in one collection
		if (!scope) {
			const placedAnywhere = new Set();
			for (const members of finalMembers.values()) {
				members.forEach(key => placedAnywhere.add(key));
			}
			for (const removal of changes.remove_items) {
				if (!placedAnywhere.has(removal.item)) {
					changes.warnings.push(`${removal.item} ends up in no collection (unfiled)`);
				}
			}
		}
		// Only collections gaining items are checked: duplicates already sitting together are
		// find_duplicates' business, not a consequence of this change
		const gaining = new Map(); // collection id -> Set of added item keys
		for (const add of changes.add_items) {
			if (!gaining.has(add.collection)) {
				gaining.set(add.collection, new Set());
			}
			gaining.get(add.collection).add(add.item);
		}
		for (const [id, added] of gaining) {
			const byIdentifier = new Map();
			const pairs = new Map(); // "a|b" -> shared identifiers
			for (const key of finalMembers.get(id) || []) {
				const item = itemCache.get(key) || Lib.getItem(key);
				if (!item.isRegularItem()) {
					continue;
				}
				const ids = Lib.identifiersOf(item);
				for (const value of [...ids.doi.map(v => "doi:" + v), ...ids.isbn.map(v => "isbn:" + v), ...ids.arxiv.map(v => "arxiv:" + v)]) {
					const other = byIdentifier.get(value);
					if (other && other !== key && (added.has(key) || added.has(other))) {
						const pair = [other, key].sort().join("|");
						pairs.set(pair, [...(pairs.get(pair) || []), value]);
					}
					else if (!other) {
						byIdentifier.set(value, key);
					}
				}
			}
			for (const [pair, values] of pairs) {
				const [a, b] = pair.split("|");
				changes.warnings.push(`${describe(id)} would hold two different items with ${[...new Set(values)].join(", ")} (${a} and ${b}); consider merge_items`);
			}
		}
		for (const move of changes.move_files) {
			const attachment = Lib.getItem(move.file);
			if (attachment.isTopLevelItem()) {
				changes.warnings.push(`Standalone file ${move.file} becomes a child of ${move.to} and leaves its collections`);
			}
		}

		const total = changes.create_collections.length + changes.rename_collections.length + changes.move_collections.length
			+ changes.delete_collections.length + changes.add_items.length + changes.remove_items.length
			+ changes.copies.length + changes.move_files.length;
		return { scope, desiredNodes, changes, total };
	}

	function previewFrom(planned) {
		const { changes, total } = planned;
		const preview = { total_changes: total };
		for (const [name, list] of Object.entries(changes)) {
			if (list.length) {
				preview[name] = list;
			}
		}
		if (!total) {
			preview.note = "The tree matches the library; nothing to apply.";
		}
		return preview;
	}

	// Moves collections without ever creating a cycle along the way. Each save is its own
	// transaction: Zotero refreshes its parent/child caches only on commit.
	async function applyMoves(moves, resolve, fallbackParentKey) {
		let pending = moves.slice();
		while (pending.length) {
			const next = [];
			for (const move of pending) {
				const collection = Zotero.Collections.getByLibraryAndKey(Lib.libraryID(), move.key);
				const parentKey = resolve(move.parent);
				const parent = parentKey ? Zotero.Collections.getByLibraryAndKey(Lib.libraryID(), parentKey) : null;
				if (parent && Lib.isAncestorOrSelf(collection, parent)) {
					next.push(move);
					continue;
				}
				collection.parentKey = parentKey || false;
				await collection.saveTx();
			}
			if (next.length === pending.length) {
				// Every remaining move is blocked: park one at the scope root to break the chain
				const collection = Zotero.Collections.getByLibraryAndKey(Lib.libraryID(), next[0].key);
				collection.parentKey = fallbackParentKey || false;
				await collection.saveTx();
			}
			pending = next;
		}
	}

	async function execute(planned) {
		const { scope, changes } = planned;
		const libraryID = Lib.libraryID();
		const keyFor = new Map(); // temp id -> new collection key
		const resolve = id => (id === null || id === undefined ? null : (keyFor.get(id) || id));
		const done = { created_collections: [], copies: [], completed_steps: [] };
		let step = "create collections";

		try {
			// 1. Collection structure, parents before children (creation order follows the tree walk)
			for (const create of changes.create_collections) {
				const collection = new Zotero.Collection({ libraryID, name: create.name });
				const parentKey = resolve(create.parent);
				if (parentKey) {
					collection.parentKey = parentKey;
				}
				await collection.saveTx();
				keyFor.set(create.id, collection.key);
				done.created_collections.push({ key: collection.key, name: create.name });
			}
			done.completed_steps.push(step);

			step = "rename collections";
			for (const rename of changes.rename_collections) {
				const collection = Zotero.Collections.getByLibraryAndKey(libraryID, rename.key);
				collection.name = rename.to;
				await collection.saveTx();
			}
			done.completed_steps.push(step);

			step = "move collections";
			await applyMoves(changes.move_collections, resolve, scope ? scope.key : null);
			done.completed_steps.push(step);

			// 2. Item placements, copies and file moves in one transaction
			step = "item placements, copies and file moves";
			await Zotero.DB.executeTransaction(async () => {
				const byItem = new Map();
				const touch = (key) => {
					if (!byItem.has(key)) {
						byItem.set(key, Lib.getItem(key));
					}
					return byItem.get(key);
				};
				for (const add of changes.add_items) {
					const collection = Zotero.Collections.getByLibraryAndKey(libraryID, resolve(add.collection));
					touch(add.item).addToCollection(collection.id);
				}
				for (const remove of changes.remove_items) {
					const collection = Zotero.Collections.getByLibraryAndKey(libraryID, resolve(remove.collection));
					touch(remove.item).removeFromCollection(collection.id);
				}
				for (const item of byItem.values()) {
					if (item.hasChanged()) {
						await item.save();
					}
				}

				// Forced copies behave like Zotero's Duplicate Item: metadata only, own citekey
				for (const copy of changes.copies) {
					const original = Lib.getItem(copy.copy_of);
					const clone = original.clone();
					try {
						clone.setField("citationKey", "");
					}
					catch (e) {
						// Item types without the field
					}
					const collection = Zotero.Collections.getByLibraryAndKey(libraryID, resolve(copy.collection));
					clone.setCollections([collection.id]);
					await clone.save();
					done.copies.push({ copy_of: original.key, key: clone.key, collection: collection.key });
				}

				for (const move of changes.move_files) {
					const attachment = Lib.getItem(move.file);
					if (attachment.isTopLevelItem() && attachment.getCollections().length) {
						attachment.setCollections([]);
					}
					attachment.parentKey = move.to;
					await attachment.save();
				}
			});
			done.completed_steps.push(step);

			// 3. Collections to the trash, last, after their surviving children moved out
			step = "delete collections";
			for (const del of changes.delete_collections) {
				const collection = Zotero.Collections.getByLibraryAndKey(libraryID, del.key);
				collection.deleted = true;
				await collection.saveTx({ deleteItems: false });
			}
			done.completed_steps.push(step);
		}
		catch (e) {
			ZoteroMCP.logError(e);
			throw new ToolError(`Applying the tree stopped at "${step}": ${e.message}. Earlier steps were applied; read the tree again before retrying.`, done);
		}
		delete done.completed_steps;
		return done;
	}

	async function applyTool(args) {
		Lib.assertUserLibrary(args);
		return Confirm.run("apply_library_tree", args, {
			preview: async a => previewFrom(await plan(a)),
			execute: async (a) => {
				const planned = await plan(a);
				if (!planned.total) {
					return { applied: 0 };
				}
				const done = await execute(planned);
				const result = Object.assign({ applied: planned.total }, done);
				await Audit.record("apply_library_tree", { changes: planned.changes, result: done });
				const { tree } = await build(planned.scope, { stat: false });
				result.new_version = tree.version;
				return result;
			}
		});
	}

	return { build, fingerprint, getTool, applyTool, renderText };
})();
