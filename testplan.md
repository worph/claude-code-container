# Manual Test Plan

This document describes how to manually test the Claude Code Container, with focus on session persistence.

## Prerequisites

1. Docker and Docker Compose installed
2. `.env` file configured with `AUTH_PASSWORD`
3. Container built and running:
   ```bash
   docker compose up -d --build
   ```

## Test 1: Initial Connection

**Steps:**
1. Open browser to `http://localhost:8080`
2. Enter password and click "Access Terminal"
3. Wait 3-5 seconds for Claude Code to initialize

**Expected:**
- Claude Code UI displays with logo, version, and "? for shortcuts" status bar
- Terminal is responsive to keyboard input

## Test 2: Page Refresh (Session Persistence)

**Steps:**
1. Complete Test 1 (Claude Code running)
2. Press F5 or click browser refresh
3. Wait 2 seconds

**Expected:**
- Claude Code UI reappears without re-authentication
- Same session continues (no "Welcome" screen unless it was showing before)

**Repeat:** Refresh 5+ times to ensure stability

## Test 3: Multiple Refreshes in Quick Succession

**Steps:**
1. Complete Test 1
2. Rapidly refresh the page 3 times (F5, F5, F5)
3. Wait 2 seconds after last refresh

**Expected:**
- Claude Code UI displays correctly
- No black screen
- Only one abduco client running (verify with Test 7)

## Test 4: New Tab (Single Client Enforcement)

**Steps:**
1. Complete Test 1 (Claude Code running in Tab A)
2. Open new browser tab to `http://localhost:8080`
3. Wait 2 seconds

**Expected:**
- New tab shows Claude Code UI
- Original tab may show black screen or disconnect (expected - only one client allowed)

## Test 5: Tab Switching

**Steps:**
1. Complete Test 4 (two tabs open)
2. Close the new tab
3. Refresh the original tab

**Expected:**
- Original tab reconnects and shows Claude Code UI

## Test 6: Container Restart

**Steps:**
1. Complete Test 1
2. Run: `docker compose restart claude-code`
3. Wait for container to start (~5 seconds)
4. Refresh browser

**Expected:**
- Login page appears (sessions are in-memory)
- After login, Claude Code starts fresh (session not persisted across restart)

## Test 7: Process Verification

**Steps:**
Run inside container:
```bash
docker compose exec claude-code ps aux | grep -E '(abduco|claude)' | grep -v grep
```

**Expected with active session:**
```
claude  ... abduco -A claude-session claude   # Server (PPID=1)
claude  ... claude                             # Claude Code process
claude  ... abduco -a claude-session           # Client (one only)
```

**Key checks:**
- Only ONE `abduco -a` client process
- Server process has PPID=1 (reparented to init)
- Claude process is child of abduco server

## Test 8: Black Screen Recovery

If you encounter a black screen:

**Steps:**
1. Press `Ctrl+L` (should trigger partial redraw)
2. If still black, resize browser window
3. If still black, refresh the page

**Expected:**
- One of these actions should restore the display
- If persistent, check Test 7 for multiple clients

## Test 9: Session TTL (Long-running)

**Steps:**
1. Complete Test 1
2. Leave browser open for 30+ minutes without interaction
3. Return and try to type

**Expected:**
- Session should still be active (abduco keeps it alive)
- Claude Code responds to input

## Troubleshooting

### Black screen after refresh
- Verify only one abduco client: Test 7
- Check script permissions: `ls -la /home/claude/scripts/`
- Check logs: `docker compose logs claude-code`

### "Permission denied" error
```bash
docker compose exec claude-code chmod +x /home/claude/scripts/*.sh
docker compose exec claude-code chown claude:claude /home/claude/scripts/*
```

### Session not persisting
- Verify abduco socket exists:
  ```bash
  docker compose exec claude-code ls -la /home/claude/.abduco/
  ```
- Should show: `claude-session@<hostname>`

### Multiple clients causing issues
```bash
# Kill all abduco processes and restart
docker compose exec claude-code pkill -9 -f abduco
# Then refresh browser
```

## Architecture Notes

```
Browser → Auth Proxy (:8080) → ttyd (:7681) → claude-session.sh → abduco → claude
```

- **abduco server**: Keeps Claude running when clients disconnect
- **abduco client**: Connects browser session to running Claude
- **PTY resize trick**: Forces Claude TUI to redraw after reattach
- **Single client**: Only one browser connection active at a time
