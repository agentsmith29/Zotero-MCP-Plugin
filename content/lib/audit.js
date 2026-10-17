/* global Zotero, ZoteroMCP, IOUtils, PathUtils */

// Append-only log of every executed write, one JSON object per line,
// in the Zotero data directory (zotero-mcp-audit.log).
ZoteroMCP.Audit = (function () {
	const FILE_NAME = "zotero-mcp-audit.log";
	const mutex = ZoteroMCP.Util.createMutex();

	function path() {
		return PathUtils.join(Zotero.DataDirectory.dir, FILE_NAME);
	}

	/**
	 * @param {String} tool
	 * @param {Object} entry - keys, changes (before/after), result summary
	 */
	function record(tool, entry) {
		const line = JSON.stringify(Object.assign({ time: new Date().toISOString(), tool }, entry)) + "\n";
		return mutex.run(async () => {
			try {
				await IOUtils.writeUTF8(path(), line, { mode: "appendOrCreate" });
			}
			catch (e) {
				ZoteroMCP.logError(e);
			}
		});
	}

	return { path, record };
})();
