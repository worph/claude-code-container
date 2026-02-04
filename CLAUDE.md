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
```

**Request Flow:**
1. Browser connects to Auth Proxy on port 8080
2. Auth Proxy validates session cookie or redirects to `/login`
3. Authenticated requests proxy to ttyd on internal port 7681
4. ttyd provides terminal running Claude Code as the `claude` user

**Process Management:**
- Supervisor runs both ttyd and auth-proxy with auto-restart
- Configuration in `supervisord.conf`

## Key Files

| File | Purpose |
|------|---------|
| `auth-proxy/server.js` | HTTP proxy with login page, session management, WebSocket upgrade handling |
| `Dockerfile` | Node 22 base, compiles ttyd from source, installs Claude Code globally |
| `supervisord.conf` | Process supervision for ttyd and auth-proxy |
| `entrypoint.sh` | Container startup, validates environment variables |

## Authentication Details

- Sessions stored in-memory with 24-hour expiration
- Session cookies: HttpOnly, SameSite=Strict
- Login page HTML embedded in `server.js` (lines ~30-161)
- WebSocket connections require valid session for ttyd terminal access

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `AUTH_PASSWORD` | Yes | Login password |
| `PROXY_PORT` | No | Auth proxy port (default: 8080) |
| `TTYD_PORT` | No | Internal ttyd port (default: 7681) |

## Container Details

- Non-root user: `claude` (UID 999)
- Working directory: `/home/claude/workspace` (persistent volume)
- Docker CLI installed for optional socket access
- ttyd theme: dark background (#1e1e1e), font size 14px
