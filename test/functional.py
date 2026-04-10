#!/usr/bin/env python3
"""Functional test for mcp-reminder MCP server."""

import json
import os
import subprocess
import sys
import time
import urllib.request

PORT = os.environ.get("MCP_REMINDERS_PORT", "18800")
TOKEN = os.environ.get("MCP_REMINDERS_TOKEN", "")
if not TOKEN:
    print("FATAL: MCP_REMINDERS_TOKEN env var is required", file=sys.stderr)
    sys.exit(1)
BASE = f"http://127.0.0.1:{PORT}"
TEST_LIST = "McpReminderTest"

passed = 0
failed = 0


def p(label: str):
    global passed
    passed += 1
    print(f"  PASS: {label}")


def f(label: str, detail: str = ""):
    global failed
    failed += 1
    msg = f"  FAIL: {label}"
    if detail:
        msg += f" — {detail}"
    print(msg, file=sys.stderr)


def http_post(path: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, bytes]:
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, resp.read()
    except urllib.request.HTTPError as e:
        return e.code, e.read()


def sse_extract_text(raw: bytes) -> str:
    """Extract the text content from an MCP SSE tool response."""
    text = raw.decode()
    idx = text.find("data: ")
    if idx < 0:
        return ""
    data_str = text[idx + 6:].strip()
    try:
        envelope = json.loads(data_str)
        if "error" in envelope:
            return f"ERROR: {envelope['error']['message']}"
        return envelope["result"]["content"][0]["text"]
    except (json.JSONDecodeError, KeyError, IndexError):
        return data_str


class McpSession:
    def __init__(self):
        self.session_id = ""
        self._id = 0

    def connect(self):
        req = urllib.request.Request(
            f"{BASE}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0", "method": "initialize", "id": 1,
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1.0"}
                }
            }).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {TOKEN}",
                "Accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        self.session_id = resp.headers.get("mcp-session-id", "")
        # Send initialized notification
        urllib.request.urlopen(urllib.request.Request(
            f"{BASE}/mcp",
            data=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {TOKEN}",
                "Accept": "application/json, text/event-stream",
                "mcp-session-id": self.session_id,
            },
            method="POST",
        ))

    def call_tool(self, name: str, args: dict | None = None) -> str:
        self._id += 1
        req = urllib.request.Request(
            f"{BASE}/mcp",
            data=json.dumps({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "id": self._id,
                "params": {"name": name, "arguments": args or {}},
            }).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {TOKEN}",
                "Accept": "application/json, text/event-stream",
                "mcp-session-id": self.session_id,
            },
            method="POST",
        )
        resp = urllib.request.urlopen(req)
        return sse_extract_text(resp.read())


def create_test_list():
    subprocess.run([
        "osascript", "-e",
        f'tell application "Reminders"\n'
        f'  if not (exists list "{TEST_LIST}") then\n'
        f'    make new list with properties {{name:"{TEST_LIST}"}}\n'
        f'  end if\n'
        f'end tell',
    ], capture_output=True)
    time.sleep(3)


def delete_test_list():
    subprocess.run([
        "osascript", "-e",
        f'tell application "Reminders"\n'
        f'  if exists list "{TEST_LIST}" then\n'
        f'    delete list "{TEST_LIST}"\n'
        f'  end if\n'
        f'end tell',
    ], capture_output=True)


