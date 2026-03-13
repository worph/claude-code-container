#!/usr/bin/env node
/**
 * MCP stdio-to-HTTP bridge client
 * Connects Claude Code (stdio) to the container's MCP HTTP server
 */

const http = require('http');

const MCP_URL = process.env.MCP_URL || 'http://localhost:8080/mcp';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || process.env.AUTH_PASSWORD || '';

let pendingRequests = 0;
let stdinEnded = false;

function checkExit() {
    if (stdinEnded && pendingRequests === 0) {
        process.exit(0);
    }
}

function sendRequest(jsonRpcRequest) {
    pendingRequests++;

    const url = new URL(MCP_URL);
    const body = JSON.stringify(jsonRpcRequest);

    const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AUTH_TOKEN}`,
            'Content-Length': Buffer.byteLength(body)
        }
    };

    const req = http.request(options, (res) => {
        let buffer = '';

        res.on('data', (chunk) => {
            buffer += chunk.toString();
        });

        res.on('end', () => {
            // Try to parse as JSON first (standard response)
            try {
                const data = JSON.parse(buffer);
                process.stdout.write(JSON.stringify(data) + '\n');
            } catch (e) {
                // Might be SSE format, try to parse it
                const events = parseSSE(buffer);
                for (const event of events) {
                    if (event.event === 'message' || event.event === 'error') {
                        try {
                            const data = JSON.parse(event.data);
                            process.stdout.write(JSON.stringify(data) + '\n');
                        } catch (e2) {
                            // Skip parse errors
                        }
                    }
                }
            }

            pendingRequests--;
            checkExit();
        });

        res.on('error', () => {
            pendingRequests--;
            checkExit();
        });
    });

    req.on('error', (err) => {
        const errorResponse = {
            jsonrpc: '2.0',
            id: jsonRpcRequest.id || null,
            error: {
                code: -32000,
                message: `Connection error: ${err.message}`
            }
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
        pendingRequests--;
        checkExit();
    });

    req.write(body);
    req.end();
}

function parseSSE(text) {
    const events = [];
    const blocks = text.split('\n\n');

    for (const block of blocks) {
        if (!block.trim()) continue;

        const lines = block.split('\n');
        let event = { event: 'message', data: '' };

        for (const line of lines) {
            if (line.startsWith('event: ')) {
                event.event = line.substring(7).trim();
            } else if (line.startsWith('data: ')) {
                event.data += line.substring(6);
            }
        }

        if (event.data) {
            events.push(event);
        }
    }

    return events;
}

function processLine(line) {
    if (!line.trim()) return;

    try {
        const request = JSON.parse(line);
        sendRequest(request);
    } catch (e) {
        const errorResponse = {
            jsonrpc: '2.0',
            id: null,
            error: {
                code: -32700,
                message: `Parse error: ${e.message}`
            }
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
}

// Read stdin
let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    buffer += chunk;

    // Process complete lines
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);
        processLine(line);
    }
});

process.stdin.on('end', () => {
    // Process any remaining data
    if (buffer.trim()) {
        processLine(buffer);
    }
    stdinEnded = true;
    checkExit();
});
