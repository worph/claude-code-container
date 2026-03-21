# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Container is a Docker-based application that provides a web-accessible terminal interface for Claude Code. It combines three components:
- **ttyd**: Web terminal emulator (no built-in auth — authentication is handled externally by a reverse proxy)
- **MCP Server**: Model Context Protocol server for programmatic access (mcp-server/server.js)
- **Claude Code**: Anthropic's CLI tool

## WARNING: Container Naming — READ THIS FIRST

> **NEVER touch, stop, restart, or remove the `claude-code` container.** That is the **production container** — it is the container you (Claude Code) are currently running inside. Restarting or removing it will kill your own process and the user's session.
>
> Always use `docker-compose.yml` which creates a container named **`claude-code-app-dev`**.

## Dev Stack

Use `docker-compose.yml` for development and testing. It creates a container named `claude-code-app-dev`.

```bash
cd /c/workspace/Sandbox/claude-code-container

# Start
docker compose up -d --build

# Logs
docker compose logs -f

# Shell
docker exec -it claude-code-app-dev bash

# Restart
docker compose restart

# Stop
docker compose down
```

- **Container name:** `claude-code-app-dev` (+ `claude-code-caddy` sidecar)
- **Ports:** `8080` (host) → Caddy → ttyd (basic auth), `9090` (host) → MCP server (Bearer auth)
- **Docker networks:** `mcp-network` and `mcp-net` (both external, shared with telegram-mcp and beacon aggregator)
- **MCP endpoint from other containers:** `http://claude-code-app-dev:9090/mcp`
- **Bind-mounts:** `mcp-server/`, `scripts/` for live editing (no rebuild needed for JS/script changes, just restart the service)
- **No test suite or linter** — there are no tests or linting configured for this project. Validate changes manually via the debugging commands below.

## Editing Node.js Code

`mcp-server/` is plain CommonJS Node.js (no TypeScript, no build step) with zero npm dependencies.

To iterate on JS changes:
1. Edit the file on the host (bind-mounted)
2. Restart the specific service: `docker exec claude-code-app-dev s6-svc -r /run/service/mcp-server`
3. Check logs: `docker compose logs -f`

## Architecture

```
Browser ──→ Caddy :8080 (basic auth) ──→ ttyd :8080 (no auth, internal)
API     ──→ mcp-server :9090 (Bearer auth, JSON-RPC)

┌─────────────────┐   ┌──────────────────────────┐  ┌──────────────────────────┐
│  Caddy sidecar  │   │     ttyd :8080           │  │  mcp-server :9090        │
│  (basic auth)   │──→│  (no auth, internal)     │  │  (Bearer auth)           │
│  host :8080     │   │                          │  │                          │
└─────────────────┘   │  Interactive TTY         │  │  JSON-RPC 2.0 API        │
                      │         │                │  │         │                │
                      │         ▼                │  │         ▼                │
                      │   claude-session.sh      │  │  claude -p -c "..."      │
                      │         │                │  │  (one-shot process)      │
                      │         ▼                │  │                          │
                      │      abduco              │  │                          │
                      │         │                │  │                          │
                      │         ▼                │  │                          │
                      │   claude (live)          │  │                          │
                      └──────────┬───────────────┘  └──────────┬───────────────┘
                                 │                             │
                                 └──────────┬──────────────────┘
                                            ▼
                               ~/.claude/projects/ (conversation history)
```

**The container itself has no web authentication.** Auth is handled by an external reverse proxy:
- **Dev stack:** Caddy sidecar in docker-compose (basic auth)
- **Production:** External Caddy with Docker label plugin

**Web UI Flow:**
1. Browser connects to Caddy on host port 8080
2. Caddy prompts for basic auth (username: `claude`, password: `AUTH_PASSWORD`)
3. Caddy proxies to ttyd inside the container (no auth, internal only)
4. ttyd provides terminal running Claude Code as the `claude` user
5. Session persists via abduco for reconnection

