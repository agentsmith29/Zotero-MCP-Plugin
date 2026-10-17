/* global Zotero */
// Test-only endpoint: POST /zotero-mcp-test/eval {"code": "..."} runs code as an async
// function body with Zotero in scope and returns its JSON result. Same bearer token as the MCP endpoint.
const PATH = "/zotero-mcp-test/eval";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function startup() {
	const Endpoint = function () {};
	Endpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function (request) {
			const token = Zotero.Prefs.get("zoteromcp.token");
			if (!token || request.headers.authorization !== "Bearer " + token) {
				return [401, "text/plain", "Unauthorized"];
			}
			try {
				const fn = new AsyncFunction("Zotero", "IOUtils", "PathUtils", "Services", request.data.code);
				const result = await fn(Zotero, IOUtils, PathUtils, Services);
				return [200, "application/json", JSON.stringify({ ok: true, result: result === undefined ? null : result })];
			}
			catch (e) {
				return [200, "application/json", JSON.stringify({ ok: false, error: String(e), stack: e.stack })];
			}
		}
	};
	Zotero.Server.Endpoints[PATH] = Endpoint;
}

function shutdown() {
	delete Zotero.Server.Endpoints[PATH];
}

function install() {}
function uninstall() {}
