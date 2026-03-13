# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Container is a Docker-based application that provides a web-accessible terminal interface for Claude Code. It combines four components:
- **ttyd**: Web terminal emulator
- **Auth Proxy**: Node.js authentication layer (auth-proxy/server.js)
- **MCP Server**: Model Context Protocol server for programmatic access (mcp-server/server.js)
- **Claude Code**: Anthropic's CLI tool

## Commands

### Build and Run

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with ANTHROPIC_API_KEY and AUTH_PASSWORD

# Build and run with Docker Compose
docker compose up -d

# Or build manually
docker build -t claude-code-container .
```

Access at http://localhost:8080 after starting.

### Development

```bash
# Rebuild after Dockerfile changes
docker compose up -d --build

# View logs
docker compose logs -f

# Shell into running container
docker compose exec claude-code bash
```

## Architecture

```
External (:8080)
│
▼
┌─────────────────────────────────────────────────────────────┐
│                      auth-proxy :8080                        │
│                                                              │
│  /login, /logout     →  session auth (cookie-based)         │
│  /mcp/*              →  proxy to MCP server (Bearer auth)   │
│  /*                  →  proxy to ttyd (WebSocket)           │
│  /internal/ws-status →  WebSocket count (localhost only)    │
└──────────────┬───────────────────────┬──────────────────────┘
               │                       │
    ┌──────────▼──────────┐ ┌──────────▼──────────┐
    │     ttyd :7681      │ │  mcp-server :9090   │
    │                     │ │  (runs as claude)   │
    │  Interactive TTY    │ │                     │
    │         │           │ │  JSON-RPC 2.0 API   │
    │         ▼           │ │         │           │
    │   claude-session.sh │ │         ▼           │
    │         │           │ │  claude -p -c "..." │
    │         ▼           │ │  (one-shot process) │
    │      abduco         │ │                     │
    │         │           │ │                     │
    │         ▼           │ │                     │
    │   claude (live)     │ │                     │
    └──────────┬──────────┘ └──────────┬──────────┘
               │                       │
               └───────────┬───────────┘
                           ▼
              ~/.claude/projects/ (conversation history)
```

**Web UI Flow:**
1. Browser connects to Auth Proxy on port 8080
2. Auth Proxy validates session cookie or redirects to `/login`
3. Authenticated requests proxy to ttyd on internal port 7681
4. ttyd provides terminal running Claude Code as the `claude` user
5. Session persists via abduco for reconnection

**MCP Flow:**
1. External client sends JSON-RPC request to `/mcp` with Bearer token
2. Auth Proxy validates token (AUTH_PASSWORD) and proxies to MCP server
3. MCP server spawns `claude -p -c` process for each query
4. Response streamed back as JSON-RPC result

**Process Management:**
- s6-overlay manages all services with auto-restart
- Service definitions in `s6-overlay/s6-rc.d/`
- Services: auth-proxy, ttyd, mcp-server, sshd, wetty, session-cleanup

## MCP Server

The MCP (Model Context Protocol) server allows external Claude instances to interact with this container programmatically.

### Authentication

All `/mcp/*` requests require Bearer token authentication:
```
Authorization: Bearer <AUTH_PASSWORD>
```

### Available Tools

#### `query_claude`
Send a prompt to Claude Code and get a response.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | The message to send |
| `continueSession` | boolean | No | `true` | Continue previous conversation (`-c` flag) |
| `workdir` | string | No | `/home/claude/workspace/mcp` | Working directory (determines history) |
| `timeout` | number | No | `120` | Timeout in seconds |

#### `check_status`
Check if Claude Code is available for queries.

Returns:
```json
{
  "available": true,
  "browserConnected": false,
  "queryInProgress": false
}
```

### Example Usage

**Initialize connection:**
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $AUTH_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

**List available tools:**
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $AUTH_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

**Send a query:**
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $AUTH_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"query_claude",
      "arguments":{"prompt":"Hello, what can you do?","timeout":30}
    }
  }'
```

### Claude Code MCP Client Configuration

To use this container as an MCP server from another Claude Code instance, add to `~/.claude.json`:

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

## Session & History Management

Claude Code maintains **per-directory conversation history** in `~/.claude/projects/`.

```
~/.claude/projects/
├── -home-claude-workspace/           ← Web UI conversations
│   └── <conversation-id>.jsonl
└── -home-claude-workspace-mcp/       ← MCP conversations (isolated)
    └── <conversation-id>.jsonl
```

**Key behaviors:**
- The `-c` flag continues the most recent conversation in a directory
- Web UI uses `/home/claude/workspace` → separate history from MCP
- MCP defaults to `/home/claude/workspace/mcp` → isolated history
- Use `workdir` parameter in MCP to target specific project folders

**To share history between MCP and Web UI:**
```json
{
  "prompt": "What did we discuss?",
  "workdir": "/home/claude/workspace"
}
```

## Key Files

| File | Purpose |
|------|---------|
| `auth-proxy/server.js` | HTTP proxy with login page, session management, WebSocket handling, MCP routing |
| `mcp-server/server.js` | MCP JSON-RPC server, spawns claude processes, handles timeouts |
| `mcp-client.js` | Stdio-to-HTTP bridge for using container as MCP server from Claude Code |
| `Dockerfile` | Node 22 base, compiles ttyd, installs Claude Code and MCP server |
| `s6-overlay/s6-rc.d/` | s6-overlay service definitions |
| `scripts/claude-session.sh` | Session wrapper using abduco for persistence |

## Authentication Details

**Web UI (Cookie-based):**
- Sessions stored in-memory with 24-hour expiration
- Session cookies: HttpOnly, SameSite=Strict
- Login page HTML embedded in `auth-proxy/server.js`

**MCP (Bearer token):**
- Uses `AUTH_PASSWORD` as Bearer token
- Header: `Authorization: Bearer <AUTH_PASSWORD>`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | - | Claude API key. Leave empty for OAuth |
| `AUTH_PASSWORD` | Yes | - | Password for web login and MCP Bearer token |
| `MCP_ENABLED` | No | `true` | Enable/disable MCP server for programmatic access |
| `CLAUDE_SESSION_TTL` | No | `1800` | Seconds before disconnected sessions cleanup |
| `PROXY_PORT` | No | `8080` | Auth proxy external port |
| `TTYD_PORT` | No | `7681` | Internal ttyd port |
| `MCP_PORT` | No | `9090` | Internal MCP server port |

## Data Persistence

Claude Code stores configuration in **two locations** that must both be persisted:

| Volume Mount | Purpose |
|---|---|
| `/home/claude/workspace` | Working directory for projects, files, and MCP workspace |
| `/home/claude/.claude` | Credentials, settings, history, and project metadata |
| `/home/claude/.claude.json` | Session state file with account info |

**Important:** Both `.claude/` directory AND `.claude.json` file must be mounted for authentication to persist across container restarts.

Example docker-compose volumes:
```yaml
volumes:
  - ./workspace:/home/claude/workspace
  - ./claude-config:/home/claude/.claude
  - ./claude-config/.claude.json:/home/claude/.claude.json
```

**Note:** Auth proxy sessions (web login) are in-memory and lost on restart. Claude Code auth persists via mounted volumes.

## Container Details

- Non-root user: `claude` (UID 999)
- Working directory: `/home/claude/workspace`
- MCP workspace: `/home/claude/workspace/mcp`
- Docker CLI installed for optional socket access
- ttyd theme: dark background (#1e1e1e), font size 14px

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
