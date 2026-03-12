#!/bin/bash
# Session wrapper for Claude Code with abduco persistence
# Enforces SINGLE CLIENT - only one connection allowed at a time

SESSION_NAME="claude-session"
SOCKET_DIR="$HOME/.abduco"
SOCKET_PATH="$SOCKET_DIR/${SESSION_NAME}@$(hostname)"
LOCK_FILE="/tmp/claude-session.lock"

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

if [ -S "$SOCKET_PATH" ]; then
    # Session exists - kill existing clients first
    kill_all_clients
    sleep 0.2

    # Force screen redraw by resizing the PTY after attach
    # This triggers SIGWINCH with actual size change, forcing Claude to redraw
    (
        sleep 0.5
        # Find Claude's PTY and toggle its size to force redraw
        CLAUDE_TTY=$(ps -o tty= -p "$(pgrep -u "$(id -u)" -x claude 2>/dev/null | head -1)" 2>/dev/null | tr -d ' ')
        if [ -n "$CLAUDE_TTY" ] && [ "$CLAUDE_TTY" != "?" ]; then
            PTY_DEV="/dev/$CLAUDE_TTY"
            # Get current size, shrink by 1, then restore
            COLS=$(stty -F "$PTY_DEV" size 2>/dev/null | awk '{print $2}')
            ROWS=$(stty -F "$PTY_DEV" size 2>/dev/null | awk '{print $1}')
            if [ -n "$COLS" ] && [ -n "$ROWS" ]; then
                stty -F "$PTY_DEV" cols $((COLS - 1)) rows $((ROWS - 1)) 2>/dev/null
                sleep 0.1
                stty -F "$PTY_DEV" cols "$COLS" rows "$ROWS" 2>/dev/null
            fi
        fi
    ) &

    # Attach to existing session
    exec abduco -a "$SESSION_NAME"
else
    # No session exists - create and attach
    exec abduco -A "$SESSION_NAME" claude
fi
