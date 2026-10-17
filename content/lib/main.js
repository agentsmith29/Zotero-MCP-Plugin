/* global Zotero, ZoteroMCP */

// Plugin lifecycle: endpoint, settings pane, menus, notifier for the automatic folder sync.
ZoteroMCP.Main = (function () {
	let notifierID = null;
	let prefPaneID = null;
	const SYNC_EVENTS = new Set(["add", "modify", "delete", "move", "remove", "trash", "refresh"]);

	async function startup({ id, version, rootURI }) {
		ZoteroMCP.pluginID = id;
		ZoteroMCP.version = version;
		ZoteroMCP.rootURI = rootURI;
		Zotero.ZoteroMCP = ZoteroMCP;

		ZoteroMCP.Server.register();

		try {
			prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: id,
				label: ZoteroMCP.PLUGIN_NAME,
				image: rootURI + "content/icons/icon.svg",
				src: rootURI + "content/preferences.xhtml",
				scripts: [rootURI + "content/preferences.js"],
				stylesheets: [rootURI + "content/preferences.css"]
			});
		}
		catch (e) {
			ZoteroMCP.logError(e);
		}

		try {
			ZoteroMCP.UI.registerMenus();
		}
		catch (e) {
			ZoteroMCP.logError(e);
		}

		notifierID = Zotero.Notifier.registerObserver({
			notify(event, type) {
				if (SYNC_EVENTS.has(event)) {
					ZoteroMCP.FileExport.scheduleAutoSync(`${type}:${event}`);
				}
			}
		}, ["item", "collection", "collection-item", "file"], "zotero-mcp");

		for (const win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) {
				ZoteroMCP.UI.onMainWindowLoad(win);
			}
		}
		ZoteroMCP.log(`started ${version}`);
	}

	function shutdown() {
		ZoteroMCP.FileExport.cancelAutoSync();
		if (notifierID) {
			Zotero.Notifier.unregisterObserver(notifierID);
			notifierID = null;
		}
		ZoteroMCP.UI.unregisterMenus();
		for (const win of Zotero.getMainWindows()) {
			ZoteroMCP.UI.onMainWindowUnload(win);
		}
		if (prefPaneID) {
			try {
				Zotero.PreferencePanes.unregister(prefPaneID);
			}
			catch (e) {
				// Zotero removes plugin panes itself on shutdown
			}
			prefPaneID = null;
		}
		ZoteroMCP.Server.unregister();
		delete Zotero.ZoteroMCP;
	}

	return { startup, shutdown };
})();
