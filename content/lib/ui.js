/* global Zotero, ZoteroMCP, Services, ChromeUtils, PathUtils, IOUtils, setTimeout */

// User-facing pieces: the right-click "Export Files…" flow, the Better BibTeX
// export window, startup notices and progress/report windows.
ZoteroMCP.UI = (function () {
	const { Lib, BBT, FileExport } = ZoteroMCP;
	const MENU_ID = "zotero-mcp-export-files";
	const FTL = "zotero-mcp.ftl";
	const TITLE = "Zotero MCP";

	let menuKey = null;
	let noticesShown = false;

	// ---------------------------------------------------------------- menus

	function exportTarget(context) {
		const rows = context && context.collectionTreeRows;
		if (!rows || rows.length !== 1) {
			return null;
		}
		const row = rows[0];
		if (row.isLibrary(false) && row.ref.libraryID === Lib.libraryID()) {
			return { collection: null };
		}
		if (row.isCollection() && row.ref.libraryID === Lib.libraryID()) {
			return { collection: row.ref };
		}
		return null;
	}

	function registerMenus() {
		if (menuKey) {
			return;
		}
		const key = Zotero.MenuManager.registerMenu({
			menuID: MENU_ID,
			pluginID: ZoteroMCP.pluginID,
			target: "main/library/collection",
			menus: [{
				menuType: "menuitem",
				l10nID: "zotero-mcp-menu-export-files",
				onShowing: (event, context) => {
					context.setVisible(!!exportTarget(context));
				},
				onCommand: (event, context) => {
					const target = exportTarget(context);
					const win = (event && event.target && event.target.ownerGlobal) || Zotero.getMainWindow();
					if (target) {
						exportFiles(win, target).catch((e) => {
							ZoteroMCP.logError(e);
							Services.prompt.alert(win, TITLE, "Export failed:\n\n" + e.message);
						});
					}
				}
			}]
		});
		if (!key) {
			throw new Error("Zotero.MenuManager rejected the Export Files menu");
		}
		menuKey = key;
	}

	function unregisterMenus() {
		if (menuKey) {
			try {
				Zotero.MenuManager.unregisterMenu(menuKey);
			}
			catch (e) {
				ZoteroMCP.logError(e);
			}
			menuKey = null;
		}
	}

	function onMainWindowLoad(window) {
		window.MozXULElement.insertFTLIfNeeded(FTL);
		if (!noticesShown) {
			noticesShown = true;
			// Better BibTeX starts after us; give it time before checking
			setTimeout(() => startupNotices(window).catch(e => ZoteroMCP.logError(e)), 20000);
		}
	}

	function onMainWindowUnload(window) {
		window.document.querySelector(`[href="${FTL}"]`)?.remove();
	}

	// ------------------------------------------------------------- pickers

	async function pickFolder(window, title, current) {
		const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
		const fp = new FilePicker();
		fp.init(window, title, fp.modeGetFolder);
		if (current) {
			try {
				fp.displayDirectory = current;
			}
			catch (e) {
				// Folder no longer exists
			}
		}
		const rv = await fp.show();
		if (rv !== fp.returnOK && rv !== fp.returnReplace) {
			return null;
		}
		return fp.file || null;
	}

	// ---------------------------------------------- Better BibTeX export window

	// Hides "Export Files" in Zotero's export options window while it is open for us:
	// the files come from our own export, so the translator must never copy them.
	function watchExportOptionsWindow() {
		const listener = {
			onOpenWindow(xulWindow) {
				const win = xulWindow.docShell.domWindow;
				win.addEventListener("load", () => {
					if (win.location.href !== "chrome://zotero/content/exportOptions.xhtml") {
						return;
					}
					const hide = () => {
						for (const id of ["export-option-exportFileData", "export-option-includeAnnotations"]) {
							const node = win.document.getElementById(id);
							if (node) {
								node.checked = false;
								node.hidden = true;
							}
						}
						win.sizeToContent();
					};
					setTimeout(hide, 0);
					win.document.getElementById("format-menu")?.addEventListener("command", () => setTimeout(hide, 0));
				}, { once: true });
			},
			onCloseWindow() {},
			onWindowTitleChange() {}
		};
		Services.wm.addListener(listener);
		return () => Services.wm.removeListener(listener);
	}

	/**
	 * Shows BBT's export options (only Better BibLaTeX / Better BibTeX). "Keep updated"
	 * there registers a normal BBT auto-export at the .bib path.
	 * @return {Promise<Object|null>} the dialog's io object, or null if cancelled
	 */
	async function chooseBibliographyOptions(window) {
		const translation = new Zotero.Translate.Export();
		const ids = Object.values(BBT.TRANSLATORS).map(t => t.id);
		const translators = (await translation.getTranslators()).filter(t => ids.includes(t.translatorID));
		if (!translators.length) {
			throw new Error("Better BibTeX's translators are not available. Is Better BibTeX installed and enabled?");
		}
		translators.sort((a, b) => ids.indexOf(a.translatorID) - ids.indexOf(b.translatorID));
		const io = { translators, exportingNotes: false };
		const unwatch = watchExportOptionsWindow();
		try {
			window.openDialog("chrome://zotero/content/exportOptions.xhtml", "_blank", "chrome,modal,centerscreen,resizable=no", io);
		}
		finally {
			unwatch();
		}
		if (!io.selectedTranslator) {
			return null;
		}
		io.displayOptions = Object.assign({}, io.displayOptions, { exportFileData: false, includeAnnotations: false });
		return io;
	}

	function runBibliographyExport({ collection, bibPath, io }) {
		return new Promise((resolve, reject) => {
			const translation = new Zotero.Translate.Export();
			if (collection) {
				translation.setCollection(collection);
			}
			else {
				translation.setLibraryID(Lib.libraryID());
			}
			translation.setLocation(Zotero.File.pathToFile(bibPath));
			translation.setTranslator(io.selectedTranslator.translatorID);
			translation.setDisplayOptions(io.displayOptions);
			translation.setHandler("done", (obj, worked) => {
				if (worked) {
					resolve(bibPath);
				}
				else {
					reject(new Error("Better BibTeX export failed"));
				}
			});
			translation.translate();
		});
	}

	// --------------------------------------------------------- export flow

	function progress(headline, text) {
		const win = new Zotero.ProgressWindow({ closeOnClick: false });
		win.changeHeadline(headline);
		const line = new win.ItemProgress("chrome://zotero/skin/16/universal/folder.svg", text);
		line.setProgress(50);
		win.show();
		return {
			done(message) {
				line.setText(message);
				line.setProgress(100);
				win.startCloseTimer(4000);
			}
		};
	}

	/**
	 * Right-click > Export Files… on My Library or a collection: always a one-off export.
	 */
	async function exportFiles(window, { collection }) {
		const defaultName = collection ? collection.name : Lib.libraryName();
		let folder = await pickFolder(window, "Choose Export Location", ZoteroMCP.Prefs.get("export.lastFolder", ""));
		if (!folder) {
			return;
		}
		const bbt = await BBT.status({ quick: true });
		const io = {
			folder,
			name: defaultName,
			scopeLabel: collection ? `Collection “${Lib.collectionPath(collection)}”` : Lib.libraryName(),
			structure: ZoteroMCP.Prefs.get("export.structure", "collections"),
			includeBibliography: bbt.ready ? ZoteroMCP.Prefs.get("export.includeBibliography", true) : false,
			bbtAvailable: !!bbt.ready,
			pickFolder: (win, current) => pickFolder(win, "Choose Export Location", current),
			accepted: false
		};
		window.openDialog("chrome://zotero-mcp/content/exportSetup.xhtml", "", "chrome,modal,centerscreen,resizable=no", io);
		if (!io.accepted) {
			return;
		}
		folder = io.folder;
		ZoteroMCP.Prefs.set("export.lastFolder", folder);
		ZoteroMCP.Prefs.set("export.structure", io.structure);
		if (io.bbtAvailable) {
			ZoteroMCP.Prefs.set("export.includeBibliography", !!io.includeBibliography);
		}
		const name = io.name.trim() || defaultName;
		const root = PathUtils.join(folder, FileExport.cleanSegment(name));

		let bibOptions = null;
		if (io.includeBibliography) {
			bibOptions = await chooseBibliographyOptions(window);
			if (!bibOptions) {
				return;
			}
		}

		const bar = progress(TITLE, `Exporting files to ${root}…`);
		let report;
		try {
			report = await FileExport.runExclusive({ scope: { collection }, root, structure: io.structure, reason: "right-click" });
		}
		catch (e) {
			bar.done("Export failed");
			throw e;
		}
		if (bibOptions) {
			try {
				report.bibliography = await runBibliographyExport({
					collection,
					bibPath: PathUtils.join(root, FileExport.cleanSegment(name) + ".bib"),
					io: bibOptions
				});
			}
			catch (e) {
				report.bibliography_error = e.message;
			}
		}
		bar.done("Export finished");
		Services.prompt.alert(window, TITLE, FileExport.formatReport(report));
	}

	/**
	 * From the settings pane: register BBT's "Keep updated" export of My Library
	 * into the global sync folder.
	 */
	async function setupGlobalBibliography(window) {
		const settings = FileExport.globalSettings();
		if (!settings.path) {
			Services.prompt.alert(window, TITLE, "Set the global sync folder first.");
			return false;
		}
		const io = await chooseBibliographyOptions(window);
		if (!io) {
			return false;
		}
		await IOUtils.makeDirectory(settings.root, { createAncestors: true, ignoreExisting: true });
		const bibPath = PathUtils.join(settings.root, FileExport.cleanSegment(settings.folderName) + ".bib");
		await runBibliographyExport({ collection: null, bibPath, io });
		Services.prompt.alert(window, TITLE, `Bibliography written to\n${bibPath}\n\n`
			+ (io.displayOptions.keepUpdated ? "Better BibTeX keeps it updated (see Better BibTeX's Automatic export settings)." : "Tick “Keep updated” next time to have Better BibTeX keep it current."));
		return true;
	}

	async function syncNowFromWindow(window) {
		const bar = progress(TITLE, "Syncing library folder…");
		try {
			const report = await FileExport.syncGlobal({ reason: "settings" });
			bar.done("Sync finished");
			Services.prompt.alert(window, TITLE, FileExport.formatReport(report));
			return report;
		}
		catch (e) {
			bar.done("Sync failed");
			Services.prompt.alert(window, TITLE, "Sync failed:\n\n" + e.message);
			throw e;
		}
	}

	// -------------------------------------------------------------- notices

	async function installBBT(window) {
		try {
			const result = await BBT.installLatest();
			Services.prompt.alert(window, TITLE, `Better BibTeX ${result.version} was installed. Zotero may ask for a restart.`);
			return true;
		}
		catch (e) {
			ZoteroMCP.logError(e);
			Services.prompt.alert(window, TITLE, "Installing Better BibTeX failed:\n\n" + e.message);
			return false;
		}
	}

	function confirm(window, title, text, acceptLabel, cancelLabel = "Not Now") {
		const ps = Services.prompt;
		const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING;
		const dontAsk = { value: false };
		const index = ps.confirmEx(window, title, text, flags, acceptLabel, cancelLabel, null, "Don't show this again", dontAsk);
		return { accepted: index === 0, dontAsk: dontAsk.value };
	}

	async function startupNotices(window) {
		if (window.closed) {
			return;
		}
		const status = await BBT.status();
		if ((!status.installed || status.too_old) && ZoteroMCP.Prefs.get("notices.bbtMissing", true)) {
			const text = status.installed
				? `Better BibTeX ${status.version} is too old for Zotero MCP (needs ${BBT.MIN_VERSION} or newer). Bibliography export and citation keys are unavailable until it is updated.`
				: "Zotero MCP needs the Better BibTeX plugin for bibliography export and citation keys. Everything else works without it.\n\nInstall the latest Better BibTeX release from GitHub now?";
			const { accepted, dontAsk } = confirm(window, TITLE, text, "Install Better BibTeX");
			if (dontAsk) {
				ZoteroMCP.Prefs.set("notices.bbtMissing", false);
			}
			if (accepted) {
				await installBBT(window);
			}
			return;
		}
		if (status.installed && status.active) {
			const diffs = BBT.expectedDifferences();
			if (diffs.length && ZoteroMCP.Prefs.get("notices.bbtSettings", true)) {
				const lines = diffs.map(d => `• ${d.setting}: ${JSON.stringify(d.current)} (expected ${JSON.stringify(d.expected)})`);
				const { accepted, dontAsk } = confirm(window, TITLE,
					"Some Better BibTeX settings differ from what Zotero MCP expects:\n\n" + lines.join("\n")
					+ "\n\nWith resetKeyOnChange on, editing an item can change its citation key and break \\cite{} references.\n\nApply the expected settings?",
					"Apply");
				if (dontAsk) {
					ZoteroMCP.Prefs.set("notices.bbtSettings", false);
				}
				if (accepted) {
					BBT.applyExpected();
				}
			}
		}
	}

	return {
		registerMenus,
		unregisterMenus,
		onMainWindowLoad,
		onMainWindowUnload,
		pickFolder,
		exportFiles,
		setupGlobalBibliography,
		syncNowFromWindow,
		installBBT,
		exportTarget,
		chooseBibliographyOptions,
		runBibliographyExport
	};
})();
