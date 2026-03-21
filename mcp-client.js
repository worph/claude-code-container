#!/usr/bin/env node
/**
 * MCP stdio-to-HTTP bridge client
 * Connects Claude Code (stdio) to the container's MCP HTTP server
 */

const http = require('http');

const MCP_URL = process.env.MCP_URL || 'http://localhost:9090/mcp';
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
            try {
                const data = JSON.parse(buffer);
                process.stdout.write(JSON.stringify(data) + '\n');
            } catch (e) {
                // Non-JSON response - emit as error
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: jsonRpcRequest.id || null,
                    error: { code: -32000, message: `Invalid response from server` }
                };
                process.stdout.write(JSON.stringify(errorResponse) + '\n');
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
