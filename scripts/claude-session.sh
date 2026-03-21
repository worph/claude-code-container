#!/bin/bash
# Session wrapper for Claude Code with abduco persistence
# Decouples session creation from client attachment so that
# ttyd killing the attach process does NOT kill claude.

# Drop privileges to claude user if running as root (e.g. when called directly by ttyd)
if [ "$(id -u)" = "0" ]; then
    exec su - claude -c "$0"
fi

SESSION_NAME="claude-session"
SOCKET_DIR="$HOME/.abduco"

cd /home/claude/workspace

# Function to trigger redraw with multiple attempts
trigger_redraw() {
    (
        for delay in 0 0.3 1 3; do
            sleep "$delay"

            CLAUDE_PID=$(pgrep -u "$(id -u)" -x claude 2>/dev/null | head -1)
            [ -z "$CLAUDE_PID" ] && continue

            kill -WINCH "$CLAUDE_PID" 2>/dev/null

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

# Check if an abduco session is actually alive (not just a stale socket)
session_is_alive() {
    # First check if abduco lists it (with timeout to avoid hanging on stale sockets)
    timeout 2 abduco -l 2>/dev/null | grep -q "$SESSION_NAME" || return 1
    # Verify the abduco server process is actually running
    pgrep -u "$(id -u)" -f "abduco.*$SESSION_NAME" >/dev/null 2>&1 || return 1
}

if session_is_alive; then
    # Live session exists — just attach as a client
    trigger_redraw
    exec abduco -a "$SESSION_NAME"
else
    # No live session — clean up stale sockets and create a new one
    rm -f "$SOCKET_DIR"/${SESSION_NAME}@* 2>/dev/null

    # Create session DETACHED — abduco server + claude run independently of this process
    abduco -n "$SESSION_NAME" claude

    # Brief wait for the socket to appear
    sleep 0.3

    # Now attach as a client — ttyd killing THIS process won't affect the session
    trigger_redraw
    exec abduco -a "$SESSION_NAME"
fi
