"""Milestone 1: authenticated endpoint, both protocol eras, tool list, per-tool switches."""

import unittest

from mcp_client import (MCP_URL, BASE, PORT, LegacySession, evaluate, http, modern_request)

DEFAULT_OFF = {"set_bbt_settings", "sync_library_folder"}
ALL_TOOLS = {
    "search_items", "get_item", "list_collections", "get_library_tree", "get_citekeys",
    "export_bibliography", "get_bbt_settings", "find_duplicates", "create_item",
    "add_by_identifier", "update_item", "set_citekey", "find_pdf", "add_to_collections",
    "remove_from_collections", "move_items", "create_collection", "rename_collection",
    "move_collection", "apply_library_tree", "merge_items", "trash_items",
    "delete_collection", "set_bbt_settings", "export_files", "sync_library_folder",
}


def set_tool(name, enabled):
    evaluate(f"Zotero.Prefs.set('zoteromcp.tools.{name}', {'true' if enabled else 'false'}); return true;")


class Security(unittest.TestCase):
    def test_missing_token(self):
        res = http("POST", MCP_URL, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token=None)
        self.assertEqual(res.status, 401)
        self.assertIn("bearer", res.headers.get("www-authenticate", "").lower())

    def test_wrong_token(self):
        res = http("POST", MCP_URL, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, token="nope")
        self.assertEqual(res.status, 401)

    def test_origin_rejected(self):
        # Zotero's server drops requests with an Origin before our handler (no response at all),
        # or our handler answers 403; either way nothing is served.
        try:
            res = http("POST", MCP_URL, {"jsonrpc": "2.0", "id": 1, "method": "ping"},
                       {"Origin": "https://evil.example"})
            self.assertEqual(res.status, 403)
        except Exception as e:  # connection closed without response
            self.assertIn("RemoteDisconnected", type(e).__name__ + str(e))

    def test_wrong_content_type(self):
        import urllib.request
        req = urllib.request.Request(MCP_URL, data=b"ping", method="POST", headers={
            "Content-Type": "text/plain", "Authorization": "Bearer test-token-0123456789abcdef"})
        try:
            urllib.request.urlopen(req, timeout=10)
            self.fail("text/plain was accepted")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_accept_header(self):
        res = http("POST", MCP_URL, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                   {"Accept": "text/html"})
        self.assertEqual(res.status, 406)

    def test_get_is_405(self):
        res = http("GET", MCP_URL)
        self.assertEqual(res.status, 405)

    def test_ping_endpoint(self):
        res = http("GET", f"{BASE}/zotero-mcp/ping")
        self.assertEqual(res.status, 200)
        self.assertTrue(res.json()["ok"])
        self.assertEqual(http("GET", f"{BASE}/zotero-mcp/ping", token=None).status, 401)


class LegacyEra(unittest.TestCase):
    def test_versions(self):
        for version in ["2025-03-26", "2025-06-18", "2025-11-25"]:
            s = LegacySession(version)
            self.assertEqual(s.init_result["protocolVersion"], version)
            self.assertEqual(s.request("ping"), {})
            s.close()

    def test_unknown_version_negotiates_latest(self):
        s = LegacySession("2024-11-05")
        self.assertEqual(s.init_result["protocolVersion"], "2025-11-25")

    def test_session_required(self):
        res = http("POST", MCP_URL, {"jsonrpc": "2.0", "id": 5, "method": "tools/list"})
        self.assertEqual(res.status, 400)

    def test_unknown_session_404(self):
        res = http("POST", MCP_URL, {"jsonrpc": "2.0", "id": 5, "method": "tools/list"},
                   {"Mcp-Session-Id": "deadbeef"})
        self.assertEqual(res.status, 404)

    def test_delete_ends_session(self):
        s = LegacySession()
        self.assertEqual(s.close().status, 204)
        res = s.request("ping", raw=True)
        self.assertEqual(res.status, 404)

    def test_notification_202(self):
        s = LegacySession()
        res = s.notify("notifications/cancelled")
        self.assertEqual(res.status, 202)
        self.assertEqual(res.body, "")

    def test_batch_2025_03_26(self):
        s = LegacySession("2025-03-26")
        batch = [{"jsonrpc": "2.0", "id": 10, "method": "ping"},
                 {"jsonrpc": "2.0", "method": "notifications/initialized"},
                 {"jsonrpc": "2.0", "id": 11, "method": "tools/list"}]
        res = http("POST", MCP_URL, batch, s.headers())
        self.assertEqual(res.status, 200)
        ids = sorted(r["id"] for r in res.json())
        self.assertEqual(ids, [10, 11])
        s2 = LegacySession("2025-06-18")
        self.assertEqual(http("POST", MCP_URL, batch, s2.headers()).status, 400)

    def test_unknown_method(self):
        s = LegacySession()
        res = s.request("resources/list", raw=True)
        self.assertEqual(res.json()["error"]["code"], -32601)

    def test_tools_list(self):
        s = LegacySession()
        tools = s.request("tools/list")["tools"]
        names = {t["name"] for t in tools}
        self.assertEqual(names, ALL_TOOLS - DEFAULT_OFF)
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertIn("readOnlyHint", t["annotations"])

    def test_unknown_tool_is_protocol_error(self):
        s = LegacySession()
        res = s.request("tools/call", {"name": "nope", "arguments": {}}, raw=True)
        self.assertEqual(res.json()["error"]["code"], -32602)


