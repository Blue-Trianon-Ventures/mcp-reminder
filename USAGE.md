# mcp-reminder

MCP server that exposes Apple Reminders on macOS via the streamable-http transport. Runs on a Mac with Reminders.app access and serves remote MCP clients over HTTP/HTTPS.

## Requirements

- macOS with Reminders.app
- Node.js >= 20
- The user account running the server must have Automation permission for Reminders (granted on first osascript invocation)

## Install

```bash
git clone <repo-url> && cd mcp-reminder
npm install
npm run build
```

## Configure

All configuration is via environment variables. Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and set your token:

```bash
# Generate a secure token
openssl rand -hex 24
```

| Variable | Default | Description |
|---|---|---|
| `MCP_REMINDERS_PORT` | `18800` | HTTP/HTTPS listen port |
| `MCP_REMINDERS_BIND` | `0.0.0.0` | Bind address. Use `127.0.0.1` for local-only |
| `MCP_REMINDERS_TOKEN` | (empty) | Bearer token for auth. **Set this before exposing to network.** |
| `MCP_REMINDERS_LOG_DIR` | `./logs` | Directory for log files |
| `MCP_REMINDERS_CERT_DIR` | `./certs` | Directory containing `cert.pem` and `key.pem` for TLS |

### TLS (optional)

If `certs/cert.pem` and `certs/key.pem` exist, the server automatically starts in HTTPS mode. To generate a self-signed certificate:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=IP:127.0.0.1"
```

## Run

### Manual

```bash
source .env && export MCP_REMINDERS_PORT MCP_REMINDERS_TOKEN MCP_REMINDERS_BIND
npm start
```

### As a launchd service (auto-start on boot)

1. Generate the plist from the template:

```bash
INSTALL_DIR="$(pwd)"
NODE_PATH="$(which node)"
TOKEN="$(grep MCP_REMINDERS_TOKEN .env | cut -d= -f2)"

sed -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
    -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__TOKEN__|${TOKEN}|g" \
    com.mcp-reminder.plist.template > com.mcp-reminder.plist
```

2. Install and start:

```bash
cp com.mcp-reminder.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mcp-reminder.plist
```

3. Verify:

```bash
curl http://127.0.0.1:18800/health
# or with TLS:
curl -k https://127.0.0.1:18800/health
```

4. Stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.mcp-reminder.plist
```

The generated `com.mcp-reminder.plist` is gitignored (it contains your token).

## Endpoints

| Path | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | No | Returns `{"status":"ok"}` |
| `/mcp` | POST | Token | MCP streamable-http endpoint |
| `/mcp` | GET | Token | SSE stream for existing session |
| `/mcp` | DELETE | Token | Close a session |

Authentication is via `Authorization: Bearer <token>` header or `?token=<token>` query parameter.

## Tools

### reminders_list_lists

List all Reminders lists with item counts.

**Parameters:** none

**Returns:** `[{"name": "Shopping", "id": "F40A9B0C-...", "count": 5}]`

### reminders_get_items

Get reminders from a specific list.

| Param | Type | Required | Description |
|---|---|---|---|
| `list` | string | yes | Exact name of the Reminders list (case-sensitive) |
| `include_completed` | boolean | no | Include completed items. Default: `false` |

**Returns:** `[{"id": "x-apple-reminder://...", "name": "Buy groceries", "completed": false, "dueDate": "2026-04-15T00:00:00.000Z", "notes": "Don't forget eggs", "list": "Shopping"}]`

### reminders_add_item

Add a new reminder to a list.

| Param | Type | Required | Description |
|---|---|---|---|
| `list` | string | yes | Exact name of the Reminders list |
| `name` | string | yes | Reminder title |
| `notes` | string | no | Body/notes text |
| `due_date` | string | no | ISO 8601 date (e.g. `"2026-04-15T09:00:00Z"`) |

**Returns:** the created reminder object.

### reminders_complete_item

Mark a reminder as completed.

| Param | Type | Required | Description |
|---|---|---|---|
| `list` | string | yes | Exact name of the Reminders list |
| `item_id` | string | yes | Reminder ID from `reminders_get_items` |

**Returns:** `{"success": true, "id": "x-apple-reminder://..."}`

### reminders_uncomplete_item

Mark a completed reminder as not completed. Same parameters as `reminders_complete_item`.

### reminders_delete_item

Permanently delete a reminder. Same parameters as `reminders_complete_item`.

## Connecting MCP Clients

### Claude Code (direct LAN or local connection)

Claude Code can connect directly to the server on your LAN or localhost — no tunnel required. Add to your project's MCP config or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "reminders": {
      "type": "streamable-http",
      "url": "http://<lan-ip>:18800/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

For local-only access, use `http://127.0.0.1:18800/mcp`. Claude Code supports custom headers, so the token goes in the `Authorization` header.

### Claude Cowork (requires public HTTPS URL)

Cowork routes MCP traffic through Anthropic's cloud infrastructure, so the server **must be reachable from the internet over HTTPS**. Direct LAN or localhost URLs will not work — Cowork's validation requires a public HTTPS endpoint. A tunnel (ngrok or Cloudflare) is required.

