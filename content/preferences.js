/* global window, document, Zotero, Services, PathUtils */

// Runs in the settings window, in a sandbox of its own: wire everything from here
// once the pane's markup has been inserted (it is dispatched a "load" event).
(function () {
	const ROOT_ID = "zotero-mcp-prefs";
	const TITLE = "Zotero MCP";

	function mcp() {
		return Zotero.ZoteroMCP;
	}

	function $(id) {
		return document.getElementById(id);
	}

	function copy(text) {
		Zotero.Utilities.Internal.copyTextToClipboard(text);
	}

	function on(id, handler) {
		const elem = $(id);
		elem.addEventListener("command", handler);
		if (elem.tagName !== "button") {
			elem.addEventListener("click", handler);
		}
	}

	function refreshServer() {
		$("zmcp-endpoint").value = mcp().Server.url;
		$("zmcp-token").value = mcp().Server.ensureToken();
		$("zmcp-command-local").value = mcp().Server.claudeCodeCommand("local");
		$("zmcp-command-user").value = mcp().Server.claudeCodeCommand("user");
	}

	function buildTools() {
		const container = $("zmcp-tools");
		container.textContent = "";
		const groups = mcp().Tools.GROUP_LABELS;
		for (const [group, label] of Object.entries(groups)) {
			const section = document.createElement("div");
			section.className = "zmcp-tool-group";
			const heading = document.createElement("h3");
			heading.textContent = label;
			section.append(heading);
			for (const tool of mcp().Tools.all().filter(t => t.group === group)) {
				const row = document.createElement("label");
				row.className = "zmcp-tool";
				const box = document.createElement("input");
				box.type = "checkbox";
				box.checked = mcp().Tools.isEnabled(tool.name);
				box.addEventListener("change", () => mcp().Tools.setEnabled(tool.name, box.checked));
				const name = document.createElement("code");
				name.textContent = tool.name;
				const desc = document.createElement("span");
				desc.className = "zmcp-tool-desc";
				desc.textContent = tool.title;
				row.append(box, name, desc);
				section.append(row);
			}
			container.append(section);
		}
	}

	function refreshSync() {
		const settings = mcp().FileExport.globalSettings();
		$("zmcp-sync-target").textContent = settings.root
			? `Files are mirrored to ${settings.root}`
			: "Choose a folder to enable the global sync.";
		const raw = mcp().Prefs.get("sync.lastReport", "");
		let text = "No sync has run yet.";
		if (raw) {
			try {
				const r = JSON.parse(raw);
				text = r.error
					? `Last sync (${new Date(r.finished).toLocaleString()}) failed: ${r.error}`
					: `Last sync ${new Date(r.finished).toLocaleString()}: ${r.copied} copied, ${r.updated} updated, ${r.moved} moved, ${r.unchanged} unchanged, ${r.deleted} deleted, ${r.annotated} annotated copies, ${r.missing} missing, ${r.failures} failures.`;
			}
			catch (e) {
				// Ignore an unreadable report
			}
		}
		$("zmcp-sync-report").textContent = text;
	}

	async function refreshBBT() {
		const status = await mcp().BBT.status();
		let text;
		if (!status.installed) {
			text = "Better BibTeX is not installed. Bibliography export and citation key tools are unavailable; everything else works.";
		}
		else if (!status.active) {
			text = `Better BibTeX ${status.version} is installed but disabled (Tools > Plugins).`;
		}
		else if (status.too_old) {
			text = `Better BibTeX ${status.version} is too old; ${status.min_version} or newer is needed.`;
		}
		else if (!status.ready) {
			text = `Better BibTeX ${status.version} is starting… ${status.error || ""}`;
		}
		else {
			text = `Better BibTeX ${status.version} is ready.`;
		}
		$("zmcp-bbt-status").textContent = text;
		$("zmcp-bbt-install").hidden = status.installed && !status.too_old;

		const diffs = status.installed ? mcp().BBT.expectedDifferences() : [];
		$("zmcp-bbt-apply").hidden = !diffs.length;
		$("zmcp-bbt-settings").textContent = diffs.length
			? "Differs from the expected profile: " + diffs.map(d => `${d.setting} = ${JSON.stringify(d.current)} (expected ${JSON.stringify(d.expected)})`).join("; ")
			: (status.installed ? "Settings match the expected profile (resetKeyOnChange off, so citation keys stay stable)." : "");
	}

	function init() {
		refreshServer();
		buildTools();

		const limit = $("zmcp-node-limit");
		limit.value = String(mcp().Prefs.get("tree.nodeLimit", 5000));
		limit.addEventListener("change", () => {
			const value = Math.max(0, parseInt(limit.value) || 0);
			mcp().Prefs.set("tree.nodeLimit", value);
			limit.value = String(value);
		});

		on("zmcp-token-show", () => {
			const field = $("zmcp-token");
			field.type = field.type === "password" ? "text" : "password";
			$("zmcp-token-show").label = field.type === "password" ? "Show" : "Hide";
		});
		on("zmcp-token-copy", () => copy(mcp().Server.ensureToken()));
		on("zmcp-command-local-copy", () => copy(mcp().Server.claudeCodeCommand("local")));
		on("zmcp-command-user-copy", () => copy(mcp().Server.claudeCodeCommand("user")));
		on("zmcp-token-regenerate", () => {
			const ok = Services.prompt.confirm(window, TITLE,
				"Generate a new token? Connected agents stop working until they are set up again with the new token.");
			if (ok) {
				mcp().Server.regenerateToken();
				refreshServer();
			}
		});

		on("zmcp-sync-choose", async () => {
			const folder = await mcp().UI.pickFolder(window, "Choose Global Sync Folder", $("zmcp-sync-path").value);
			if (folder) {
				mcp().Prefs.set("sync.path", folder);
				$("zmcp-sync-path").value = folder;
				refreshSync();
			}
		});
		for (const id of ["zmcp-sync-path", "zmcp-sync-name"]) {
			$(id).addEventListener("synctopreference", refreshSync);
			$(id).addEventListener("input", () => setTimeout(refreshSync, 0));
		}
		on("zmcp-sync-now", async () => {
			$("zmcp-sync-now").disabled = true;
			try {
				await mcp().UI.syncNowFromWindow(window);
			}
			catch (e) {
				// Already reported
			}
			finally {
				$("zmcp-sync-now").disabled = false;
				refreshSync();
			}
		});
		on("zmcp-sync-bib", () => mcp().UI.setupGlobalBibliography(window).catch((e) => {
			Zotero.logError(e);
			Services.prompt.alert(window, TITLE, "Bibliography setup failed:\n\n" + e.message);
		}));

		on("zmcp-bbt-install", async () => {
			$("zmcp-bbt-install").disabled = true;
			await mcp().UI.installBBT(window);
			$("zmcp-bbt-install").disabled = false;
			mcp().BBT.resetCache();
			refreshBBT();
		});
		on("zmcp-bbt-apply", () => {
			mcp().BBT.applyExpected();
			refreshBBT();
		});

		$("zmcp-audit-path").value = mcp().Audit.path();
		on("zmcp-audit-reveal", () => {
			try {
				Zotero.File.reveal(PathUtils.parent(mcp().Audit.path()));
			}
			catch (e) {
				Zotero.logError(e);
			}
		});

		refreshSync();
		refreshBBT().catch(e => Zotero.logError(e));
	}

	document.addEventListener("load", function handler(event) {
		if (event.target && event.target.id === ROOT_ID) {
			document.removeEventListener("load", handler, true);
			try {
				init();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	}, true);
})();
