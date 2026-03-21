# Session Architecture: Web Terminal Connection Flow

This document describes the full process chain from browser to Claude Code CLI,
how session persistence works via abduco, and known issues with disconnection handling.

## Component Overview

| Component | Role | Port | Process owner |
|---|---|---|---|
| **Caddy** (docker-proxy) | Reverse proxy with forward_auth (session cookie check via MCP `/auth`) | 8080 (external) | - |
| **ttyd** (C binary) | WebSocket-to-PTY bridge (no built-in auth — auth handled by Caddy) | 8080 (internal) | root |
| **su** | Privilege switch to `claude` user | - | root → claude |
| **claude-session.sh** | Session orchestrator: create or attach abduco session | - | claude |
| **abduco** | Detachable PTY multiplexer (like tmux, but minimal) | - | claude |
| **claude** (CLI) | Anthropic's Claude Code interactive CLI | - | claude |

## Connection Chain

```
Browser (user)
│
│  HTTPS / WSS  (port 8080)
│
▼
┌──────────────────────────────────────────────────┐
│  CADDY  (docker-proxy sidecar, host :8080)       │
│                                                  │
│  1. Browser connects to Caddy on host :8080      │
│  2. Caddy calls forward_auth → MCP server /auth  │
│  3. If no valid session cookie → redirect /login │
│  4. User submits password → MCP sets cookie      │
│  5. On valid session, Caddy proxies to ttyd      │
└──────────────┬───────────────────────────────────┘
               │
               │  HTTP reverse proxy
               │
               ▼
┌──────────────────────────────────────────────────┐
│  TTYD  (C binary, s6-managed service)            │
│                                                  │
│  Started by s6 with:                             │
│    ttyd -W -p 8080 \                             │
│      -t reconnect=3 \                            │
│      -P 30 \                                     │
│      su - claude -c "claude-session.sh"          │
│                                                  │
│  Note: No built-in auth (-c flag removed).       │
│  Authentication is handled by Caddy upstream.    │
│                                                  │
│  1. Receives proxied connection from Caddy       │
│  2. Allocates a new PTY                          │
│  3. Forks the configured command on that PTY     │
│  4. Bridges WS data ↔ PTY data                   │
│                                                  │
│  Flags:                                          │
│    -W        = writable (allow input)            │
│    -t reconnect=3  = client auto-reconnects      │
│                      after 3 seconds             │
│    -P 30     = ping interval 30s (keepalive)     │
└──────────────┬───────────────────────────────────┘
               │
               │  PTY (pts/N)
               │
               ▼
┌──────────────────────────────────────────────────┐
│  su - claude -c "claude-session.sh"              │
│                                                  │
│  Switches from root to claude user, then         │
│  executes claude-session.sh                      │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│  claude-session.sh                               │
│                                                  │
│  Decision point:                                 │
│                                                  │
│  if session_is_alive("claude-session"):           │
│  ├── YES: exec abduco -a claude-session          │
│  │        (attach as client to existing session)  │
│  │                                               │
│  └── NO:  clean stale sockets                    │
│           abduco -n claude-session claude         │
│           (create new DETACHED session)           │
│           sleep 0.3  (wait for socket)            │
│           exec abduco -a claude-session           │
│           (attach as client)                      │
│                                                  │
│  In both cases, trigger_redraw() is called       │
│  in the background to send SIGWINCH to claude    │
│  and force a terminal repaint.                   │
└──────────────┬───────────────────────────────────┘
               │
               │  exec (replaces claude-session.sh)
               │
               ▼
┌──────────────────────────────────────────────────┐
│  ABDUCO                                          │
│                                                  │
│  Two modes used by claude-session.sh:            │
│                                                  │
│  abduco -n (create detached)                     │
│  └── Server process only: holds the master PTY   │
│      where claude runs. Stays alive even when    │
│      all clients detach. No client is attached   │
│      at creation time.                           │
│                                                  │
│  abduco -a (attach only)                         │
│  └── Client process only: bridges the current    │
│      terminal (ttyd's PTY) to the server session.│
│      Multiple clients can attach simultaneously. │
│                                                  │
│  The two-step pattern (create detached, then     │
│  attach) ensures ttyd killing the client does    │
│  NOT kill the server or claude.                  │
│                                                  │
│  Abduco is the key to session persistence.       │
│  The server process + claude survive browser     │
│  disconnects because they are NOT on ttyd's PTY. │
│  They run on abduco's internal PTY.              │
└──────────────┬───────────────────────────────────┘
               │
               │  abduco's internal PTY
               │
               ▼
┌──────────────────────────────────────────────────┐
│  CLAUDE  (Claude Code CLI)                       │
│                                                  │
│  Interactive CLI session running inside           │
│  abduco's PTY. Persists across all browser       │
│  connect/disconnect cycles.                      │
│                                                  │
│  History stored in:                              │
│    ~/.claude/projects/-home-claude-workspace/    │
└──────────────────────────────────────────────────┘
```