**MCP Flow:**
1. External client sends JSON-RPC request to `:9090/mcp` with Bearer token
2. MCP server validates token (AUTH_PASSWORD)
3. MCP server spawns `claude -p -c` process for each query
4. Response streamed back as JSON-RPC result

**Process Management (s6-overlay):**
- s6-overlay manages all services with auto-restart
- Service definitions in `s6-overlay/s6-rc.d/`
- Startup order: `init-permissions` (oneshot) → `sshd` → `ttyd`, `mcp-server`, `wetty`, `session-cleanup` (all longrun)
- Services run as `claude` user except sshd (root)
- Two terminal backends exist: **ttyd** (direct PTY, port 8080) and **wetty** (SSH-based, port 3000)
- To modify a service: edit the `run` script in `s6-overlay/s6-rc.d/<service>/`, then rebuild or restart the service inside the container

## Debugging

```bash
# View all service logs
docker compose logs -f

# View specific service logs inside container
docker exec claude-code-app-dev s6-rc -a list   # List services

# Check MCP server directly (from inside container)
docker exec claude-code-app-dev curl -s http://localhost:9090/mcp/status

# Check active browser connections
docker exec claude-code-app-dev ss -tn state established sport = :8080

# Restart a specific service inside container
docker exec claude-code-app-dev s6-svc -r /run/service/mcp-server
docker exec claude-code-app-dev s6-svc -r /run/service/ttyd
```

## MCP Server

The MCP (Model Context Protocol) server allows external Claude instances to interact with this container programmatically. Auth: `Authorization: Bearer <AUTH_PASSWORD>`

### Tools

| Tool | Description |
|------|-------------|
| `query_claude` | Send prompt to Claude Code. Params: `prompt` (required), `continueSession` (default: true), `workdir` (default: `/home/claude/workspace/mcp`), `timeout` (default: 120s), `chatId` (Telegram chat ID for permission prompts), `permissionCallbackUrl` (REST endpoint for permission prompts), `permission` (array of tools to allow without prompts, e.g. `["Bash", "Read"]`, maps to `--allowedTools`) |
| `check_status` | Returns `{available, browserConnected, queryInProgress}` |

### Interactive Permission Prompts

When `query_claude` is called with a `chatId` parameter, Claude will request user permission via Telegram inline keyboard buttons before executing potentially dangerous operations (bash commands, file writes, etc.).

**Requirements:**
- Provide `chatId` and `permissionCallbackUrl` in the query_claude call
- The callback URL must point to a REST endpoint that accepts permission requests (e.g., `http://telegram-mcp:8080/api/permission`)

**Flow:**
1. External service calls `query_claude` with `chatId` and `permissionCallbackUrl`
2. When Claude needs permission, `permission-mcp.js` sends a `POST` to the callback URL
3. User sees inline keyboard with Allow/Deny/Always Allow buttons
4. User's decision is returned as plain JSON `{queryId, decision, timedOut}`
5. Claude continues or aborts based on decision

### Quick Test

```bash
# Test MCP is responding
curl -X POST http://localhost:9090/mcp \
  -H "Authorization: Bearer $AUTH_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Send a query
curl -X POST http://localhost:9090/mcp \
  -H "Authorization: Bearer $AUTH_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_claude","arguments":{"prompt":"ls","timeout":30}}}'
```

### Using as MCP Server from Claude Code

Add to `~/.claude.json` to use `mcp-client.js` as a stdio-to-HTTP bridge:

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

## Session & History

Claude Code stores per-directory history in `~/.claude/projects/`. The directory path is mangled (slashes → dashes):
- Web UI: `-home-claude-workspace/` (from `/home/claude/workspace`)
- MCP: `-home-claude-workspace-mcp/` (from `/home/claude/workspace/mcp`)

Use MCP's `workdir` parameter to share history with web UI: `"workdir": "/home/claude/workspace"`

## Key Files

