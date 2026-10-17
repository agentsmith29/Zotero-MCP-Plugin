/* global Zotero, Components, IOUtils, PathUtils, crypto, TextEncoder */

// Shared namespace for all modules. Loaded first by bootstrap.js into the plugin scope.
var ZoteroMCP = {
	version: null,
	pluginID: null,
	rootURI: null,
	PREF_PREFIX: "zoteromcp.",
	PLUGIN_NAME: "Zotero MCP"
};

ZoteroMCP.ToolError = class ToolError extends Error {
	/**
	 * An error the agent can act on. Returned as a tool result with isError: true.
	 * @param {String} message
	 * @param {Object} [data] - Extra structured detail (candidates, conflicts, ...)
	 */
	constructor(message, data) {
		super(message);
		this.name = "ToolError";
		this.data = data;
	}
};

ZoteroMCP.log = function (msg) {
	Zotero.debug("[Zotero MCP] " + msg);
};

ZoteroMCP.logError = function (e) {
	Zotero.logError(e);
};

// Prefs live under extensions.zotero.zoteromcp.*; Zotero.Prefs adds the extensions.zotero. prefix.
ZoteroMCP.Prefs = {
	get(name, fallback) {
		let value;
		try {
			value = Zotero.Prefs.get(ZoteroMCP.PREF_PREFIX + name);
		}
		catch (e) {
			value = undefined;
		}
		return value === undefined ? fallback : value;
	},

	set(name, value) {
		Zotero.Prefs.set(ZoteroMCP.PREF_PREFIX + name, value);
	},

	clear(name) {
		Zotero.Prefs.clear(ZoteroMCP.PREF_PREFIX + name);
	}
};

ZoteroMCP.Util = (function () {
	const { classes: Cc, interfaces: Ci } = Components;
	const HASH_CHUNK = 4 * 1024 * 1024;

	function bytesToHex(bytes) {
		let out = "";
		for (let i = 0; i < bytes.length; i++) {
			out += bytes[i].toString(16).padStart(2, "0");
		}
		return out;
	}

	function binaryStringToHex(str) {
		let out = "";
		for (let i = 0; i < str.length; i++) {
			out += str.charCodeAt(i).toString(16).padStart(2, "0");
		}
		return out;
	}

	function newSHA256() {
		const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
		hasher.init(hasher.SHA256);
		return hasher;
	}

	function randomHex(nBytes) {
		const bytes = new Uint8Array(nBytes);
		crypto.getRandomValues(bytes);
		return bytesToHex(bytes);
	}

	function sha256Hex(str) {
		const hasher = newSHA256();
		const data = new TextEncoder().encode(str);
		hasher.update(data, data.length);
		return binaryStringToHex(hasher.finish(false));
	}

	// Reads in chunks so large files never sit in memory at once
	async function sha256File(path) {
		const hasher = newSHA256();
		let offset = 0;
		while (true) {
			const chunk = await IOUtils.read(path, { offset, maxBytes: HASH_CHUNK });
			if (!chunk.length) {
				break;
			}
			hasher.update(chunk, chunk.length);
			offset += chunk.length;
			if (chunk.length < HASH_CHUNK) {
				break;
			}
		}
		return binaryStringToHex(hasher.finish(false));
	}

	// JSON with sorted object keys, so equal values always hash the same
	function stableStringify(value) {
		if (value === undefined) {
			return "null";
		}
		if (value === null || typeof value !== "object") {
			return JSON.stringify(value);
		}
		if (Array.isArray(value)) {
			return "[" + value.map(stableStringify).join(",") + "]";
		}
		const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
		return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
	}

	function timingSafeEqual(a, b) {
		a = String(a || "");
		b = String(b || "");
		let diff = a.length ^ b.length;
		const len = Math.max(a.length, b.length);
		for (let i = 0; i < len; i++) {
			diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
		}
		return diff === 0;
	}

	function localDate(date = new Date()) {
		const pad = n => String(n).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	}

	function isAbsolutePath(path) {
		if (!path || typeof path !== "string") {
			return false;
		}
		if (Zotero.isWin) {
			return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
		}
		return path.startsWith("/");
	}

	// Relative paths in the export index always use "/" separators
	function nativeFromRelative(root, relPath) {
		return relPath ? PathUtils.join(root, ...relPath.split("/")) : root;
	}

	function utf8Length(str) {
		return new TextEncoder().encode(str).length;
	}

	function splitExtension(filename) {
		const dot = filename.lastIndexOf(".");
		if (dot <= 0 || dot === filename.length - 1) {
			return { base: filename, ext: "" };
		}
		return { base: filename.slice(0, dot), ext: filename.slice(dot + 1) };
	}

	function truncate(str, max) {
		str = String(str || "");
		return str.length > max ? str.slice(0, max - 1) + "…" : str;
	}

	// Runs async functions one at a time, in call order
	function createMutex() {
		let tail = Promise.resolve();
		let busy = false;
		return {
			get busy() {
				return busy;
			},
			run(fn) {
				const result = tail.then(async () => {
					busy = true;
					try {
						return await fn();
					}
					finally {
						busy = false;
					}
				});
				tail = result.catch(() => {});
				return result;
			}
		};
	}

	return {
		randomHex,
		sha256Hex,
		sha256File,
		stableStringify,
		timingSafeEqual,
		localDate,
		isAbsolutePath,
		nativeFromRelative,
		utf8Length,
		splitExtension,
		truncate,
		createMutex
	};
})();
