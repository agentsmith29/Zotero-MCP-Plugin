/* global ZoteroMCP */

// Two-phase confirmation: the first call returns a preview and a confirmation_id;
// only a second call with the same arguments and that ID executes. The ID is
// single-use, expires after 5 minutes and is bound to a hash of the preview, so
// any change to the library in between invalidates it.
ZoteroMCP.Confirm = (function () {
	const { ToolError, Util } = ZoteroMCP;
	const TTL_MS = 5 * 60 * 1000;
	const pending = new Map();

	function prune() {
		const now = Date.now();
		for (const [id, entry] of pending) {
			if (entry.expires < now) {
				pending.delete(id);
			}
		}
	}

	function issue(tool, argsHash, preview) {
		const id = Util.randomHex(12);
		pending.set(id, {
			tool,
			argsHash,
			previewHash: Util.sha256Hex(Util.stableStringify(preview)),
			expires: Date.now() + TTL_MS
		});
		return {
			phase: "preview",
			confirmation_id: id,
			expires_in_seconds: TTL_MS / 1000,
			preview,
			next_step: `Nothing has changed yet. Show this preview to the user; if they agree, call ${tool} again with the same arguments plus "confirmation_id": "${id}".`
		};
	}

	/**
	 * @param {String} tool
	 * @param {Object} args - tool arguments, possibly with confirmation_id
	 * @param {Object} handlers
	 * @param {Function} handlers.preview - async (args) => deterministic preview object
	 * @param {Function} handlers.execute - async (args, preview) => result
	 */
	async function run(tool, args, { preview, execute }) {
		prune();
		const { confirmation_id: confirmationID, ...rest } = args;
		const argsHash = Util.sha256Hex(tool + "\n" + Util.stableStringify(rest));

		if (!confirmationID) {
			return issue(tool, argsHash, await preview(rest));
		}

		const entry = pending.get(confirmationID);
		if (!entry) {
			throw new ToolError("confirmation_id is unknown, already used or expired (valid 5 minutes). Call without confirmation_id for a fresh preview.");
		}
		if (entry.tool !== tool || entry.argsHash !== argsHash) {
			throw new ToolError("confirmation_id belongs to a different call: use exactly the arguments of the preview.");
		}
		pending.delete(confirmationID);

		const current = await preview(rest);
		if (Util.sha256Hex(Util.stableStringify(current)) !== entry.previewHash) {
			const fresh = issue(tool, argsHash, current);
			throw new ToolError("The library changed since the preview, so nothing was done. Review the new preview; it has a new confirmation_id.", fresh);
		}
		const result = await execute(rest, current);
		return { phase: "executed", result };
	}

	return { run, TTL_MS };
})();
