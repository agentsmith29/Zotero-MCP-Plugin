"""Reloads the plugin from source in the running test Zotero (disable + enable)."""

from mcp_client import evaluate

if __name__ == "__main__":
    print(evaluate("""
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const addon = await AddonManager.getAddonByID("zotero-mcp@agentsmith29.github.io");
        await addon.disable();
        await addon.enable();
        await Zotero.Promise.delay(500);
        return { active: addon.isActive, version: addon.version, plugin: !!Zotero.ZoteroMCP };
    """))
