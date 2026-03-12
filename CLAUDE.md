# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Container is a Docker-based application that provides a web-accessible terminal interface for Claude Code. It combines three components:
- **ttyd**: Web terminal emulator
- **Auth Proxy**: Node.js authentication layer (auth-proxy/server.js)
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
Browser → :8080 Auth Proxy (Node.js) → :7681 ttyd → Claude Code CLI
                                    or
Browser → :3000 Wetty → :22 sshd → Claude Code CLI
```

**Request Flow:**
1. Browser connects to Auth Proxy on port 8080
2. Auth Proxy validates session cookie or redirects to `/login`
3. Authenticated requests proxy to ttyd on internal port 7681
4. ttyd provides terminal running Claude Code as the `claude` user

Alternative flow via Wetty (port 3000):
1. Wetty authenticates via sshd on localhost
2. sshd runs the claude-session.sh wrapper script
3. Session persists via abduco for reconnection

**Process Management:**
- s6-overlay manages all services with auto-restart
- Service definitions in `s6-overlay/s6-rc.d/`
- Services: auth-proxy, ttyd, sshd, wetty, session-cleanup

## Key Files

| File | Purpose |
|------|---------|
| `auth-proxy/server.js` | HTTP proxy with login page, session management, WebSocket upgrade handling |
| `Dockerfile` | Node 22 base, compiles ttyd from source, installs Claude Code globally |
| `s6-overlay/s6-rc.d/` | s6-overlay service definitions (auth-proxy, ttyd, sshd, wetty, session-cleanup) |
| `scripts/claude-session.sh` | Session wrapper using abduco for persistence |

## Authentication Details

- Sessions stored in-memory with 24-hour expiration
- Session cookies: HttpOnly, SameSite=Strict
- Login page HTML embedded in `server.js` (lines ~30-161)
- WebSocket connections require valid session for ttyd terminal access

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No | Claude API key. Leave empty to use subscription auth (OAuth) |
| `AUTH_PASSWORD` | Yes | Login password for web terminal |
| `CLAUDE_SESSION_TTL` | No | Seconds before disconnected sessions are cleaned up (default: 1800) |
| `PROXY_PORT` | No | Auth proxy port (default: 8080) |
| `TTYD_PORT` | No | Internal ttyd port (default: 7681) |

## Data Persistence

Claude Code stores configuration in **two locations** that must both be persisted:

| Volume Mount | Purpose |
|---|---|
| `/home/claude/workspace` | Working directory for projects and files |
| `/home/claude/.claude` | Directory containing credentials, settings, history, and project metadata |
| `/home/claude/.claude.json` | Session state file containing account info and feature flags |

**Important:** Both `.claude/` directory AND `.claude.json` file must be mounted for authentication to persist across container restarts. Missing the `.claude.json` file will cause Claude Code to ask for re-authentication on every restart.

Example docker-compose volumes:
```yaml
volumes:
  - ./claude-config:/home/claude/.claude
  - ./claude-config/.claude.json:/home/claude/.claude.json
```

**Note:** Auth proxy sessions (web terminal login) are stored in-memory and will be lost on container restart — you'll need to enter the web password again after a restart. This is separate from Claude Code authentication which persists via the mounted volumes.

## Container Details

- Non-root user: `claude` (UID 999)
- Working directory: `/home/claude/workspace` (persistent volume)
- Docker CLI installed for optional socket access
- ttyd theme: dark background (#1e1e1e), font size 14px
