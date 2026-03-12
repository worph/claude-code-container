#!/bin/bash
# Session wrapper for Claude Code with abduco persistence
# Enforces SINGLE CLIENT - only one connection allowed at a time

SESSION_NAME="claude-session"
SOCKET_DIR="$HOME/.abduco"
SOCKET_PATH="$SOCKET_DIR/${SESSION_NAME}@$(hostname)"

cd /home/claude/workspace

# Function to kill all abduco clients (not the server)
kill_all_clients() {
    for pid in $(pgrep -u "$(id -u)" -f "abduco .* $SESSION_NAME" 2>/dev/null); do
        # Server has PPID=1 (reparented to init), clients have other PPID
        ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ -n "$ppid" ] && [ "$ppid" != "1" ]; then
            # First try graceful SIGTERM
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    # Wait a bit for graceful shutdown
    sleep 0.1

    # Force kill any remaining
    for pid in $(pgrep -u "$(id -u)" -f "abduco .* $SESSION_NAME" 2>/dev/null); do
        ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ -n "$ppid" ] && [ "$ppid" != "1" ]; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
}

# Function to trigger redraw with multiple attempts
trigger_redraw() {
    (
        # Try multiple times with increasing delays: 0, 0.3, 1, 3 seconds
        for delay in 0 0.3 1 3; do
            sleep "$delay"

            CLAUDE_PID=$(pgrep -u "$(id -u)" -x claude 2>/dev/null | head -1)
            [ -z "$CLAUDE_PID" ] && continue

            # Method 1: Send SIGWINCH directly to Claude (fast)
            kill -WINCH "$CLAUDE_PID" 2>/dev/null

            # Method 2: PTY size toggle (more reliable, use on later attempts)
            if [ "$delay" = "1" ] || [ "$delay" = "3" ]; then
                CLAUDE_TTY=$(ps -o tty= -p "$CLAUDE_PID" 2>/dev/null | tr -d ' ')
                if [ -n "$CLAUDE_TTY" ] && [ "$CLAUDE_TTY" != "?" ]; then
                    PTY_DEV="/dev/$CLAUDE_TTY"
                    read -r ROWS COLS < <(stty -F "$PTY_DEV" size 2>/dev/null)
                    if [ -n "$COLS" ] && [ -n "$ROWS" ]; then
                        stty -F "$PTY_DEV" cols $((COLS - 1)) rows $((ROWS - 1)) 2>/dev/null
                        sleep 0.05
                        stty -F "$PTY_DEV" cols "$COLS" rows "$ROWS" 2>/dev/null
                    fi
                fi
            fi
        done
    ) &
}

if [ -S "$SOCKET_PATH" ]; then
    # Session exists - kill existing clients first
    kill_all_clients
    sleep 0.2

    # Trigger redraw attempts in background
    trigger_redraw

    # Attach to existing session
    exec abduco -a "$SESSION_NAME"
else
    # No session exists - create and attach
    # Also trigger redraw for new sessions (Claude might need it after startup)
    trigger_redraw
    exec abduco -A "$SESSION_NAME" claude
fi
