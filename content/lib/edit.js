/* global Zotero, ZoteroMCP */

// Single-step write tools: item metadata, citekeys, collection membership and collections.
// Removing from a collection never deletes; citekeys change only on explicit request.
ZoteroMCP.Edit = (function () {
	const { ToolError, Lib, Audit } = ZoteroMCP;

	const CITEKEY_WARNING = "The citation key changed: existing \\cite{} references to the old key will break.";

	// ------------------------------------------------------------- helpers

	function itemTypeID(type) {
		const id = Zotero.ItemTypes.getID(type);
		if (!id || ["attachment", "note", "annotation"].includes(type)) {
			throw new ToolError(`Unknown or unsupported item type '${type}'. Examples: journalArticle, book, bookSection, conferencePaper, thesis, report, preprint, webpage.`);
		}
		return id;
	}

	function validFieldsFor(item) {
		return Zotero.ItemFields.getItemTypeFields(item.itemTypeID).map(id => Zotero.ItemFields.getName(id));
	}

	/**
	 * @return {Object[]} notes on date values that were rewritten (see ZoteroMCP.Dates)
	 */
	function applyFields(item, fields) {
		const errors = [];
		const dateNotes = [];
		for (const [field, value] of Object.entries(fields || {})) {
			if (field === "citationKey") {
				errors.push("citationKey cannot be set here; use set_citekey (or regenerate_citekey on update_item)");
				continue;
			}
			const fieldID = Zotero.ItemFields.getID(field);
			const mapped = fieldID && Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, fieldID);
			if (!fieldID || (!Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID) && !mapped)) {
				errors.push(`'${field}' is not a field of ${item.itemType}`);
				continue;
			}
			let text = value === null || value === undefined ? "" : String(value);
			if (field === "accessDate") {
				text = ZoteroMCP.Dates.forAccessDate(text);
			}
			else if (ZoteroMCP.Dates.isDateField(field)) {
				const { value: stored, note } = ZoteroMCP.Dates.forDateField(field, text);
				text = stored;
				if (note) {
					dateNotes.push(note);
				}
			}
			try {
				item.setField(field, text);
			}
			catch (e) {
				errors.push(`${field}: ${e.message}`);
			}
		}
		if (errors.length) {
			throw new ToolError(errors.join("; "), { valid_fields: validFieldsFor(item) });
		}
		return dateNotes;
	}

	function normalizeCreators(creators) {
		if (!Array.isArray(creators)) {
			throw new ToolError("creators must be an array of {creatorType, firstName, lastName} or {creatorType, name}");
		}
		return creators.map((c, i) => {
			if (!c || typeof c !== "object") {
				throw new ToolError(`creators[${i}] must be an object`);
			}
			const creatorType = c.creatorType || "author";
			if (!Zotero.CreatorTypes.getID(creatorType)) {
				throw new ToolError(`creators[${i}]: unknown creatorType '${creatorType}'`);
			}
			if (c.name) {
				return { creatorType, name: String(c.name) };
			}
			if (!c.lastName) {
				throw new ToolError(`creators[${i}] needs lastName (and firstName) or name`);
			}
			return { creatorType, firstName: String(c.firstName || ""), lastName: String(c.lastName) };
		});
	}

	function snapshot(item) {
		const json = item.toJSON();
		delete json.version;
		delete json.dateModified;
		return json;
	}

	function diff(before, after) {
		const changes = {};
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const key of keys) {
			const a = JSON.stringify(before[key]);
			const b = JSON.stringify(after[key]);
			if (a !== b) {
				changes[key] = {
					before: before[key] === undefined ? null : before[key],
					after: after[key] === undefined ? null : after[key]
				};
			}
		}
		return changes;
	}

	function topLevel(items) {
		const bad = items.filter(item => !item.isTopLevelItem());
		if (bad.length) {
			throw new ToolError(`Child items cannot be placed in collections: ${bad.map(i => `${i.key} (child of ${i.parentKey})`).join(", ")}`);
		}
		return items;
	}

	async function citekeyAfterBBT(item, wait = 3000) {
		// BBT fills keys for new items shortly after saving
		const end = Date.now() + wait;
		while (Date.now() < end) {
			const key = Lib.citekey(item);
			if (key) {
				return key;
			}
			await Zotero.Promise.delay(250);
		}
		return Lib.citekey(item) || null;
	}

	async function fileIntoCollections(item, collections) {
		const added = [];
		await Zotero.DB.executeTransaction(async () => {
			for (const collection of collections) {
				if (!item.inCollection(collection.id)) {
					item.addToCollection(collection.id);
					added.push(Lib.collectionPath(collection));
				}
			}
			if (added.length) {
				await item.save();
			}
		});
		return added;
	}

	// ----------------------------------------------------------- item tools

	// Inserts run one at a time, so parallel calls cannot both pass the duplicate check
	const insertMutex = ZoteroMCP.Util.createMutex();

	function createItem(args) {
		return insertMutex.run(() => createItemNow(args));
	}

	async function createItemNow(args) {
		Lib.assertUserLibrary(args);
		const typeID = itemTypeID(args.item_type);
		const fields = Object.assign({}, args.fields || {});
		const collections = Lib.resolveCollections(args.collections || []);

		const existing = await Lib.findDuplicates({ itemType: args.item_type, fields, creators: args.creators });
		if (existing.length && !args.duplicate_force) {
			const { item, matchedBy } = existing[0];
			const added = await fileIntoCollections(item, collections);
			if (added.length) {
				await Audit.record("create_item", { action: "filed_existing", keys: [item.key], added_to: added });
			}
			return {
				status: "existing",
				message: "This work is already in the library (same identifier, or same title, first author and year); it was filed into the requested collections instead of creating a duplicate. Pass duplicate_force: true to create a new item anyway.",
				matched_by: matchedBy,
				item: Lib.itemSummary(item),
				added_to_collections: added,
				other_matches: existing.slice(1).map(m => m.item.key)
			};
		}

		const item = new Zotero.Item(typeID);
		item.libraryID = Lib.libraryID();
		const dates = applyFields(item, fields);
		if (args.creators) {
			item.setCreators(normalizeCreators(args.creators));
		}
		for (const tag of args.tags || []) {
			item.addTag(String(tag));
		}
		if (collections.length) {
			item.setCollections(collections.map(c => c.id));
		}
		await item.saveTx();
		const citekey = await citekeyAfterBBT(item);
		await Audit.record("create_item", { action: "created", keys: [item.key], after: snapshot(item) });
		return {
			status: "created",
			item: Object.assign(Lib.itemSummary(item), { citekey: citekey || undefined }),
			dates: dates.length ? dates : undefined,
			duplicates_ignored: existing.length ? existing.map(m => ({ key: m.item.key, matched_by: m.matchedBy })) : undefined
		};
	}

	async function updateItem(args) {
		Lib.assertUserLibrary(args);
		const item = Lib.getItem(args.key);
		if (!item.isRegularItem() && args.creators) {
			throw new ToolError("Only regular items have creators");
		}
		const before = snapshot(item);
		const oldCitekey = Lib.citekey(item);

		if (args.item_type && args.item_type !== item.itemType) {
			item.setType(itemTypeID(args.item_type));
		}
		const dates = applyFields(item, args.fields);
		if (args.creators) {
			item.setCreators(normalizeCreators(args.creators));
		}
		if (args.tags) {
			for (const tag of args.tags.add || []) {
				item.addTag(String(tag));
			}
			for (const tag of args.tags.remove || []) {
				item.removeTag(String(tag));
			}
		}
		if (!item.hasChanged() && !args.regenerate_citekey) {
			return { status: "unchanged", item: Lib.itemSummary(item) };
		}
		if (item.hasChanged()) {
			await item.saveTx();
		}

		const result = { status: "updated", item: Lib.itemSummary(item), dates: dates.length ? dates : undefined };
		const after = snapshot(item);
		result.changes = diff(before, after);

		if (args.regenerate_citekey) {
			if (!oldCitekey) {
				result.citekey_warning = "Item had no citation key to regenerate yet";
			}
			else {
				const mapping = await ZoteroMCP.BBT.regenerateKeys([oldCitekey]);
				const newCitekey = mapping[oldCitekey] || Lib.citekey(item);
				result.citekey = { old: oldCitekey, new: newCitekey };
				if (newCitekey !== oldCitekey) {
					result.citekey_warning = CITEKEY_WARNING;
				}
			}
		}
		await Audit.record("update_item", { keys: [item.key], changes: result.changes, citekey: result.citekey });
		return result;
	}

	async function setCitekey(args) {
		Lib.assertUserLibrary(args);
		const item = Lib.getItem(args.key);
		if (!item.isRegularItem()) {
			throw new ToolError("Only regular items have citation keys");
		}
		const citekey = String(args.citekey || "").trim();
		if (!citekey || /\s/.test(citekey)) {
			throw new ToolError("citekey must be a non-empty string without spaces");
		}
		const old = Lib.citekey(item);
		if (old === citekey) {
			return { status: "unchanged", citekey };
		}
		const search = new Zotero.Search();
		search.libraryID = Lib.libraryID();
		search.addCondition("citationKey", "is", citekey);
		const clashes = Zotero.Items.get(await search.search()).filter(other => other.id !== item.id && !other.deleted);
		if (clashes.length && !args.allow_duplicate) {
			throw new ToolError(`Citation key '${citekey}' is already used by ${clashes.map(c => c.key).join(", ")}. Pass allow_duplicate: true to set it anyway.`);
		}
		item.setField("citationKey", citekey);
		await item.saveTx();
		await Audit.record("set_citekey", { keys: [item.key], before: old, after: citekey });
		return { status: "updated", key: item.key, citekey: { old, new: citekey }, warning: old ? CITEKEY_WARNING : undefined };
	}

	// ------------------------------------------------- collection membership

	async function addToCollections(args) {
		Lib.assertUserLibrary(args);
		const items = topLevel(Lib.getItems(args.items));
		const collections = Lib.resolveCollections(args.collections);
		if (!collections.length) {
			throw new ToolError("Provide at least one collection");
		}
		const results = [];
		await Zotero.DB.executeTransaction(async () => {
			for (const item of items) {
				const added = collections.filter(c => !item.inCollection(c.id));
				for (const collection of added) {
					item.addToCollection(collection.id);
				}
				if (added.length) {
					await item.save();
				}
				results.push({ key: item.key, added_to: added.map(Lib.collectionPath), already_in: collections.filter(c => !added.includes(c)).map(Lib.collectionPath) });
			}
		});
		await Audit.record("add_to_collections", { keys: items.map(i => i.key), collections: collections.map(c => c.key), results });
		return { results };
	}

	async function removeFromCollections(args) {
		Lib.assertUserLibrary(args);
		const items = topLevel(Lib.getItems(args.items));
		const collections = Lib.resolveCollections(args.collections);
		if (!collections.length) {
			throw new ToolError("Provide at least one collection");
		}
		const results = [];
		await Zotero.DB.executeTransaction(async () => {
			for (const item of items) {
				const removed = collections.filter(c => item.inCollection(c.id));
				for (const collection of removed) {
					item.removeFromCollection(collection.id);
				}
				if (removed.length) {
					await item.save();
				}
				results.push({
					key: item.key,
					removed_from: removed.map(Lib.collectionPath),
					not_in: collections.filter(c => !removed.includes(c)).map(Lib.collectionPath),
					now_unfiled: !item.getCollections().length || undefined
				});
			}
		});
		await Audit.record("remove_from_collections", { keys: items.map(i => i.key), collections: collections.map(c => c.key), results });
		return { results, note: "Items stay in the library; use trash_items to delete." };
	}

	async function moveItems(args) {
		Lib.assertUserLibrary(args);
		const items = topLevel(Lib.getItems(args.items));
		const source = Lib.resolveCollection(args.from, { label: "Source collection" });
		const targets = Lib.resolveCollections(args.to, { label: "Target collection" });
		if (!targets.length) {
			throw new ToolError("Provide a target collection in 'to'");
		}
		if (targets.some(t => t.id === source.id)) {
			throw new ToolError("Source and target are the same collection");
		}
		const notInSource = items.filter(item => !item.inCollection(source.id));
		if (notInSource.length) {
			throw new ToolError(`Not in source collection '${Lib.collectionPath(source)}': ${notInSource.map(i => i.key).join(", ")}`);
		}
		await Zotero.DB.executeTransaction(async () => {
			for (const item of items) {
				for (const target of targets) {
					item.addToCollection(target.id);
				}
				item.removeFromCollection(source.id);
				await item.save();
			}
		});
		const result = {
			moved: items.map(i => i.key),
			from: Lib.collectionPath(source),
			to: targets.map(Lib.collectionPath)
		};
		await Audit.record("move_items", result);
		return result;
	}

	// ---------------------------------------------------------- collections

	function siblingNameClash(name, parent, exceptID) {
		return Lib.childCollections(parent).find(c => c.name === name && c.id !== exceptID);
	}

	function validName(name) {
		name = String(name || "").trim();
		if (!name) {
			throw new ToolError("Collection name must not be empty");
		}
		return name;
	}

	async function createCollection(args) {
		Lib.assertUserLibrary(args);
		const name = validName(args.name);
		const parent = args.parent ? Lib.resolveCollection(args.parent, { label: "Parent collection" }) : null;
		const clash = siblingNameClash(name, parent);
		const collection = new Zotero.Collection({ libraryID: Lib.libraryID(), name });
		if (parent) {
			collection.parentKey = parent.key;
		}
		await collection.saveTx();
		await Audit.record("create_collection", { keys: [collection.key], name, parent: parent ? parent.key : null });
		return {
			key: collection.key,
			path: Lib.collectionPath(collection),
			warning: clash ? `A sibling collection named '${name}' already exists (${clash.key}); paths are now ambiguous, so address these collections by key.` : undefined
		};
	}

	async function renameCollection(args) {
		Lib.assertUserLibrary(args);
		const collection = Lib.resolveCollection(args.collection);
		const name = validName(args.name);
		const old = collection.name;
		if (old === name) {
			return { status: "unchanged", key: collection.key, path: Lib.collectionPath(collection) };
		}
		const parent = collection.parentKey ? Zotero.Collections.getByLibraryAndKey(Lib.libraryID(), collection.parentKey) : null;
		const clash = siblingNameClash(name, parent, collection.id);
		collection.name = name;
		await collection.saveTx();
		await Audit.record("rename_collection", { keys: [collection.key], before: old, after: name });
		return {
			status: "renamed",
			key: collection.key,
			old_name: old,
			path: Lib.collectionPath(collection),
			warning: clash ? `A sibling collection named '${name}' already exists (${clash.key}).` : undefined
		};
	}

	async function moveCollection(args) {
		Lib.assertUserLibrary(args);
		const collection = Lib.resolveCollection(args.collection);
		const parent = args.parent ? Lib.resolveCollection(args.parent, { label: "New parent" }) : null;
		if (parent && Lib.isAncestorOrSelf(collection, parent)) {
			throw new ToolError("A collection cannot be moved into itself or one of its subcollections");
		}
		const oldPath = Lib.collectionPath(collection);
		const newParentKey = parent ? parent.key : false;
		if ((collection.parentKey || false) === newParentKey) {
			return { status: "unchanged", key: collection.key, path: oldPath };
		}
		collection.parentKey = newParentKey;
		await collection.saveTx();
		const result = { status: "moved", key: collection.key, old_path: oldPath, path: Lib.collectionPath(collection) };
		await Audit.record("move_collection", result);
		return result;
	}

	return {
		normalizeCreators,
		applyFields,
		snapshot,
		createItem,
		updateItem,
		setCitekey,
		addToCollections,
		removeFromCollections,
		moveItems,
		createCollection,
		renameCollection,
		moveCollection,
		fileIntoCollections,
		citekeyAfterBBT,
		insertMutex
	};
})();