class ModernEra(unittest.TestCase):
    def test_discover(self):
        res = modern_request("server/discover")
        self.assertEqual(res.status, 200)
        result = res.json()["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertIn("2026-07-28", result["supportedVersions"])
        self.assertIn("tools", result["capabilities"])
        self.assertNotIn("mcp-session-id", res.headers)

    def test_tools_list_and_call(self):
        res = modern_request("tools/list")
        self.assertEqual(res.json()["result"]["resultType"], "complete")
        res = modern_request("tools/call", {"name": "list_collections", "arguments": {}})
        result = res.json()["result"]
        self.assertFalse(result["isError"])
        self.assertEqual(result["resultType"], "complete")

    def test_header_mismatch(self):
        res = modern_request("tools/list", headers={"MCP-Protocol-Version": "2025-06-18"})
        self.assertEqual(res.status, 400)
        self.assertEqual(res.json()["error"]["code"], -32020)
        res = modern_request("tools/list", headers={"Mcp-Method": "tools/call"})
        self.assertEqual(res.json()["error"]["code"], -32020)
        res = modern_request("tools/call", {"name": "list_collections", "arguments": {}},
                             headers={"Mcp-Name": "get_item"})
        self.assertEqual(res.json()["error"]["code"], -32020)

    def test_base64_name_header(self):
        res = modern_request("tools/call", {"name": "list_collections", "arguments": {}},
                             headers={"Mcp-Name": "=?base64?bGlzdF9jb2xsZWN0aW9ucw==?="})
        self.assertEqual(res.status, 200)

    def test_unsupported_version(self):
        res = modern_request("tools/list", version="2099-01-01")
        self.assertEqual(res.status, 400)
        error = res.json()["error"]
        self.assertEqual(error["code"], -32022)
        self.assertIn("2026-07-28", error["data"]["supported"])

    def test_unknown_method_404(self):
        res = modern_request("resources/list")
        self.assertEqual(res.status, 404)
        self.assertEqual(res.json()["error"]["code"], -32601)


class ToolSwitches(unittest.TestCase):
    def tearDown(self):
        set_tool("list_collections", True)

    def test_disable_hides_and_refuses(self):
        s = LegacySession()
        set_tool("list_collections", False)
        names = {t["name"] for t in s.request("tools/list")["tools"]}
        self.assertNotIn("list_collections", names)
        failed = s.tool("list_collections", expect_error=True)
        self.assertIn("has been disabled by the user in Zotero settings", failed.text)

    def test_enable_default_off_tool(self):
        s = LegacySession()
        try:
            set_tool("set_bbt_settings", True)
            names = {t["name"] for t in s.request("tools/list")["tools"]}
            self.assertIn("set_bbt_settings", names)
        finally:
            set_tool("set_bbt_settings", False)

    def test_argument_validation(self):
        s = LegacySession()
        failed = s.tool("list_collections", {"bogus": 1}, expect_error=True)
        self.assertIn("unknown argument 'bogus'", failed.text)
        failed = s.tool("get_citekeys", {}, expect_error=True)
        self.assertIn("missing required argument 'keys'", failed.text)

    def test_group_library_rejected(self):
        s = LegacySession()
        failed = s.tool("list_collections", {"library_id": 2}, expect_error=True)
        self.assertIn("group libraries are out of scope", failed.text)


class SettingsPane(unittest.TestCase):
    def test_pane(self):
        r = evaluate("""
            const pane = Zotero.PreferencePanes.pluginPanes.find(p => p.pluginID === "zotero-mcp@agentsmith29.github.io");
            const win = Zotero.Utilities.Internal.openPreferences(pane.id);
            let doc;
            for (let i = 0; i < 75; i++) {
                await Zotero.Promise.delay(200);
                doc = win.document;
                if (doc && doc.getElementById("zmcp-command-user") && doc.getElementById("zmcp-command-user").value) break;
            }
            const boxes = [...doc.querySelectorAll("#zmcp-tools input[type=checkbox]")];
            const box = boxes.find(b => b.parentNode.querySelector("code").textContent === "find_pdf");
            box.click();
            const toggled = Zotero.Prefs.get("zoteromcp.tools.find_pdf");
            box.click();
            const out = {
                endpoint: doc.getElementById("zmcp-endpoint").value,
                local: doc.getElementById("zmcp-command-local").value,
                user: doc.getElementById("zmcp-command-user").value,
                boxes: boxes.length,
                checked: boxes.filter(b => b.checked).length,
                toggled,
                restored: Zotero.Prefs.get("zoteromcp.tools.find_pdf"),
                token: Zotero.Prefs.get("zoteromcp.token")
            };
            win.close();
            return out;
        """)
        url = f"http://127.0.0.1:{PORT}/zotero-mcp/mcp"
        self.assertEqual(r["endpoint"], url)
        header = f'--header "Authorization: Bearer {r["token"]}"'
        self.assertEqual(r["local"], f"claude mcp add -s local --transport http zotero {url} {header}")
        self.assertEqual(r["user"], f"claude mcp add -s user --transport http zotero {url} {header}")
        self.assertEqual((r["boxes"], r["checked"]), (26, 24))
        self.assertEqual((r["toggled"], r["restored"]), (False, True))


if __name__ == "__main__":
    unittest.main()
