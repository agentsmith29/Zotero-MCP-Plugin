/* global Components, Services, ZoteroMCP */

var chromeHandle = null;

const MODULES = [
	"core.js",
	"library.js",
	"audit.js",
	"confirm.js",
	"bbt.js",
	"edit.js",
	"lookup.js",
	"destructive.js",
	"libraryTree.js",
	"fileExport.js",
	"tools.js",
	"mcpServer.js",
	"ui.js",
	"main.js"
];

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	// chrome://zotero-mcp/content/ for the export setup dialog
	const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	const manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "zotero-mcp", "content/"]]);

	for (const file of MODULES) {
		Services.scriptloader.loadSubScriptWithOptions(rootURI + "content/lib/" + file, { ignoreCache: true });
	}
	await ZoteroMCP.Main.startup({ id, version, rootURI });
}

function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	if (typeof ZoteroMCP !== "undefined") {
		ZoteroMCP.Main.shutdown();
	}
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}

function onMainWindowLoad({ window }) {
	ZoteroMCP.UI.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
	ZoteroMCP.UI.onMainWindowUnload(window);
}