Cowork's connector UI only accepts a name and URL (no custom headers), so the token must be passed as a query parameter.

**Steps:**

1. Expose the server via a tunnel (see [Network Access](#network-access) below)
2. In Cowork, go to project settings and add a **custom connector**
3. Enter the name (e.g., `reminders`) and the public HTTPS URL:
   ```
   https://<your-tunnel-domain>/mcp?token=<your-token>
   ```
4. Click Connect and verify the tools appear

### Client instructions prompt

Add this to your project instructions or system prompt so the AI knows how to use the tools:

```
You have access to Apple Reminders via the "reminders" MCP server.

Available tools:
- reminders_list_lists — list all Reminders lists with item counts (no params)
- reminders_get_items — read items from a list (list: string, include_completed?: boolean)
- reminders_add_item — add a reminder (list: string, name: string, notes?: string, due_date?: string ISO 8601)
- reminders_complete_item — mark done (list: string, item_id: string)
- reminders_uncomplete_item — unmark done (list: string, item_id: string)
- reminders_delete_item — permanently delete (list: string, item_id: string)

Rules:
- Call reminders_list_lists first if you don't know the exact list name. Names are case-sensitive.
- Get item_id by calling reminders_get_items first. IDs look like x-apple-reminder://UUID.
- reminders_get_items excludes completed items by default. Pass include_completed: true to see them.
- Prefer reminders_complete_item over reminders_delete_item. Only delete when explicitly asked.
```

## Network Access

### Option 1: ngrok (quick testing)

Free tier gives a random HTTPS URL. Good for setup and testing, not for permanent use (URL changes on restart).

```bash
ngrok http https://127.0.0.1:18800
```

Use the `https://*.ngrok-free.dev` URL ngrok prints. Append `?token=<your-token>` for Cowork.

### Option 2: Cloudflare Tunnel (recommended for permanent use)

Provides a stable HTTPS URL on your own domain with zero exposed ports. Requires a domain on Cloudflare (free plan). Use a dedicated domain (e.g., `mytunnels.com`) to keep your main domain's DNS untouched.

**Setup:**

1. Install cloudflared: `brew install cloudflared`

2. Authenticate: `cloudflared tunnel login` (select your domain in the browser)

3. Create a named tunnel:
   ```bash
   cloudflared tunnel create mcp-reminders
   ```
   Note the tunnel UUID printed.

4. Route DNS:
   ```bash
   cloudflared tunnel route dns mcp-reminders reminders.<your-domain>
   ```

5. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-uuid>
   credentials-file: ~/.cloudflared/<tunnel-uuid>.json

   ingress:
     - hostname: reminders.<your-domain>
       service: https://127.0.0.1:18800
       originRequest:
         noTLSVerify: true
     - service: http_status:404
   ```

6. Test: `cloudflared tunnel run mcp-reminders`

7. Install as a service (auto-starts on boot):
   ```bash
   cloudflared service install
   ```

8. Verify: `curl https://reminders.<your-domain>/health`

Your Cowork URL will be:
```
https://reminders.<your-domain>/mcp?token=<your-token>
```

To add more MCPs later, add more `hostname` entries to `config.yml` and create additional DNS routes.

## Testing

Run the functional test suite (requires server to be running):

```bash
export MCP_REMINDERS_TOKEN=<your-token>
python3 test/functional.py
```

17 assertions covering all 6 tools: auth rejection, list/add/get/complete/uncomplete/delete with verification.

## Logging

Logs are written to `MCP_REMINDERS_LOG_DIR` (default: `./logs/`).

- **Format:** `mcp-reminder-YYYY-MM-DD.log`
- **Rotation:** new file at midnight automatically
- **Retention:** files older than 7 days are deleted on rotation
- **Content:** server start/stop, session create/close, tool call timing, errors, auth failures

When running under launchd, Node.js console output goes to `logs/stdout.log` and `logs/stderr.log`.

## Architecture

```
MCP Client (Claude Code, Cowork, etc.)
  |
  | HTTPS POST /mcp (Bearer token or ?token=)
  |
  | [Optional: Cloudflare Tunnel or ngrok]
  |
mcp-reminder (Node.js, macOS)
  |
  | execFile("osascript", ["-l", "JavaScript", "-e", ...])
  |
Apple Reminders via JXA
```

JXA scripts use batch property access on collection specifiers (e.g., `list.reminders.id()` returns all IDs in one Apple Event) rather than per-item iteration, which is critical for performance when called from Node child processes.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `osascript` permission dialog on first run | macOS TCC | Click Allow; only happens once per user account |
| 401 on all requests | Wrong token | Check `MCP_REMINDERS_TOKEN` matches between server and client |
| `EADDRINUSE` on start | Port already in use | `lsof -ti :18800 \| xargs kill` or change `MCP_REMINDERS_PORT` |
| Tool returns "Reminder not found" | Stale item ID | Re-fetch items with `reminders_get_items` to get current IDs |
| Cowork can't connect | Server not publicly reachable | Set up ngrok or Cloudflare Tunnel (see Network Access) |
| Cowork rejects http:// URL | HTTPS required | Enable TLS (add certs) or use a tunnel which provides HTTPS |