## Process Tree (steady state, one browser connected)

```
s6-supervise (ttyd)
└── ttyd -W -p 8080 ...                         ← no -c flag; auth handled by Caddy upstream
    └── su - claude -c claude-session.sh         ← ttyd's PTY (pts/0)
        └── abduco -a claude-session              ← attach client (exec'd from claude-session.sh)

abduco -n claude-session claude                  ← abduco server (ppid=1, created detached)
└── claude                                       ← the actual CLI (on abduco's internal PTY, pts/1)
```

## Lifecycle: First Connection

```
1. Browser opens connection to Caddy on :8080
2. Caddy calls forward_auth → MCP server /auth → no session cookie → redirect to /login
3. User enters password on /login page → MCP server sets session cookie → redirect to /
4. Caddy validates session cookie via /auth → proxies to ttyd
5. ttyd allocates PTY pts/0, forks: su - claude -c claude-session.sh
6. claude-session.sh checks: no abduco session exists
7. Runs: abduco -n claude-session claude (creates detached server + claude)
8. abduco server process detaches to ppid=1
9. claude starts inside abduco's internal PTY
10. Runs: exec abduco -a claude-session (attaches client on pts/0)
11. User sees Claude Code prompt in browser
```

## Lifecycle: Disconnection

```
1. Browser closes (tab close, network drop, navigation away)
2. ttyd detects WS client gone → closes PTY pts/0
3. su process on pts/0 receives SIGHUP
4. abduco -a (attach client) loses its terminal → exits
5. su process becomes zombie (waiting to be reaped by ttyd)

Still alive:
  - abduco server process (ppid=1, not on any ttyd PTY)
  - claude process (on abduco's internal PTY)
  - Session state fully preserved
```

## Lifecycle: Reconnection

```
1. Browser opens new connection to Caddy on :8080
2. Caddy validates session cookie via forward_auth → /auth
3. Caddy proxies to ttyd; ttyd allocates NEW PTY pts/2, forks new: su - claude -c claude-session.sh
4. claude-session.sh checks: abduco session "claude-session" exists and is alive
5. Calls trigger_redraw() in background (will send SIGWINCH to claude)
6. Runs: exec abduco -a claude-session
7. abduco attaches new client to existing server session
8. claude receives SIGWINCH → redraws its UI
9. User sees their previous Claude Code session, fully intact
```

## Session Cleanup

The `session-cleanup` s6 service (`s6-overlay/s6-rc.d/session-cleanup/run`) runs
a loop every 15 seconds:

1. Checks if any abduco session exists
2. Checks if any TCP connections are established to ttyd's port (via `ss`)
3. If no clients connected, starts a TTL countdown
4. If TTL expires (default `CLAUDE_SESSION_TTL=1800` = 30 minutes):
   - Kills abduco **server** processes (ppid=1)
   - This terminates the claude process and the session
   - Next browser connection will create a fresh session

## Known Issue: Zombie Process Accumulation

**Symptom:** Each browser disconnect/reconnect cycle leaves behind stale processes:
- A zombie `[claude-session.] <defunct>` process
- A lingering `su - claude` process on the dead PTY
- A lingering `abduco -a` attach client

**Root cause:** When ttyd closes a PTY on WS disconnect:
- The `su` process receives SIGHUP but is not always reaped promptly by ttyd
- The `abduco -a` client exits but its parent (`su`) is in a zombie state
- `claude-session.sh` has already `exec`'d into `abduco -a`, so there's no
  cleanup handler in the shell script

**Impact:** After many rapid disconnect/reconnect cycles, zombie processes accumulate.
They consume negligible resources (just a PID slot) but indicate incomplete cleanup.

**Current mitigation:** The `session-cleanup` service kills abduco server processes
after TTL, but does not clean up stale attach clients or zombies.

**Potential fixes:**
1. Add periodic zombie reaping to `session-cleanup` (kill stale `su` and `abduco -a` processes)
2. Use a signal trap in `claude-session.sh` before `exec` to clean up on SIGHUP
3. Configure s6 or ttyd to better handle child process lifecycle
4. Use `--signal` flag in ttyd if available to control child cleanup behavior

## Configuration Reference

| Variable | Default | Effect on session |
|---|---|---|
| `CLAUDE_SESSION_TTL` | 1800 (30 min) | Time before abandoned session is killed |
| `PROXY_PORT` | 8080 | ttyd listen port (external) |
| `MCP_PORT` | 9090 | MCP server listen port |
| ttyd `-t reconnect=3` | 3 seconds | Client-side auto-reconnect delay |
| ttyd `-P 30` | 30 seconds | WebSocket ping interval |
| Caddy forward_auth → `/auth` | - | Session cookie validation (auth handled by MCP server, not ttyd) |