| File | Purpose |
|------|---------|
| `mcp-server/server.js` | JSON-RPC 2.0 server, spawns `claude -p -c` processes, tracks query state |
| `mcp-server/permission-mcp.js` | Stdio MCP server for permission prompts, forwards to telegram-mcp |
| `mcp-server/mcp-announce.js` | UDP discovery responder for beacon protocol auto-registration |
| `mcp-client.js` | Stdio-to-HTTP bridge for Claude Code MCP client integration |
| `scripts/claude-session.sh` | abduco wrapper: kills existing clients, triggers SIGWINCH for redraw |
| `s6-overlay/s6-rc.d/` | Service definitions (oneshot: init-permissions; longrun: others) |

## Authentication

- **Web UI**: No built-in auth — the container exposes ttyd without authentication. In the dev stack, a Caddy sidecar provides basic auth. In production, use an external reverse proxy (Caddy with Docker labels, Traefik, nginx, etc.).
- **MCP**: `Authorization: Bearer <AUTH_PASSWORD>` header (self-authenticated)
- `AUTH_PASSWORD` is used by Caddy (dev stack) and the MCP server

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | - | Claude API key. Leave empty for OAuth |
| `AUTH_PASSWORD` | No | - | MCP Bearer token. Also used by Caddy sidecar (dev stack) for basic auth. |
| `MCP_ENABLED` | No | `true` | Enable/disable MCP server for programmatic access |
| `CLAUDE_SESSION_TTL` | No | `1800` | Seconds before disconnected sessions cleanup |
| `PROXY_PORT` | No | `8080` | ttyd external port |
| `WETTY_PORT` | No | `3000` | Internal wetty port |
| `MCP_PORT` | No | `9090` | Internal MCP server port |
| `DISCOVERY_PORT` | No | `9099` | UDP port for beacon auto-discovery (MCP server announces itself to aggregators) |

## Beacon Auto-Discovery

The MCP server includes a UDP discovery responder (`mcp-server/mcp-announce.js`) that responds to beacon protocol discovery requests. When an aggregator sends a UDP `discovery` message, the MCP server announces its tools and endpoint. On discovery, it automatically runs `claude mcp add beacon --transport http <url>` to register the discovered beacon as an MCP server for Claude Code sessions. Previously registered URLs are tracked in-memory to avoid duplicates.

## Data Persistence

**Required volumes for auth persistence:**
```yaml
volumes:
  - ./workspace:/home/claude/workspace          # Project files
  - ./claude-config:/home/claude/.claude        # Settings, history, credentials
  - ./claude-config/.claude.json:/home/claude/.claude.json  # Session state
```

Both `.claude/` and `.claude.json` must be mounted.

## Container Details

- User: `claude` (auto-assigned UID), member of `docker` group (GID 999)
- Workdir: `/home/claude/workspace`, MCP: `/home/claude/workspace/mcp`
- Memory: limited to 1GB, Node heap limited to 64MB (`NODE_OPTIONS="--max-old-space-size=64"`)

## CI/CD

GitHub Actions workflow (`.github/workflows/docker-build.yml`) builds multi-arch images (amd64/arm64) on push to `main` or version tags. Images published to `ghcr.io/worph/claude-code-container`.

```bash
# Build locally
docker build -t claude-code-container .

# Pull pre-built
docker pull ghcr.io/worph/claude-code-container:main
```

## Dockerfile Build Stages

1. **builder** (node:22-bookworm): Compiles ttyd 1.7.7 from source
2. **runtime** (node:22-slim): Installs s6-overlay, runtime deps, Docker CLI, wetty, abduco, Claude Code CLI, then copies mcp-server with `npm install --omit=dev`
## Error Codes (MCP)

| Code | HTTP | Description |
|------|------|-------------|
| - | 503 | MCP server is disabled (MCP_ENABLED=false) |
| -32700 | 400 | Parse error - invalid JSON |
| -32600 | 400 | Invalid request |
| -32601 | 404 | Method not found |
| -32602 | 400 | Invalid params |
| -32603 | 500 | Internal error |
| -32001 | 401 | Unauthorized |
| -32002 | 409 | Browser session active (if enabled) |
| -32003 | 409 | Query already in progress |
| -32004 | 408 | Query timeout |
