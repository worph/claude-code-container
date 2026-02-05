#!/bin/bash
set -e

# Check for required environment variables
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "Warning: ANTHROPIC_API_KEY is not set. Claude Code will require authentication."
fi

if [ -z "$AUTH_PASSWORD" ]; then
    echo "Warning: AUTH_PASSWORD is not set. Terminal will be accessible without authentication!"
fi

# Create log directory
mkdir -p /var/log/supervisor

# Ensure mounted volumes are owned by the claude user
# Named volumes may be created as root, preventing claude from writing config/history
mkdir -p /home/claude/.claude
chown -R claude:claude /home/claude/.claude /home/claude/workspace

echo "Starting Claude Code Terminal with authentication proxy..."
echo "Access the terminal at http://localhost:${PROXY_PORT:-8080}"

# Start supervisor
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
