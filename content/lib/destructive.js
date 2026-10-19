/* global Zotero, ZoteroMCP, ChromeUtils */

// Duplicates, merging and deletion. Everything that removes data is two-phase and
// only ever moves things into Zotero's trash; no tool empties the trash.
ZoteroMCP.Destructive = (function () {
	const { ToolError, Lib, Audit, Confirm } = ZoteroMCP;
	const MERGE_IGNORE_FIELDS = ["dateAdded", "dateModified", "accessDate"];
	const MERGE_COMBINED = ["tags", "collections", "relations", "citationKey"];

	function brief(item) {
		return {
			key: item.key,
			type: item.itemType,
			title: Lib.itemTitle(item),
			creator: Lib.firstCreator(item) || undefined,
			year: Lib.year(item) || undefined,
			citekey: item.isRegularItem() ? (Lib.citekey(item) || undefined) : undefined,
			date_added: item.dateAdded
		};
	}

	// Date overrides are kept in Zotero's internal "YYYY-MM-DD text" form; show the text
	function shown(field, value) {
		return ZoteroMCP.Dates.isDateField(field) && Zotero.Date.isMultipart(value)
			? Zotero.Date.multipartToStr(value)
			: value;
	}

	function childCounts(item) {
		if (!item.isRegularItem()) {
			return { attachments: 0, notes: 0 };
		}
		return { attachments: item.getAttachments(false).length, notes: item.getNotes(false).length };
	}

	// --------------------------------------------------------- duplicates

	async function findDuplicates(args) {
		Lib.assertUserLibrary(args);
		const limit = Math.min(Math.max(parseInt(args.limit) || 50, 1), 500);
		const duplicates = new Zotero.Duplicates(Lib.libraryID());
		const search = await duplicates.getSearchObject();
		let ids;
		try {
			ids = await search.search();
		}
		finally {
			// getSearchObject() leaves a temporary table behind for the item tree; drop it
			const condition = Object.values(search.getConditions()).find(c => c.condition === "tempTable");
			if (condition && /^tmpDuplicates_\w+$/.test(condition.value)) {
				await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${condition.value}`);
			}
		}
		const seen = new Set();
		const sets = [];
		for (const id of ids) {
			if (seen.has(id)) {
				continue;
			}
			const setIDs = duplicates.getSetItemsByItemID(id);
			setIDs.forEach(setID => seen.add(setID));
			const items = Zotero.Items.get(setIDs).filter(item => item && !item.deleted);
			if (items.length < 2) {
				continue;
			}
			items.sort((a, b) => (a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : 0));
			sets.push({
				items: items.map(brief),
				suggested_master: items[0].key,
				same_type: items.every(item => item.itemTypeID === items[0].itemTypeID)
			});
		}
		return {
			total_sets: sets.length,
			returned: Math.min(limit, sets.length),
			sets: sets.slice(0, limit),
			note: "Zotero's duplicate detection (title, DOI, ISBN, creators, year). Merge a set with merge_items; the suggested master is the oldest item, as in Zotero."
		};
	}

	// -------------------------------------------------------------- merge

	function mergePlan(args) {
		const master = Lib.getItem(args.master, { allowChild: false, label: "Master item" });
		const others = Lib.getItems(args.others || [], { allowChild: false });
		if (!others.length) {
			throw new ToolError("others must list at least one item to merge into the master");
		}
		if (others.some(o => o.id === master.id)) {
			throw new ToolError("The master item must not be listed in others");
		}
		for (const item of [master, ...others]) {
			if (!item.isRegularItem()) {
				throw new ToolError(`Only regular items can be merged; ${item.key} is a ${item.itemType}`);
			}
			if (item.itemTypeID !== master.itemTypeID) {
				throw new ToolError(`All items must have the same type (Zotero requirement): ${item.key} is ${item.itemType}, master is ${master.itemType}`);
			}
		}

		// Field values the master ends up with: its own, unless overridden
		const alternatives = master.multiDiff(others, MERGE_IGNORE_FIELDS) || {};
		const masterJSON = master.toJSON();
		const overrides = {};
		const errors = [];
		for (const [field, choice] of Object.entries(args.fields || {})) {
			if (["creators", "tags", "collections", "relations", "itemType", "key", "version"].includes(field)) {
				errors.push(`'${field}' cannot be chosen; only metadata fields`);
				continue;
			}
			if (choice && typeof choice === "object" && choice.from) {
				const source = [master, ...others].find(item => item.key === choice.from);
				if (!source) {
					errors.push(`fields.${field}.from '${choice.from}' is not one of the merged items`);
					continue;
				}
				// Date fields keep their internal form so the day/month order survives
				overrides[field] = ZoteroMCP.Dates.isDateField(field)
					? (source.getField(field, true, true) || "")
					: (source.toJSON()[field] || "");
			}
			else if (typeof choice === "string") {
				overrides[field] = ZoteroMCP.Dates.isDateField(field)
					? ZoteroMCP.Dates.forDateField(field, choice).value
					: choice;
			}
			else {
				errors.push(`fields.${field} must be a string or {"from": "<item key>"}`);
			}
		}
		if (errors.length) {
			throw new ToolError(errors.join("; "));
		}
		if ("citationKey" in overrides) {
			errors.push("citationKey is kept from the master; change it afterwards with set_citekey if needed");
			throw new ToolError(errors.join("; "));
		}

		const differing = {};
		for (const [field, values] of Object.entries(alternatives)) {
			// Combined by the merge itself, or shown under citekey
			if (MERGE_COMBINED.includes(field)) {
				continue;
			}
			differing[field] = {
				master: masterJSON[field] !== undefined ? masterJSON[field] : "",
				alternatives: values,
				result: field in overrides ? shown(field, overrides[field]) : (masterJSON[field] !== undefined ? masterJSON[field] : "")
			};
		}
		for (const [field, value] of Object.entries(overrides)) {
			if (!(field in differing)) {
				differing[field] = { master: masterJSON[field] || "", alternatives: [], result: shown(field, value) };
			}
		}

		const counts = others.map(childCounts);
		const collections = new Set(master.getCollections());
		others.forEach(o => o.getCollections().forEach(id => collections.add(id)));
		const otherCitekeys = others.map(o => Lib.citekey(o)).filter(Boolean);

		return {
			master,
			others,
			overrides,
			preview: {
				master: brief(master),
				merged_into_master_then_trashed: others.map(brief),
				fields: differing,
				moved_to_master: {
					attachments: counts.reduce((n, c) => n + c.attachments, 0),
					notes: counts.reduce((n, c) => n + c.notes, 0),
					note: "Zotero keeps one copy of identical PDFs and moves the rest; tags, relations and collections are combined."
				},
				collections_after: Zotero.Collections.get([...collections]).filter(c => c && !c.deleted).map(Lib.collectionPath).sort(),
				citekey: {
					kept: Lib.citekey(master) || null,
					lost: otherCitekeys,
					warning: otherCitekeys.length ? "\\cite{} references to the trashed items' citation keys will break unless you switch them to the kept key." : undefined
				}
			}
		};
	}

	async function mergeItems(args) {
		Lib.assertUserLibrary(args);
		return Confirm.run("merge_items", args, {
			preview: async a => mergePlan(a).preview,
			execute: async (a) => {
				const { master, others, overrides } = mergePlan(a);
				const before = master.toJSON();
				if (Object.keys(overrides).length) {
					// fromJSON() re-parses date text in the app language (en-US reads 05/03 as
					// 3 May), so date fields are set afterwards in their internal form
					const dateValues = {};
					for (const fieldID of Zotero.ItemFields.getItemTypeFields(master.itemTypeID)) {
						if (Zotero.ItemFields.isDate(fieldID)) {
							const name = Zotero.ItemFields.getName(fieldID);
							dateValues[name] = name in overrides ? overrides[name] : master.getField(name, true, true);
						}
					}
					const json = master.toJSON();
					Object.assign(json, overrides);
					master.fromJSON(json);
					for (const [name, value] of Object.entries(dateValues)) {
						master.setField(name, value || "");
					}
				}
				const { mergeItems: zoteroMerge } = ChromeUtils.importESModule("chrome://zotero/content/mergeItems.mjs");
				await zoteroMerge(master, others);
				const result = {
					master: master.key,
					trashed: others.map(o => o.key),
					citekey: Lib.citekey(master) || null
				};
				await Audit.record("merge_items", Object.assign({ before, after: master.toJSON() }, result));
				return result;
			}
		});
	}

	// -------------------------------------------------------------- trash

	function trashPlan(args) {
		const items = Lib.getItems(args.keys);
		return {
			items,
			preview: {
				to_trash: items.map(item => Object.assign(brief(item), childCounts(item), {
					parent: item.isTopLevelItem() ? undefined : item.parentKey,
					collections: item.isTopLevelItem() ? Lib.itemCollectionPaths(item).map(c => c.path) : undefined
				})),
				note: "Items go to Zotero's trash (child attachments and notes with them) and can be restored from there; nothing is erased."
			}
		};
	}

	async function trashItems(args) {
		Lib.assertUserLibrary(args);
		return Confirm.run("trash_items", args, {
			preview: async a => trashPlan(a).preview,
			execute: async (a) => {
				const { items } = trashPlan(a);
				await Zotero.Items.trashTx(items.map(item => item.id));
				const result = { trashed: items.map(item => item.key) };
				await Audit.record("trash_items", result);
				return result;
			}
		});
	}

	// --------------------------------------------------- delete collection

	function deleteCollectionPlan(args) {
		const collection = Lib.resolveCollection(args.collection);
		const descendants = Zotero.Collections.getByParent(collection.id, true);
		const items = Lib.collectionItems(collection, true);
		const withItems = !!args.with_items;
		const preview = {
			collection: { key: collection.key, path: Lib.collectionPath(collection) },
			subcollections: descendants.map(c => ({ key: c.key, path: Lib.collectionPath(c) })),
			with_items: withItems,
			items_in_tree: items.length
		};
		if (withItems) {
			preview.items_to_trash = items.map(brief);
			preview.note = "The collection, its subcollections and all their items go to Zotero's trash, even items that are also in other collections.";
		}
		else {
			preview.items_becoming_unfiled = items
				.filter(item => item.getCollections().every(id => id === collection.id || descendants.some(d => d.id === id)))
				.map(item => item.key);
			preview.note = "The collection and its subcollections go to Zotero's trash; their items stay in the library.";
		}
		return { collection, items, preview };
	}

	async function deleteCollection(args) {
		Lib.assertUserLibrary(args);
		return Confirm.run("delete_collection", args, {
			preview: async a => deleteCollectionPlan(a).preview,
			execute: async (a) => {
				const { collection, items } = deleteCollectionPlan(a);
				await Zotero.DB.executeTransaction(async () => {
					collection.deleted = true;
					await collection.save({ deleteItems: !!a.with_items });
				});
				const result = {
					trashed_collection: collection.key,
					trashed_items: a.with_items ? items.map(item => item.key) : []
				};
				await Audit.record("delete_collection", result);
				return result;
			}
		});
	}

	return { findDuplicates, mergeItems, trashItems, deleteCollection };
})();
