#!/bin/bash
# Setup script for mcp-reminder.
# Generates token, creates .env, builds the plist from template.
# Run once after cloning.

set -euo pipefail
cd "$(dirname "$0")"

INSTALL_DIR="$(pwd)"
NODE_PATH="$(which node 2>/dev/null || echo '/opt/homebrew/bin/node')"

echo "=== mcp-reminder setup ==="
echo ""

# 1. Generate token and .env
if [ -f .env ]; then
  echo ".env already exists — skipping token generation."
  TOKEN=$(grep MCP_REMINDERS_TOKEN .env | cut -d= -f2)
else
  TOKEN=$(openssl rand -hex 24)
  cat > .env << EOF
MCP_REMINDERS_PORT=18800
MCP_REMINDERS_TOKEN=${TOKEN}
MCP_REMINDERS_BIND=0.0.0.0
EOF
  echo "Generated .env with new token."
fi
echo ""

# 2. Install dependencies and build
echo "Installing dependencies..."
npm install --silent
echo "Building..."
npm run build --silent
echo ""

# 3. Generate plist from template
sed -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
    -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__TOKEN__|${TOKEN}|g" \
    com.mcp-reminder.plist.template > com.mcp-reminder.plist
echo "Generated com.mcp-reminder.plist"
echo ""

# 4. Summary
echo "=== Setup complete ==="
echo ""
echo "Token: ${TOKEN}"
echo "Node:  ${NODE_PATH}"
echo "Dir:   ${INSTALL_DIR}"
echo ""
echo "Next steps:"
echo ""
echo "  # Start manually:"
echo "  source .env && export MCP_REMINDERS_PORT MCP_REMINDERS_TOKEN MCP_REMINDERS_BIND && npm start"
echo ""
echo "  # Or install as a launchd service (auto-start on boot):"
echo "  cp com.mcp-reminder.plist ~/Library/LaunchAgents/"
echo "  launchctl load ~/Library/LaunchAgents/com.mcp-reminder.plist"
echo ""
echo "  # Verify:"
echo "  curl http://127.0.0.1:18800/health"
echo ""
echo "  # Run tests:"
echo "  MCP_REMINDERS_TOKEN=${TOKEN} python3 test/functional.py"
echo ""
echo "See USAGE.md for Cloudflare Tunnel setup (required for Claude Cowork)."
