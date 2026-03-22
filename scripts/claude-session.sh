#!/bin/bash
# Session wrapper for Claude Code with dtach persistence
# Decouples session creation from client attachment so that
# ttyd killing the attach process does NOT kill claude.


export HOME=/home/claude

SOCKET_DIR="$HOME/.dtach"
SOCKET_PATH="$SOCKET_DIR/claude-session.sock"

cd /home/claude/workspace

# Ensure socket directory exists
mkdir -p "$SOCKET_DIR"

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

# Check if a dtach session is actually alive (not just a stale socket)
session_is_alive() {
    # Socket file must exist
    [ -S "$SOCKET_PATH" ] || return 1
    # Verify a dtach process is actually running
    pgrep -u "$(id -u)" -f "dtach.*claude-session" >/dev/null 2>&1 || return 1
}

if session_is_alive; then
    # Live session exists — just attach as a client
    trigger_redraw
    exec dtach -a "$SOCKET_PATH"
else
    # No live session — clean up stale sockets and create a new one
    rm -f "$SOCKET_PATH" 2>/dev/null

    # Create session DETACHED — dtach server + claude run independently of this process
    dtach -n "$SOCKET_PATH" claude

    # Brief wait for the socket to appear
    sleep 0.3

    # Now attach as a client — ttyd killing THIS process won't affect the session
    trigger_redraw
    exec dtach -a "$SOCKET_PATH"
fi
