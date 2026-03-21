# Session Architecture: Web Terminal Connection Flow

This document describes the full process chain from browser to Claude Code CLI,
how session persistence works via abduco, and known issues with disconnection handling.

## Component Overview

| Component | Role | Port | Process owner |
|---|---|---|---|
| **ttyd** (C binary) | WebSocket-to-PTY bridge with basic auth | 8080 (external) | root |
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
│  TTYD  (C binary, s6-managed service)            │
│                                                  │
│  Started by s6 with:                             │
│    ttyd -W -p 8080 -c claude:$AUTH_PASSWORD \    │
│      -t reconnect=3 \                            │
│      -P 30 \                                     │
│      su - claude -c "claude-session.sh"          │
│                                                  │
│  1. Browser connects, basic auth prompt shown    │
│  2. On auth success, allocates a new PTY         │
│  3. Forks the configured command on that PTY     │
│  4. Bridges WS data ↔ PTY data                   │
│                                                  │
│  Flags:                                          │
│    -W        = writable (allow input)            │
│    -c user:pass = HTTP basic authentication      │
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
│  │        (attach as additional client)           │
│  │                                               │
│  └── NO:  clean stale sockets                    │
│           exec abduco -A claude-session claude    │
│           (create new session, run claude)        │
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
│  Two modes:                                      │
│                                                  │
│  abduco -A (create + attach)                     │
│  ├── Server process: holds the master PTY        │
│  │   where claude runs. Stays alive even when    │
│  │   all clients detach.                         │
│  └── Client process: connects the current        │
│      terminal (ttyd's PTY) to the session.       │
│                                                  │
│  abduco -a (attach only)                         │
│  └── Client process only: bridges the current    │
│      terminal to the existing server session.    │
│      Multiple clients can attach simultaneously. │
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
└── ttyd -W -p 8080 -c claude:*** ...
    └── su - claude -c claude-session.sh     ← ttyd's PTY (pts/0)
        └── abduco -a claude-session          ← attach client (exec'd from claude-session.sh)

abduco -A claude-session claude               ← abduco server (ppid=1, detached)
└── claude                                    ← the actual CLI (on abduco's internal PTY, pts/1)
```

## Lifecycle: First Connection

```
1. Browser opens WS to :8080
2. ttyd prompts for basic auth (username: claude, password: AUTH_PASSWORD)
3. ttyd allocates PTY pts/0, forks: su - claude -c claude-session.sh
4. claude-session.sh checks: no abduco session exists
5. Runs: exec abduco -A claude-session claude
6. abduco creates server process (detaches to ppid=1)
7. abduco creates client process (on pts/0, connected to ttyd)
8. claude starts inside abduco's internal PTY
9. User sees Claude Code prompt in browser
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
1. Browser opens new WS to :8080
2. ttyd validates basic auth credentials
3. ttyd allocates NEW PTY pts/2, forks new: su - claude -c claude-session.sh
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
| ttyd `-c claude:$AUTH_PASSWORD` | - | Basic auth credentials (skipped if AUTH_PASSWORD unset) |
