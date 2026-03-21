# Claude Code Container

A Docker container that runs [Claude Code](https://github.com/anthropics/claude-code) (Anthropic's CLI for Claude) with [ttyd](https://github.com/tsl0922/ttyd) for web-based terminal access, session-based web authentication via Caddy forward_auth, plus an MCP server for programmatic access.

## Features

- **Web Terminal** - Browser-based terminal access to Claude Code via ttyd
- **MCP Server** - JSON-RPC API for programmatic access from other Claude instances
- **Session Persistence** - Reconnect to your session via abduco
- **Authentication** - Session-based login for web UI (via Caddy forward_auth), Bearer token for MCP
- **Multi-architecture** - Support for amd64 and arm64
- **Persistent Storage** - Workspace and Claude config volumes
- **Docker Access** - Optional Docker socket mounting

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/worph/claude-code-container.git
cd claude-code-container
```

### 2. Create environment file

```bash
cp .env.example .env
```

Edit `.env` and set your values:

```env
# Option 1: Use API key
ANTHROPIC_API_KEY=your-api-key-here

# Option 2: Leave empty and authenticate via OAuth in the web terminal
ANTHROPIC_API_KEY=

# Required: Password for web login and MCP Bearer token
AUTH_PASSWORD=your-secure-password-here
```

### 3. Run the container

```bash
docker compose up -d
```

Access at: `http://localhost:8080`

> **Note:** The default `docker-compose.yml` creates a container named `claude-code-app-dev` to avoid conflicts with a production `claude-code` container.

## Development

```bash
# Start the dev stack (container: claude-code-app-dev, port: 8080)
docker compose up -d --build

# View logs
docker compose logs -f

# Shell into dev container
docker exec -it claude-code-app-dev bash

# Restart after code changes (mcp-server/, scripts/ are bind-mounted)
docker compose restart

# Tear down
docker compose down
```

**Important:** Never stop or remove a container named `claude-code` — that is the production instance. `docker compose` only manages `claude-code-app-dev`.

### Networking with telegram-mcp

Both containers join `mcp-network`. From telegram-mcp, reach the dev container at:
- **Hostname:** `claude-code-app-dev`
- **MCP endpoint:** `http://claude-code-app-dev:9090/mcp`

Update telegram-mcp's `config.json` target URL accordingly:
```json
{
  "target": {
    "transport": "http",
    "url": "http://claude-code-app-dev:9090/mcp",
    "authToken": "<AUTH_PASSWORD from .env>"
  }
}
```

## Architecture

```
Browser ──→ Caddy :8080 (forward_auth) ──→ ttyd :8080 (no auth, internal)
API     ──→ mcp-server :9090 (Bearer auth, JSON-RPC, docker network only)

   ┌─────────────────┐   ┌──────────────────────┐       ┌──────────────────────┐
   │  Caddy sidecar  │   │    ttyd :8080        │       │  mcp-server :9090    │
   │  (session auth) │──→│  (no auth, internal)  │       │  (Bearer auth)       │
   │  host :8080     │   │                      │       │                      │
   └─────────────────┘   │  Web Terminal        │       │  JSON-RPC 2.0 API    │
                         │        │             │       │        │             │
                         │        ▼             │       │        ▼             │
                         │  claude (live)       │       │  claude -p -c "..."  │
                         │  via abduco          │       │  (one-shot)          │
                         └──────────┬───────────┘       └──────────┬───────────┘
                                    │                              │
                                    └──────────┬───────────────────┘
                                               ▼
                                    ~/.claude/projects/ (history)
                                    /home/claude/workspace (files)
```

**Two ways to interact:**
- **Web Terminal**: Interactive session at `http://localhost:8080` (session login at `/login`, password: `AUTH_PASSWORD`)
- **MCP Server**: Programmatic access at `http://localhost:9090/mcp` (Bearer token)

## MCP Server

The MCP (Model Context Protocol) server allows external Claude Code instances to send prompts to this container.

### Authentication

```
Authorization: Bearer <AUTH_PASSWORD>
```

### Available Tools

| Tool | Description |
|------|-------------|
| `query_claude` | Send a prompt and get a response |
| `check_status` | Check if Claude is available |

### Example: Query via curl

```bash
# Send a prompt
curl -X POST http://localhost:9090/mcp \
  -H "Authorization: Bearer $AUTH_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "query_claude",
      "arguments": {
        "prompt": "What files are in the current directory?",
        "timeout": 60
      }
    }
  }'
```

### Using from Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "claude-container": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-client.js"],
      "env": {
        "MCP_URL": "http://localhost:9090/mcp",
        "MCP_AUTH_TOKEN": "your-auth-password"
      }
    }
  }
}
```

Then use the `query_claude` and `check_status` tools from your Claude Code session.

### Session Isolation

By default, MCP uses a separate conversation history from the web terminal:

| Interface | Working Directory | History |
|-----------|------------------|---------|
| Web Terminal | `/home/claude/workspace` | Separate |
| MCP Server | `/home/claude/workspace/mcp` | Separate |

To share history, specify `workdir` in your query:
```json
{
  "prompt": "What did we discuss?",
  "workdir": "/home/claude/workspace"
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (or leave empty for OAuth) | - |
| `AUTH_PASSWORD` | Password for web login (session auth) & MCP Bearer token | - |
| `MCP_ENABLED` | Enable/disable MCP server | `true` |
| `PROXY_PORT` | ttyd external port | `8080` |
| `WETTY_PORT` | Internal wetty port | `3000` |
| `MCP_PORT` | Internal MCP server port | `9090` |
| `CLAUDE_SESSION_TTL` | Session cleanup timeout (seconds) | `1800` |
| `DISCOVERY_PORT` | UDP port for beacon auto-discovery | `9099` |

## Data Persistence

Mount these volumes to persist data across container restarts:

```yaml
volumes:
  - ./workspace:/home/claude/workspace      # Project files
  - ./claude-config:/home/claude/.claude    # Claude settings & history
  - ./claude-config/.claude.json:/home/claude/.claude.json  # Auth state
```

**Important**: Both `.claude/` directory AND `.claude.json` must be mounted for authentication to persist.

## Optional Features

### Docker Access

The Docker socket is mounted by default. To disable:

```yaml
volumes:
  - workspace:/home/claude/workspace
  # - /var/run/docker.sock:/var/run/docker.sock  # Commented out
```

> **Warning**: Docker socket access gives the container full control over Docker on your host.

### Host Network Mode

For direct access to host network interfaces:

```yaml
services:
  claude-code:
    network_mode: host
    # Remove 'ports' section when using host mode
```

## Security Considerations

1. **Always set `AUTH_PASSWORD`** - Protects both web UI and MCP API
2. **Use HTTPS in production** - Put behind a reverse proxy with TLS
3. **Protect your API key** - Never commit `.env` files
4. **Network isolation** - Consider running on a private network
5. **MCP access** - Bearer token is the same as web password

### Example: Running behind Traefik

```yaml
services:
  claude-code:
    build: .
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - AUTH_PASSWORD=${AUTH_PASSWORD}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.claude.rule=Host(`claude.example.com`)"
      - "traefik.http.routers.claude.tls.certresolver=letsencrypt"
    volumes:
      - workspace:/home/claude/workspace
      - claude-config:/home/claude/.claude
```

## Project Structure

```
.
├── Dockerfile              # Container build
├── docker-compose.yml      # Compose configuration
├── .env.example            # Environment template
├── mcp-server/
│   ├── server.js           # MCP JSON-RPC server + login/auth endpoints
│   ├── login.html          # Password-only login page for Caddy forward_auth
│   ├── mcp-announce.js     # UDP beacon auto-discovery responder
│   └── permission-mcp.js   # Stdio MCP server for permission prompts
├── mcp-client.js           # Stdio-to-HTTP bridge for MCP
├── scripts/
│   └── claude-session.sh   # Session wrapper with abduco
├── s6-overlay/
│   └── s6-rc.d/            # Service definitions
├── testplan.md             # Manual test plan
└── CLAUDE.md               # Detailed documentation
```

## Building Locally

```bash
docker build -t claude-code-container .
```

## Using Pre-built Images

```bash
docker pull ghcr.io/worph/claude-code-container:main
```

## License

MIT