def main():
    global passed, failed

    print("=== mcp-reminder functional test ===\n")

    # Health check
    try:
        status, body = http_post("/health")
    except Exception:
        print("FATAL: Server not reachable")
        sys.exit(1)
    print("Server health: OK")

    # Setup
    create_test_list()
    print(f"Test list '{TEST_LIST}' ready")

    session = McpSession()
    session.connect()
    print(f"MCP session: {session.session_id}\n")

    # 1. Auth rejection
    print("1. Auth rejection")
    status, _ = http_post("/mcp", body={"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": {}},
                          headers={"Authorization": "Bearer wrong-token"})
    if status == 401:
        p("rejects invalid token")
    else:
        f(f"expected 401, got {status}")
    print()

    # 2. list_lists
    print("2. reminders_list_lists")
    lists_text = session.call_tool("reminders_list_lists")
    if TEST_LIST in lists_text:
        p("returns test list")
    else:
        f("returns test list", f"not found in: {lists_text[:100]}")
    print()

    # 3. add_item
    print("3. reminders_add_item")
    add1 = session.call_tool("reminders_add_item", {"list": TEST_LIST, "name": "Buy milk", "notes": "2% preferred"})
    if "Buy milk" in add1:
        p("returns item name")
    else:
        f("returns item name", add1[:100])
    if "2% preferred" in add1:
        p("returns notes")
    else:
        f("returns notes")
    if "x-apple-reminder://" in add1:
        p("returns id")
    else:
        f("returns id")

    try:
        item1 = json.loads(add1)
        item1_id = item1["id"]
    except (json.JSONDecodeError, KeyError):
        item1_id = ""
        f("parse item1 id")
    print(f"  Created item: {item1_id}")

    add2 = session.call_tool("reminders_add_item", {"list": TEST_LIST, "name": "Walk the dog"})
    try:
        item2_id = json.loads(add2)["id"]
    except (json.JSONDecodeError, KeyError):
        item2_id = ""
        f("parse item2 id")
    print(f"  Created item: {item2_id}")
    print()

    # 4. get_items
    print("4. reminders_get_items (exclude completed)")
    items = session.call_tool("reminders_get_items", {"list": TEST_LIST, "include_completed": False})
    if "Buy milk" in items:
        p("contains Buy milk")
    else:
        f("contains Buy milk")
    if "Walk the dog" in items:
        p("contains Walk the dog")
    else:
        f("contains Walk the dog")
    print()

    # 5. complete_item
    print("5. reminders_complete_item")
    if item1_id:
        comp = session.call_tool("reminders_complete_item", {"list": TEST_LIST, "item_id": item1_id})
        if '"success": true' in comp or '"success":true' in comp:
            p("success true")
        else:
            f("success true", comp[:100])

        items2 = session.call_tool("reminders_get_items", {"list": TEST_LIST, "include_completed": False})
        if "Buy milk" not in items2:
            p("Buy milk excluded when completed")
        else:
            f("Buy milk excluded when completed")
        if "Walk the dog" in items2:
            p("Walk the dog still present")
        else:
            f("Walk the dog still present")

        items3 = session.call_tool("reminders_get_items", {"list": TEST_LIST, "include_completed": True})
        if "Buy milk" in items3:
            p("Buy milk included with flag")
        else:
            f("Buy milk included with flag")
    else:
        f("skipped — no item1_id")
    print()

    # 6. uncomplete_item
    print("6. reminders_uncomplete_item")
    if item1_id:
        uncomp = session.call_tool("reminders_uncomplete_item", {"list": TEST_LIST, "item_id": item1_id})
        if '"success": true' in uncomp or '"success":true' in uncomp:
            p("uncomplete success")
        else:
            f("uncomplete success", uncomp[:100])

        items4 = session.call_tool("reminders_get_items", {"list": TEST_LIST, "include_completed": False})
        if "Buy milk" in items4:
            p("Buy milk back after uncomplete")
        else:
            f("Buy milk back after uncomplete")
    else:
        f("skipped — no item1_id")
    print()

    # 7. delete_item
    print("7. reminders_delete_item")
    if item1_id:
        del1 = session.call_tool("reminders_delete_item", {"list": TEST_LIST, "item_id": item1_id})
        if '"success": true' in del1 or '"success":true' in del1:
            p("delete item 1")
        else:
            f("delete item 1", del1[:100])
    if item2_id:
        del2 = session.call_tool("reminders_delete_item", {"list": TEST_LIST, "item_id": item2_id})
        if '"success": true' in del2 or '"success":true' in del2:
            p("delete item 2")
        else:
            f("delete item 2", del2[:100])

    items5 = session.call_tool("reminders_get_items", {"list": TEST_LIST, "include_completed": True})
    if "Buy milk" not in items5:
        p("Buy milk deleted")
    else:
        f("Buy milk deleted")
    if "Walk the dog" not in items5:
        p("Walk the dog deleted")
    else:
        f("Walk the dog deleted")
    print()

    # Cleanup
    delete_test_list()
    print("Test list cleaned up")

    print(f"\n=== Results: {passed} passed, {failed} failed ===")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
