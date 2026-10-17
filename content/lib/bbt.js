/* global Zotero, ZoteroMCP, Services, ChromeUtils */

// Bridge to Better BibTeX: detection, JSON-RPC over loopback, pull export and its prefs.
// Without BBT the plugin runs in a degraded mode where only bibliography and citekey tools fail.
ZoteroMCP.BBT = (function () {
	const { ToolError } = ZoteroMCP;
	const ADDON_ID = "better-bibtex@iris-advies.com";
	const MIN_VERSION = "7.0.0";
	const PREF_BRANCH = "extensions.zotero.translators.better-bibtex.";
	const RELEASES_API = "https://api.github.com/repos/retorquere/zotero-better-bibtex/releases/latest";

	const TRANSLATORS = {
		biblatex: { id: "f895aa0d-f28e-47fe-b247-2ea77c6ed583", label: "Better BibLaTeX", ext: "biblatex" },
		bibtex: { id: "ca65189f-8815-4afe-8c8b-8c7c15f0edca", label: "Better BibTeX", ext: "bibtex" }
	};

	// Settings the plugin relies on; differences are shown, and fixed only after the user confirms
	const EXPECTED = {
		resetKeyOnChange: false
	};

	// Prefs set_bbt_settings may write
	const ALLOWED_SETTINGS = [
		"citekeyFormat", "citekeyFold", "citekeyCaseInsensitive", "citekeyUnsafeChars", "keyScope",
		"resetKeyOnChange", "autoExport", "autoExportDelay", "autoExportIdleWait", "DOIandURL", "bibtexURL",
		"asciiBibLaTeX", "asciiBibTeX", "exportSort", "skipFields", "journalAbbreviation", "exportTitlecase",
		"exportBraceProtection", "exportCaseProtection", "biblatexExtendedNameFormat", "biblatexExtendedDateFormat",
		"biblatexUsePrefix", "biblatexExtractEprint", "jabrefFormat", "relativeFilePaths", "language",
		"separatorList", "separatorNames", "citeCommand", "quickCopyMode", "warnBulkModify", "automaticTags",
		"exportBibTeXStrings", "verbatimFields", "skipWords"
	];

	let cachedStatus = null;

	async function getAddon() {
		try {
			const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
			return await AddonManager.getAddonByID(ADDON_ID);
		}
		catch (e) {
			ZoteroMCP.logError(e);
			return null;
		}
	}

	function serverRoot() {
		let port;
		try {
			port = Zotero.Server.port;
		}
		catch (e) {
			port = Zotero.Prefs.get("httpServer.port");
		}
		return `http://127.0.0.1:${port}`;
	}

	async function http(method, path, body, timeout = 120000) {
		const xhr = await Zotero.HTTP.request(method, serverRoot() + path, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				"Content-Type": "application/json",
				// Zotero's server refuses browser-like requests unless they opt in
				"Zotero-Allowed-Request": "1"
			},
			successCodes: false,
			timeout,
			responseType: "text"
		});
		return { status: xhr.status, text: xhr.responseText };
	}

	/**
	 * Calls a BBT JSON-RPC method, e.g. rpc("item.citationkey", [["ABCD2345"]])
	 */
	async function rpc(method, params = [], { timeout } = {}) {
		let response;
		try {
			response = await http("POST", "/better-bibtex/json-rpc", { jsonrpc: "2.0", method, params, id: 1 }, timeout);
		}
		catch (e) {
			throw new ToolError(`Better BibTeX did not answer (${e.message}). Is it installed and enabled?`);
		}
		if (response.status === 404) {
			throw new ToolError("Better BibTeX is not installed or not running: its JSON-RPC endpoint was not found.");
		}
		let json;
		try {
			json = JSON.parse(response.text);
		}
		catch (e) {
			throw new ToolError(`Better BibTeX returned an invalid response (HTTP ${response.status})`);
		}
		if (json.error) {
			if (json.error.code === -32601) {
				throw new ToolError(`This Better BibTeX version does not support '${method}'; please update Better BibTeX.`);
			}
			throw new ToolError(`Better BibTeX: ${json.error.message}`, { code: json.error.code });
		}
		return json.result;
	}

	/**
	 * @param {Object} [options]
	 * @param {Boolean} [options.quick] - Reuse a status from the last 30 seconds
	 */
	async function status({ quick = false } = {}) {
		if (quick && cachedStatus && Date.now() - cachedStatus.at < 30000) {
			return cachedStatus.value;
		}
		const value = { installed: false, active: false, ready: false, version: null, min_version: MIN_VERSION };
		const addon = await getAddon();
		if (addon) {
			value.installed = true;
			value.active = !!addon.isActive;
			value.version = addon.version;
			value.too_old = Services.vc.compare(addon.version, MIN_VERSION) < 0;
		}
		if (value.active) {
			try {
				const ready = await rpc("api.ready", [], { timeout: 15000 });
				value.ready = true;
				value.version = ready.betterbibtex || value.version;
			}
			catch (e) {
				value.error = e.message;
			}
		}
		cachedStatus = { at: Date.now(), value };
		return value;
	}

	async function require() {
		const s = await status({ quick: true });
		if (!s.installed) {
			throw new ToolError("Better BibTeX is not installed. The user can install it from Zotero Settings > Zotero MCP > Install Better BibTeX.");
		}
		if (!s.active) {
			throw new ToolError("Better BibTeX is installed but disabled. Enable it in Zotero (Tools > Plugins).");
		}
		if (s.too_old) {
			throw new ToolError(`Better BibTeX ${s.version} is too old; version ${MIN_VERSION} or newer is required.`);
		}
		if (!s.ready) {
			cachedStatus = null;
			const again = await status();
			if (!again.ready) {
				throw new ToolError("Better BibTeX is still starting up; try again in a moment. " + (again.error || ""));
			}
		}
		return s;
	}

	function translator(format) {
		const t = TRANSLATORS[format || "biblatex"];
		if (!t) {
			throw new ToolError(`format must be one of ${Object.keys(TRANSLATORS).join(", ")}`);
		}
		return t;
	}

	/**
	 * Pull export of the library or a collection. BBT always includes subcollections here.
	 */
	async function pullExport({ collection = null, format = "biblatex" } = {}) {
		await require();
		const t = translator(format);
		const libraryID = ZoteroMCP.Lib.libraryID();
		let path = `/better-bibtex/export?/library;id:${libraryID}/`;
		path += collection ? `collection;key:${collection.key}/export.${t.ext}` : `library.${t.ext}`;
		let response;
		try {
			response = await http("GET", path, undefined, 300000);
		}
		catch (e) {
			throw new ToolError("Better BibTeX export failed: " + e.message);
		}
		if (response.status !== 200) {
			throw new ToolError(`Better BibTeX export failed (HTTP ${response.status}): ${response.text}`);
		}
		return response.text;
	}

	/**
	 * Export of exactly these items (by citekey), via item.export
	 */
	async function exportItems(items, format = "biblatex") {
		await require();
		const t = translator(format);
		const keys = items.map(item => ZoteroMCP.Lib.citekey(item)).filter(Boolean);
		if (!keys.length) {
			return "";
		}
		return rpc("item.export", [keys, t.id, ZoteroMCP.Lib.libraryID()], { timeout: 300000 });
	}

	async function citekeys(itemKeys) {
		await require();
		return rpc("item.citationkey", [itemKeys]);
	}

	async function regenerateKeys(citationKeys) {
		await require();
		return rpc("item.regenerate_key", [citationKeys, ZoteroMCP.Lib.libraryID()]);
	}

	// ------------------------------------------------------------------ prefs

	function prefExists(name) {
		return Services.prefs.getPrefType(PREF_BRANCH + name) !== Services.prefs.PREF_INVALID;
	}

	function getPref(name) {
		const full = PREF_BRANCH + name;
		switch (Services.prefs.getPrefType(full)) {
			case Services.prefs.PREF_STRING:
				return Services.prefs.getStringPref(full);
			case Services.prefs.PREF_INT:
				return Services.prefs.getIntPref(full);
			case Services.prefs.PREF_BOOL:
				return Services.prefs.getBoolPref(full);
		}
		return undefined;
	}

	function setPref(name, value) {
		const full = PREF_BRANCH + name;
		switch (Services.prefs.getPrefType(full)) {
			case Services.prefs.PREF_STRING:
				Services.prefs.setStringPref(full, String(value));
				return;
			case Services.prefs.PREF_INT:
				if (!Number.isInteger(value)) {
					throw new ToolError(`${name} expects an integer`);
				}
				Services.prefs.setIntPref(full, value);
				return;
			case Services.prefs.PREF_BOOL:
				if (typeof value !== "boolean") {
					throw new ToolError(`${name} expects true or false`);
				}
				Services.prefs.setBoolPref(full, value);
				return;
		}
		throw new ToolError(`Better BibTeX setting '${name}' does not exist in the installed version`);
	}

	function allPrefs() {
		const branch = Services.prefs.getBranch(PREF_BRANCH);
		const result = {};
		for (const name of branch.getChildList("").sort()) {
			result[name] = getPref(name);
		}
		return result;
	}

	function expectedDifferences() {
		const diffs = [];
		for (const [name, expected] of Object.entries(EXPECTED)) {
			if (!prefExists(name)) {
				continue;
			}
			const current = getPref(name);
			if (current !== expected) {
				diffs.push({ setting: name, current, expected });
			}
		}
		return diffs;
	}

	function applyExpected() {
		const changed = [];
		for (const diff of expectedDifferences()) {
			setPref(diff.setting, diff.expected);
			changed.push(diff);
		}
		return changed;
	}

	// --------------------------------------------------------------- install

	// Installs the latest BBT release from GitHub; only ever called from a user click
	async function installLatest() {
		const xhr = await Zotero.HTTP.request("GET", RELEASES_API, {
			headers: { Accept: "application/vnd.github+json" },
			responseType: "json"
		});
		const release = xhr.response;
		const asset = (release.assets || []).find(a => /\.xpi$/.test(a.name));
		if (!asset) {
			throw new Error("No .xpi found in the latest Better BibTeX release");
		}
		const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
		const install = await AddonManager.getInstallForURL(asset.browser_download_url, {
			telemetryInfo: { source: "zotero-mcp" }
		});
		await install.install();
		cachedStatus = null;
		return { version: release.tag_name, url: asset.browser_download_url };
	}

	// ------------------------------------------------------------ MCP tools

	async function getSettingsTool() {
		const s = await status();
		const result = {
			better_bibtex: {
				installed: s.installed,
				active: s.active,
				ready: s.ready,
				version: s.version,
				min_version: MIN_VERSION
			},
			expected_profile_differences: s.installed ? expectedDifferences() : [],
			writable_settings: ALLOWED_SETTINGS.filter(prefExists)
		};
		if (s.installed) {
			result.settings = allPrefs();
		}
		return result;
	}

	function settingsPreview(args) {
		const settings = args.settings;
		if (!settings || typeof settings !== "object" || Array.isArray(settings) || !Object.keys(settings).length) {
			throw new ToolError("settings must be an object of {name: value}");
		}
		const changes = [];
		const errors = [];
		for (const [name, value] of Object.entries(settings)) {
			if (!ALLOWED_SETTINGS.includes(name)) {
				errors.push(`'${name}' is not on the allow-list (${ALLOWED_SETTINGS.join(", ")})`);
				continue;
			}
			if (!prefExists(name)) {
				errors.push(`'${name}' does not exist in the installed Better BibTeX version`);
				continue;
			}
			const current = getPref(name);
			if (typeof current !== typeof value) {
				errors.push(`'${name}' expects a ${typeof current}, got ${typeof value}`);
				continue;
			}
			changes.push({ setting: name, old: current, new: value, unchanged: current === value || undefined });
		}
		if (errors.length) {
			throw new ToolError(errors.join("; "), { errors });
		}
		const warnings = [];
		if (settings.resetKeyOnChange === true) {
			warnings.push("resetKeyOnChange = true lets Better BibTeX replace citekeys when items change, which breaks existing \\cite{} references.");
		}
		if ("citekeyFormat" in settings) {
			warnings.push("A new citekeyFormat applies to new items; existing keys stay unless regenerated.");
		}
		return { changes, warnings };
	}

	async function setSettingsTool(args) {
		await require();
		return ZoteroMCP.Confirm.run("set_bbt_settings", args, {
			preview: async a => settingsPreview(a),
			execute: async (a, preview) => {
				const applied = [];
				for (const change of preview.changes) {
					if (change.unchanged) {
						continue;
					}
					setPref(change.setting, change.new);
					applied.push({ setting: change.setting, old: change.old, new: getPref(change.setting) });
				}
				await ZoteroMCP.Audit.record("set_bbt_settings", { changes: applied });
				return { applied };
			}
		});
	}

	return {
		ADDON_ID,
		MIN_VERSION,
		TRANSLATORS,
		EXPECTED,
		ALLOWED_SETTINGS,
		status,
		require,
		rpc,
		translator,
		pullExport,
		exportItems,
		citekeys,
		regenerateKeys,
		getPref,
		allPrefs,
		expectedDifferences,
		applyExpected,
		installLatest,
		getSettingsTool,
		setSettingsTool,
		resetCache() {
			cachedStatus = null;
		}
	};
})();
