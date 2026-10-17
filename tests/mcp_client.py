"""Minimal MCP client for the end-to-end tests (standard library only)."""

import json
import os
import urllib.error
import urllib.request

PORT = int(os.environ.get("TEST_PORT", "23129"))
TOKEN = os.environ.get("TEST_TOKEN", "test-token-0123456789abcdef")
BASE = f"http://127.0.0.1:{PORT}"
MCP_URL = f"{BASE}/zotero-mcp/mcp"
MODERN = "2026-07-28"


class HTTPResult:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.body = body

    def json(self):
        return json.loads(self.body) if self.body else None


def http(method, url, body=None, headers=None, token=TOKEN, timeout=600):
    data = None
    hdrs = {"Accept": "application/json, text/event-stream"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return HTTPResult(resp.status, dict(resp.headers), resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return HTTPResult(e.code, dict(e.headers), e.read().decode("utf-8"))


def evaluate(code):
    """Runs JavaScript in the test Zotero via the test helper plugin."""
    res = http("POST", f"{BASE}/zotero-mcp-test/eval", {"code": code})
    payload = res.json()
    if not payload or not payload.get("ok"):
        raise RuntimeError(f"eval failed: {payload}")
    return payload["result"]


class ToolFailed(Exception):
    def __init__(self, text):
        super().__init__(text)
        self.text = text
        try:
            self.data = json.loads(text)
        except ValueError:
            self.data = None


class LegacySession:
    """Initialize-based session (protocol 2025-03-26 .. 2025-11-25)."""

    def __init__(self, version="2025-06-18"):
        self.version = version
        self.session_id = None
        self.next_id = 1
        res = self.request("initialize", {
            "protocolVersion": version,
            "capabilities": {},
            "clientInfo": {"name": "e2e-tests", "version": "1"},
        }, raw=True)
        assert res.status == 200, res.body
        self.session_id = res.headers["mcp-session-id"]
        self.init_result = res.json()["result"]
        self.version = self.init_result["protocolVersion"]
        note = self.notify("notifications/initialized")
        assert note.status == 202, note.status

    def headers(self):
        h = {"MCP-Protocol-Version": self.version}
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def request(self, method, params=None, raw=False):
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        self.next_id += 1
        if params is not None:
            msg["params"] = params
        res = http("POST", MCP_URL, msg, self.headers())
        if raw:
            return res
        payload = res.json()
        if "error" in payload:
            raise RuntimeError(f"{method}: {payload['error']}")
        return payload["result"]

    def notify(self, method):
        return http("POST", MCP_URL, {"jsonrpc": "2.0", "method": method}, self.headers())

    def tool(self, name, args=None, expect_error=False):
        result = self.request("tools/call", {"name": name, "arguments": args or {}})
        text = result["content"][0]["text"]
        if result.get("isError"):
            if expect_error:
                return ToolFailed(text)
            raise ToolFailed(f"{name}: {text}")
        if expect_error:
            raise AssertionError(f"{name} unexpectedly succeeded: {text[:300]}")
        try:
            return json.loads(text)
        except ValueError:
            return text

    def confirm(self, name, args):
        """Runs a two-phase tool: preview, then execute with the confirmation_id."""
        preview = self.tool(name, args)
        assert preview["phase"] == "preview", preview
        done = self.tool(name, dict(args, confirmation_id=preview["confirmation_id"]))
        assert done["phase"] == "executed", done
        return preview["preview"], done["result"]

    def close(self):
        return http("DELETE", MCP_URL, None, self.headers())


def modern_request(method, params=None, msg_id=1, headers=None, version=MODERN):
    """Stateless request (protocol 2026-07-28)."""
    params = dict(params or {})
    params["_meta"] = {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": {"name": "e2e-tests", "version": "1"},
        "io.modelcontextprotocol/clientCapabilities": {},
    }
    h = {"MCP-Protocol-Version": version, "Mcp-Method": method}
    if "name" in params:
        h["Mcp-Name"] = params["name"]
    h.update(headers or {})
    return http("POST", MCP_URL, {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}, h)
