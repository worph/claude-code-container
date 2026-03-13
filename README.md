# Claude Code Container

A Docker container that runs [Claude Code](https://github.com/anthropics/claude-code) (Anthropic's CLI for Claude) with [ttyd](https://github.com/tsl0922/ttyd) for web-based terminal access, plus an MCP server for programmatic access, all protected by authentication.

## Features

- **Web Terminal** - Browser-based terminal access to Claude Code via ttyd
- **MCP Server** - JSON-RPC API for programmatic access from other Claude instances
- **Session Persistence** - Reconnect to your session via abduco
- **Authentication** - Login page for web UI, Bearer token for MCP
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

## Architecture

```
                    External (:8080)
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                     auth-proxy :8080                          │
│                                                               │
│  /login, /logout  →  Web authentication (cookie session)     │
│  /mcp/*           →  MCP API (Bearer token auth)             │
│  /*               →  Terminal WebSocket proxy                 │
└─────────────┬─────────────────────────────┬──────────────────┘
              │                             │
   ┌──────────▼──────────┐       ┌──────────▼──────────┐
   │    ttyd :7681       │       │  mcp-server :9090   │
   │                     │       │                     │
   │  Web Terminal       │       │  JSON-RPC 2.0 API   │
   │        │            │       │        │            │
   │        ▼            │       │        ▼            │
   │  claude (live)      │       │  claude -p -c "..." │
   │  via abduco         │       │  (one-shot)         │
   └──────────┬──────────┘       └──────────┬──────────┘
              │                             │
              └─────────────┬───────────────┘
                            ▼
               ~/.claude/projects/ (history)
               /home/claude/workspace (files)
```

**Two ways to interact:**
- **Web Terminal**: Interactive session at `http://localhost:8080` (cookie auth)
- **MCP Server**: Programmatic access at `http://localhost:8080/mcp` (Bearer token)

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
curl -X POST http://localhost:8080/mcp \
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
        "MCP_URL": "http://localhost:8080/mcp",
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
| `AUTH_PASSWORD` | Password for web login & MCP Bearer token | (required) |
| `MCP_ENABLED` | Enable/disable MCP server | `true` |
| `PROXY_PORT` | External auth proxy port | `8080` |
| `TTYD_PORT` | Internal ttyd port | `7681` |
| `MCP_PORT` | Internal MCP server port | `9090` |
| `CLAUDE_SESSION_TTL` | Session cleanup timeout (seconds) | `1800` |

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
├── auth-proxy/
│   └── server.js           # Auth proxy with MCP routing
├── mcp-server/
│   └── server.js           # MCP JSON-RPC server
├── mcp-client.js           # Stdio-to-HTTP bridge for MCP
├── scripts/
│   └── claude-session.sh   # Session wrapper with abduco
├── s6-overlay/
│   └── s6-rc.d/            # Service definitions
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
