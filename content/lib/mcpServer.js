/* global Zotero, ZoteroMCP, atob, TextDecoder */

// MCP over Streamable HTTP on Zotero's own server (127.0.0.1:23119).
// Dual-era: stateless per-request metadata (2026-07-28) and the older
// initialize/Mcp-Session-Id handshake (2025-03-26 .. 2025-11-25). Plain JSON, no SSE.
ZoteroMCP.Server = (function () {
	const MCP_PATH = "/zotero-mcp/mcp";
	const PING_PATH = "/zotero-mcp/ping";
	const MODERN_VERSIONS = ["2026-07-28"];
	const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
	const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
	const META_VERSION = "io.modelcontextprotocol/protocolVersion";
	const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
	const DISCOVER_TTL_MS = 5 * 60 * 1000;
	const TOOLS_TTL_MS = 60 * 1000;

	// JSON-RPC / MCP error codes
	const PARSE_ERROR = -32700;
	const INVALID_REQUEST = -32600;
	const METHOD_NOT_FOUND = -32601;
	const INVALID_PARAMS = -32602;
	const INTERNAL_ERROR = -32603;
	const SESSION_NOT_FOUND = -32001;
	const HEADER_MISMATCH = -32020;
	const UNSUPPORTED_VERSION = -32022;

	// Status texts Zotero's server lacks; added while the plugin runs
	const EXTRA_STATUS = {
		202: "Accepted",
		401: "Unauthorized",
		405: "Method Not Allowed",
		406: "Not Acceptable",
		415: "Unsupported Media Type"
	};

	const sessions = new Map();
	let addedStatus = [];

	class RpcError extends Error {
		constructor(code, message, data, httpStatus) {
			super(message);
			this.code = code;
			this.data = data;
			this.httpStatus = httpStatus;
		}
	}

	function instructions() {
		return [
			"Tools for the user's Zotero personal library (My Library). Items and collections are addressed by their 8-character keys.",
			"Use search_items or get_library_tree to find keys. Tools that change data irreversibly or in bulk work in two phases:",
			"the first call returns a preview and a confirmation_id; show the preview to the user and call again with the same",
			"arguments plus confirmation_id only after they agree. Citation keys come from Better BibTeX and stay stable unless",
			"you explicitly regenerate or set them."
		].join(" ");
	}

	function serverInfo() {
		return { name: "zotero-mcp", title: ZoteroMCP.PLUGIN_NAME, version: ZoteroMCP.version || "0.0.0" };
	}

	function jsonResponse(status, body, headers = {}) {
		return [status, Object.assign({ "Content-Type": "application/json" }, headers), JSON.stringify(body)];
	}

	function rpcError(id, code, message, data) {
		const error = { code, message };
		if (data !== undefined) {
			error.data = data;
		}
		return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
	}

	function rpcResult(id, result) {
		return { jsonrpc: "2.0", id, result };
	}

	function isNotification(msg) {
		return msg && typeof msg === "object" && !("id" in msg);
	}

	function decodeHeaderValue(value) {
		const m = /^=\?base64\?(.*)\?=$/.exec(value || "");
		if (!m) {
			return value;
		}
		const binary = atob(m[1]);
		const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	}

	function acceptsJSON(accept) {
		if (!accept) {
			return true;
		}
		return accept.split(",").some((part) => {
			const type = part.split(";")[0].trim().toLowerCase();
			return type === "application/json" || type === "application/*" || type === "*/*";
		});
	}

	function checkAuth(headers) {
		const token = ZoteroMCP.Prefs.get("token", "");
		const m = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization || "");
		return !!token && !!m && ZoteroMCP.Util.timingSafeEqual(m[1], token);
	}

	function unauthorized() {
		return jsonResponse(401, rpcError(null, INVALID_REQUEST, "Unauthorized: send 'Authorization: Bearer <token>' (token is shown in Zotero settings > Zotero MCP)"), {
			"WWW-Authenticate": 'Bearer realm="zotero-mcp"'
		});
	}

	function pruneSessions() {
		const cutoff = Date.now() - SESSION_IDLE_MS;
		for (const [id, session] of sessions) {
			if (session.lastSeen < cutoff) {
				sessions.delete(id);
			}
		}
	}

	// ---------------------------------------------------------------- dispatch

	async function dispatch(method, params, era) {
		switch (method) {
			case "ping":
				return {};

			case "server/discover":
				if (era !== "modern") {
					break;
				}
				return {
					supportedVersions: ALL_VERSIONS,
					capabilities: { tools: { listChanged: false } },
					_meta: { "io.modelcontextprotocol/serverInfo": serverInfo() },
					instructions: instructions(),
					ttlMs: DISCOVER_TTL_MS,
					cacheScope: "private"
				};

			case "tools/list": {
				const result = { tools: ZoteroMCP.Tools.list() };
				if (era === "modern") {
					// Short TTL: the user can switch tools off at any time in the settings
					result.ttlMs = TOOLS_TTL_MS;
					result.cacheScope = "private";
				}
				return result;
			}

			case "tools/call": {
				if (!params || typeof params.name !== "string") {
					throw new RpcError(INVALID_PARAMS, "tools/call requires params.name");
				}
				if (!ZoteroMCP.Tools.exists(params.name)) {
					throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
				}
				const args = params.arguments || {};
				if (typeof args !== "object" || Array.isArray(args)) {
					throw new RpcError(INVALID_PARAMS, "tools/call arguments must be an object");
				}
				return ZoteroMCP.Tools.call(params.name, args);
			}
		}
		throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`, undefined, era === "modern" ? 404 : 200);
	}

	async function handleMessage(msg, era) {
		if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
			return { status: 400, body: rpcError(msg && msg.id, INVALID_REQUEST, "Invalid JSON-RPC request") };
		}
		if (isNotification(msg)) {
			return { status: 202, body: null };
		}
		try {
			const result = await dispatch(msg.method, msg.params, era);
			if (era === "modern") {
				result.resultType = "complete";
			}
			return { status: 200, body: rpcResult(msg.id, result) };
		}
		catch (e) {
			if (e instanceof RpcError) {
				return { status: e.httpStatus || 200, body: rpcError(msg.id, e.code, e.message, e.data) };
			}
			ZoteroMCP.logError(e);
			return { status: 200, body: rpcError(msg.id, INTERNAL_ERROR, "Internal error: " + e.message) };
		}
	}

	// ---------------------------------------------------------------- eras

	async function handleModern(msg, headers) {
		const version = msg.params._meta[META_VERSION];
		const headerVersion = headers["mcp-protocol-version"];
		if (headerVersion !== version) {
			return jsonResponse(400, rpcError(msg.id, HEADER_MISMATCH,
				`Header mismatch: MCP-Protocol-Version '${headerVersion || ""}' does not match body '${version}'`));
		}
		if (!MODERN_VERSIONS.includes(version)) {
			return jsonResponse(400, rpcError(msg.id, UNSUPPORTED_VERSION, "Unsupported protocol version", {
				supported: ALL_VERSIONS,
				requested: version
			}));
		}
		const headerMethod = headers["mcp-method"];
		if (headerMethod !== undefined && headerMethod !== msg.method) {
			return jsonResponse(400, rpcError(msg.id, HEADER_MISMATCH,
				`Header mismatch: Mcp-Method '${headerMethod}' does not match body '${msg.method}'`));
		}
		const headerName = headers["mcp-name"];
		const bodyName = msg.params.name !== undefined ? msg.params.name : msg.params.uri;
		if (headerName !== undefined && decodeHeaderValue(headerName) !== bodyName) {
			return jsonResponse(400, rpcError(msg.id, HEADER_MISMATCH,
				`Header mismatch: Mcp-Name value does not match body value '${bodyName}'`));
		}
		const { status, body } = await handleMessage(msg, "modern");
		return body ? jsonResponse(status, body) : [status, null, null];
	}

	function handleInitialize(msg, headers) {
		if (headers["mcp-session-id"]) {
			const existing = sessions.get(headers["mcp-session-id"]);
			if (existing) {
				sessions.delete(headers["mcp-session-id"]);
			}
		}
		const requested = msg.params && msg.params.protocolVersion;
		const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
		const sessionID = ZoteroMCP.Util.randomHex(16);
		sessions.set(sessionID, {
			version,
			client: msg.params && msg.params.clientInfo,
			created: Date.now(),
			lastSeen: Date.now()
		});
		ZoteroMCP.log(`MCP session ${sessionID.slice(0, 8)} opened (protocol ${version}, client ${JSON.stringify(msg.params && msg.params.clientInfo)})`);
		return jsonResponse(200, rpcResult(msg.id, {
			protocolVersion: version,
			capabilities: { tools: { listChanged: false } },
			serverInfo: serverInfo(),
			instructions: instructions()
		}), { "Mcp-Session-Id": sessionID });
	}

	async function handleLegacy(body, headers) {
		const sessionID = headers["mcp-session-id"];
		const first = Array.isArray(body) ? body[0] : body;

		if (!sessionID) {
			// A stray notification without a session is harmless
			if (!Array.isArray(body) && isNotification(body)) {
				return [202, null, null];
			}
			return jsonResponse(400, rpcError(first && first.id, INVALID_REQUEST,
				"Bad Request: missing Mcp-Session-Id header; send initialize first"));
		}
		const session = sessions.get(sessionID);
		if (!session) {
			return jsonResponse(404, rpcError(first && first.id, SESSION_NOT_FOUND, "Session not found; send initialize again"));
		}
		session.lastSeen = Date.now();

		const headerVersion = headers["mcp-protocol-version"];
		if (headerVersion && !LEGACY_VERSIONS.includes(headerVersion)) {
			return jsonResponse(400, rpcError(first && first.id, INVALID_REQUEST,
				`Unsupported MCP-Protocol-Version: ${headerVersion}`, { supported: ALL_VERSIONS }));
		}

		if (Array.isArray(body)) {
			// JSON-RPC batches exist only in 2025-03-26
			if (session.version !== "2025-03-26" || !body.length) {
				return jsonResponse(400, rpcError(null, INVALID_REQUEST, "JSON-RPC batches are not supported in this protocol version"));
			}
			const responses = [];
			for (const msg of body) {
				if (msg && msg.method === "initialize") {
					responses.push(rpcError(msg.id, INVALID_REQUEST, "initialize cannot be batched"));
					continue;
				}
				const { body: out } = await handleMessage(msg, "legacy");
				if (out) {
					responses.push(out);
				}
			}
			return responses.length ? jsonResponse(200, responses) : [202, null, null];
		}

		const { status, body: out } = await handleMessage(body, "legacy");
		return out ? jsonResponse(status, out) : [status, null, null];
	}

	// ---------------------------------------------------------------- HTTP

	async function handleMCP(request) {
		const headers = request.headers;
		// Web pages can reach this port; any request carrying an Origin is refused
		if (headers.origin) {
			return jsonResponse(403, rpcError(null, INVALID_REQUEST, "Forbidden: requests from web pages are not accepted"));
		}
		if (!checkAuth(headers)) {
			return unauthorized();
		}
		pruneSessions();

		if (request.method === "GET") {
			return jsonResponse(405, rpcError(null, INVALID_REQUEST, "Method Not Allowed: this server does not offer an SSE stream"), {
				"Allow": "POST, DELETE"
			});
		}

		if (request.method === "DELETE") {
			const sessionID = headers["mcp-session-id"];
			if (!sessionID) {
				return jsonResponse(400, rpcError(null, INVALID_REQUEST, "Missing Mcp-Session-Id header"));
			}
			if (!sessions.delete(sessionID)) {
				return jsonResponse(404, rpcError(null, SESSION_NOT_FOUND, "Session not found"));
			}
			return [204, null, null];
		}

		if (!acceptsJSON(headers.accept)) {
			return jsonResponse(406, rpcError(null, INVALID_REQUEST, "Not Acceptable: client must accept application/json"));
		}

		const body = request.data;
		if (body === null || body === undefined || typeof body !== "object") {
			return jsonResponse(400, rpcError(null, PARSE_ERROR, "Parse error: body must be a JSON-RPC message"));
		}

		if (!Array.isArray(body)) {
			const meta = body.params && typeof body.params === "object" && body.params._meta;
			if (meta && typeof meta === "object" && typeof meta[META_VERSION] === "string") {
				return handleModern(body, headers);
			}
			if (body.method === "initialize") {
				return handleInitialize(body, headers);
			}
		}
		return handleLegacy(body, headers);
	}

	async function handlePing(request) {
		if (request.headers.origin) {
			return jsonResponse(403, { ok: false, error: "Forbidden" });
		}
		if (!checkAuth(request.headers)) {
			return unauthorized();
		}
		const bbt = await ZoteroMCP.BBT.status({ quick: true });
		return jsonResponse(200, {
			ok: true,
			plugin: ZoteroMCP.version,
			zotero: Zotero.version,
			betterBibTeX: bbt.version || null,
			protocolVersions: ALL_VERSIONS
		});
	}

	function makeEndpoint(handler, methods) {
		const Endpoint = function () {};
		Endpoint.prototype = {
			supportedMethods: methods,
			supportedDataTypes: ["application/json"],
			permitBookmarklet: false,
			// One declared parameter selects Zotero's single-argument endpoint API
			init: function (request) {
				return handler(request).catch((e) => {
					ZoteroMCP.logError(e);
					return jsonResponse(500, rpcError(null, INTERNAL_ERROR, "Internal error: " + e.message));
				});
			}
		};
		return Endpoint;
	}

	return {
		MCP_PATH,
		PING_PATH,
		ALL_VERSIONS,

		get url() {
			let port;
			try {
				port = Zotero.Server.port;
			}
			catch (e) {
				port = Zotero.Prefs.get("httpServer.port");
			}
			return `http://127.0.0.1:${port}${MCP_PATH}`;
		},

		ensureToken() {
			if (!ZoteroMCP.Prefs.get("token", "")) {
				this.regenerateToken();
			}
			return ZoteroMCP.Prefs.get("token", "");
		},

		regenerateToken() {
			ZoteroMCP.Prefs.set("token", ZoteroMCP.Util.randomHex(24));
			sessions.clear();
			return ZoteroMCP.Prefs.get("token", "");
		},

		/**
		 * @param {String} [scope] - "local" (only the project folder it is run in) or "user" (all projects).
		 *   No "project" scope: its .mcp.json is meant to be committed and would carry the token.
		 */
		claudeCodeCommand(scope = "local") {
			if (!["local", "user"].includes(scope)) {
				throw new Error(`Unsupported Claude Code scope: ${scope}`);
			}
			return `claude mcp add -s ${scope} --transport http zotero ${this.url} --header "Authorization: Bearer ${this.ensureToken()}"`;
		},

		register() {
			this.ensureToken();
			addedStatus = [];
			for (const [code, text] of Object.entries(EXTRA_STATUS)) {
				if (!Zotero.Server.responseCodes[code]) {
					Zotero.Server.responseCodes[code] = text;
					addedStatus.push(code);
				}
			}
			Zotero.Server.Endpoints[MCP_PATH] = makeEndpoint(handleMCP, ["GET", "POST", "DELETE"]);
			Zotero.Server.Endpoints[PING_PATH] = makeEndpoint(handlePing, ["GET"]);
			ZoteroMCP.log("MCP endpoint registered at " + this.url);
		},

		unregister() {
			delete Zotero.Server.Endpoints[MCP_PATH];
			delete Zotero.Server.Endpoints[PING_PATH];
			for (const code of addedStatus) {
				delete Zotero.Server.responseCodes[code];
			}
			addedStatus = [];
			sessions.clear();
		}
	};
})();
