/* global Zotero, ZoteroMCP */

// Zotero's own lookup functions: the magic wand (add by identifier) and Find Available PDF.
ZoteroMCP.Lookup = (function () {
	const { ToolError, Lib, Audit } = ZoteroMCP;
	const PDF_METHODS = ["doi", "url", "oa", "custom"];

	// Identifier object as Zotero.Translate.Search expects it, plus its normalized form
	function parseIdentifier(text) {
		const found = Zotero.Utilities.extractIdentifiers(String(text || ""));
		if (!found.length) {
			return null;
		}
		const identifier = found[0];
		const ids = { doi: [], isbn: [], arxiv: [], pmid: [] };
		if (identifier.DOI) {
			ids.doi.push(Lib.normalizeDOI(identifier.DOI));
		}
		if (identifier.ISBN) {
			ids.isbn.push(Lib.normalizeISBN(identifier.ISBN));
		}
		if (identifier.arXiv) {
			ids.arxiv.push(Lib.normalizeArXiv(identifier.arXiv));
		}
		if (identifier.PMID) {
			ids.pmid.push(String(identifier.PMID));
		}
		return { identifier, ids };
	}

	async function lookupOne(text, collections, { duplicateForce, saveAttachments }) {
		const parsed = parseIdentifier(text);
		if (!parsed) {
			return { identifier: text, status: "failed", message: "No DOI, ISBN, PMID or arXiv ID recognised" };
		}
		const label = Object.entries(parsed.identifier).map(([type, value]) => `${type}:${value}`).join(" ");

		const existing = await Lib.findByIdentifiers(parsed.ids);
		if (existing.length && !duplicateForce) {
			const { item, matchedBy } = existing[0];
			const added = await ZoteroMCP.Edit.fileIntoCollections(item, collections);
			return {
				identifier: label,
				status: "existing",
				matched_by: matchedBy,
				item: Lib.itemSummary(item),
				added_to_collections: added
			};
		}

		const translate = new Zotero.Translate.Search();
		translate.setIdentifier(parsed.identifier);
		const translators = await translate.getTranslators();
		if (!translators.length) {
			return { identifier: label, status: "failed", message: "No Zotero translator can look up this identifier" };
		}
		translate.setTranslator(translators);
		let newItems;
		try {
			newItems = await translate.translate({
				libraryID: Lib.libraryID(),
				collections: collections.length ? collections.map(c => c.id) : false,
				saveAttachments
			});
		}
		catch (e) {
			return { identifier: label, status: "failed", message: "Lookup failed: " + (e.message || e) };
		}
		if (!newItems || !newItems.length) {
			return { identifier: label, status: "failed", message: "Lookup returned no item" };
		}

		const created = [];
		const merged = [];
		const newIDs = newItems.map(i => i.id);
		for (const item of newItems) {
			// The looked-up record may carry identifiers the input did not (e.g. a DOI lookup
			// returning a book's ISBN), or match an existing entry only by title, author and year
			const others = await Lib.findDuplicates(item, { excludeIDs: newIDs });
			if (others.length && !duplicateForce) {
				merged.push(await absorbIntoExisting(item, others[0], collections));
				continue;
			}
			const dates = ZoteroMCP.Dates.normalizeItem(item);
			if (item.hasChanged()) {
				await item.saveTx();
			}
			const citekey = await ZoteroMCP.Edit.citekeyAfterBBT(item);
			const summary = Object.assign(Lib.itemSummary(item), { citekey: citekey || undefined });
			if (dates.length) {
				summary.dates = dates;
			}
			if (others.length) {
				summary.possible_duplicates = others.map(m => ({ key: m.item.key, matched_by: m.matchedBy }));
			}
			created.push(summary);
		}
		if (!created.length) {
			const first = merged[0];
			return {
				identifier: label,
				status: "existing",
				matched_by: first.matched_by,
				item: first.item,
				added_to_collections: first.added_to_collections,
				discarded_copy: first.discarded_copy,
				moved_attachments: first.moved_attachments.length ? first.moved_attachments : undefined,
				note: "The lookup returned a work that is already in the library; the looked-up copy was discarded."
			};
		}
		return {
			identifier: label,
			status: "created",
			items: created,
			matched_existing: merged.length ? merged : undefined,
			duplicates_ignored: existing.length ? existing.map(m => m.item.key) : undefined
		};
	}

	/**
	 * A freshly looked-up item turned out to be a work already in the library: keep the
	 * existing item, give it any file type it lacks, file it into the collections, and erase
	 * the new copy (created moments ago by this call, so nothing of the user's is lost).
	 */
	async function absorbIntoExisting(newItem, match, collections) {
		const existing = match.item;
		const haveTypes = new Set(Zotero.Items.get(existing.getAttachments(false))
			.filter(a => Lib.isStoredFile(a)).map(a => a.attachmentContentType));
		const moved = [];
		await Zotero.DB.executeTransaction(async () => {
			for (const attachment of Zotero.Items.get(newItem.getAttachments(false))) {
				if (Lib.isStoredFile(attachment) && !haveTypes.has(attachment.attachmentContentType)) {
					haveTypes.add(attachment.attachmentContentType);
					attachment.parentKey = existing.key;
					await attachment.save();
					moved.push(attachment.key);
				}
			}
		});
		const discarded = newItem.key;
		await newItem.eraseTx();
		const added = await ZoteroMCP.Edit.fileIntoCollections(existing, collections);
		return {
			matched_by: match.matchedBy,
			item: Lib.itemSummary(existing),
			discarded_copy: discarded,
			added_to_collections: added,
			moved_attachments: moved
		};
	}

	function addByIdentifier(args) {
		return ZoteroMCP.Edit.insertMutex.run(() => addByIdentifierNow(args));
	}

	async function addByIdentifierNow(args) {
		Lib.assertUserLibrary(args);
		let inputs = args.identifiers;
		if (typeof inputs === "string") {
			inputs = Zotero.Utilities.extractIdentifiers(inputs).map(id => Object.values(id)[0]);
			if (!inputs.length) {
				throw new ToolError("No DOI, ISBN, PMID or arXiv ID found in the text");
			}
		}
		if (!Array.isArray(inputs) || !inputs.length) {
			throw new ToolError("identifiers must be a non-empty array (or a text containing identifiers)");
		}
		if (inputs.length > 50) {
			throw new ToolError("At most 50 identifiers per call");
		}
		const collections = Lib.resolveCollections(args.collections || []);
		const results = [];
		for (const input of inputs) {
			results.push(await lookupOne(input, collections, {
				duplicateForce: !!args.duplicate_force,
				saveAttachments: args.save_attachments !== false
			}));
		}
		const created = results.filter(r => r.status === "created").flatMap(r => r.items.map(i => i.key));
		const filed = results.filter(r => r.status === "existing").map(r => r.item.key);
		const absorbed = results.flatMap(r => (r.status === "existing" && r.discarded_copy ? [r] : (r.matched_existing || []))
			.map(m => ({ existing: m.item.key, discarded_copy: m.discarded_copy, moved_attachments: m.moved_attachments })));
		if (created.length || filed.length) {
			await Audit.record("add_by_identifier", {
				created,
				filed_existing: filed,
				discarded_duplicates: absorbed.length ? absorbed : undefined,
				collections: collections.map(c => c.key)
			});
		}
		return {
			summary: {
				created: results.filter(r => r.status === "created").length,
				existing: filed.length,
				failed: results.filter(r => r.status === "failed").length
			},
			results
		};
	}

	async function findPDF(args) {
		Lib.assertUserLibrary(args);
		const methods = args.methods || PDF_METHODS;
		const bad = methods.filter(m => !PDF_METHODS.includes(m));
		if (bad.length) {
			throw new ToolError(`Unknown methods ${bad.join(", ")}; allowed: ${PDF_METHODS.join(", ")}`);
		}
		const items = Lib.getItems(args.keys);
		if (items.length > 50) {
			throw new ToolError("At most 50 items per call");
		}
		const results = [];
		for (const item of items) {
			if (!item.isRegularItem()) {
				results.push({ key: item.key, status: "skipped", reason: "not a regular item" });
				continue;
			}
			if (!Zotero.Attachments.canFindFileForItem(item)) {
				const hasFile = Zotero.Attachments.FIND_AVAILABLE_FILE_TYPES
					.some(type => item.numFileAttachmentsWithContentType(type) > 0);
				results.push({
					key: item.key,
					status: "skipped",
					reason: hasFile ? "item already has a PDF/EPUB attachment" : "item has no DOI, URL or PMCID to search with"
				});
				continue;
			}
			try {
				const attachment = await Zotero.Attachments.addAvailableFile(item, { methods });
				if (attachment) {
					results.push({
						key: item.key,
						status: "found",
						attachment: { key: attachment.key, file_name: Lib.fileName(attachment), content_type: attachment.attachmentContentType }
					});
				}
				else {
					results.push({ key: item.key, status: "not_found" });
				}
			}
			catch (e) {
				results.push({ key: item.key, status: "failed", reason: e.message || String(e) });
			}
		}
		const found = results.filter(r => r.status === "found");
		if (found.length) {
			await Audit.record("find_pdf", { keys: found.map(r => r.key), attachments: found.map(r => r.attachment.key) });
		}
		return {
			summary: {
				found: found.length,
				not_found: results.filter(r => r.status === "not_found").length,
				skipped: results.filter(r => r.status === "skipped").length,
				failed: results.filter(r => r.status === "failed").length
			},
			results
		};
	}

	return { addByIdentifier, findPDF, parseIdentifier, PDF_METHODS };
})();
