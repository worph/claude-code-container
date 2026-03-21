#!/usr/bin/env node
/**
 * Permission MCP Server
 * Provides a permission_prompt tool via stdio transport.
 * Forwards permission requests to telegram-mcp via REST endpoint.
 *
 * Environment variables:
 * - PERMISSION_CHAT_ID: Telegram chat ID to send permission requests to
 * - PERMISSION_CALLBACK_URL: URL of telegram-mcp permission endpoint (e.g., http://telegram-mcp:8080/api/permission)
 * - PERMISSION_TIMEOUT: Timeout in seconds (default: 120)
 */

const { randomUUID } = require('crypto');

const CHAT_ID = process.env.PERMISSION_CHAT_ID || '';
const PERMISSION_CALLBACK_URL = process.env.PERMISSION_CALLBACK_URL || '';
const PERMISSION_TIMEOUT = parseInt(process.env.PERMISSION_TIMEOUT || '120', 10);

// MCP server capabilities
const SERVER_INFO = {
    name: 'permission-mcp',
    version: '1.0.0'
};

const CAPABILITIES = {
    tools: {}
};

// Tool definition
const PERMISSION_TOOL = {
    name: 'permission_prompt',
    description: 'Request user permission for a tool execution via Telegram inline keyboard',
    inputSchema: {
        type: 'object',
        properties: {
            tool_name: {
                type: 'string',
                description: 'Name of the tool requesting permission'
            },
            tool_input: {
                type: 'object',
                description: 'Input parameters for the tool'
            },
            description: {
                type: 'string',
                description: 'Human-readable description of what the tool will do'
            }
        },
        required: ['tool_name']
    }
};

const fs = require('fs');
const LOG_FILE = '/tmp/permission-mcp-debug.log';

function log(...args) {
    const msg = '[permission-mcp] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    console.error(msg);
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

function sendResponse(response) {
    process.stdout.write(JSON.stringify(response) + '\n');
}

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

// Call telegram-mcp's REST permission endpoint
async function requestTelegramPermission(toolName, toolInput, description) {
    if (!PERMISSION_CALLBACK_URL || !CHAT_ID) {
        log('Missing PERMISSION_CALLBACK_URL or PERMISSION_CHAT_ID, denying permission');
        return { decision: 'deny', timedOut: false };
    }

    const queryId = randomUUID();

    log(`Requesting permission for ${toolName} to chat ${CHAT_ID}`);

    try {
        const res = await fetch(PERMISSION_CALLBACK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                queryId,
                chatId: CHAT_ID,
                toolName,
                toolInput: toolInput || {},
                description,
                timeout: PERMISSION_TIMEOUT
            }),
            signal: AbortSignal.timeout((PERMISSION_TIMEOUT + 10) * 1000)
        });

        if (!res.ok) {
            const errorText = await res.text();
            log('Permission request failed:', res.status, errorText);
            return { decision: 'deny', timedOut: false };
        }

        const result = await res.json();
        log('Permission response:', result);
        return result;
    } catch (e) {
        if (e.name === 'TimeoutError') {
            log('Permission request timed out');
            return { decision: 'deny', timedOut: true };
        }
        log('Permission request failed:', e.message);
        return { decision: 'deny', timedOut: false };
    }
}

async function handleRequest(request) {
    const { id, method, params } = request;

    switch (method) {
        case 'initialize':
            return jsonRpcResult(id, {
                protocolVersion: '2024-11-05',
                capabilities: CAPABILITIES,
                serverInfo: SERVER_INFO
            });

        case 'initialized':
        case 'notifications/initialized':
        case 'notifications/cancelled':
            // Notifications don't get responses
            return null;

        case 'tools/list':
            return jsonRpcResult(id, { tools: [PERMISSION_TOOL] });

        case 'tools/call': {
            const toolName = params?.name;
            const args = params?.arguments || {};

            if (toolName !== 'permission_prompt') {
                return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
            }

            // Handle permission_prompt tool call
            // Claude CLI sends: tool_name, input (tool params), tool_use_id
            const targetTool = args.tool_name;
            const targetInput = args.input || args.tool_input || {};
            const description = args.description || '';

            if (!targetTool) {
                return jsonRpcError(id, -32602, 'Missing required parameter: tool_name');
            }

            const result = await requestTelegramPermission(targetTool, targetInput, description);

            // Return the decision in the format Claude CLI expects
            // updatedInput MUST contain the original tool input, otherwise Claude CLI loses it
            const response = result.decision === 'allow'
                ? { behavior: 'allow', updatedInput: targetInput }
                : { behavior: 'deny', message: result.timedOut ? 'Permission timed out' : 'Permission denied by user' };

            log('Returning permission response to Claude CLI:', JSON.stringify(response));

            const rpcResult = jsonRpcResult(id, {
                content: [{
                    type: 'text',
                    text: JSON.stringify(response)
                }]
            });
            log('Full JSON-RPC response:', JSON.stringify(rpcResult));
            return rpcResult;
        }

        default:
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
}

// Read stdin line by line
let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
    buffer += chunk;

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
            const request = JSON.parse(line);
            const response = await handleRequest(request);
            if (response !== null) {
                sendResponse(response);
            }
        } catch (e) {
            sendResponse(jsonRpcError(null, -32700, `Parse error: ${e.message}`));
        }
    }
});

process.stdin.on('end', () => {
    if (buffer.trim()) {
        try {
            const request = JSON.parse(buffer);
            handleRequest(request).then(response => {
                if (response !== null) {
                    sendResponse(response);
                }
                process.exit(0);
            }).catch(e => {
                sendResponse(jsonRpcError(null, -32603, `Internal error: ${e.message}`));
                process.exit(1);
            });
        } catch (e) {
            sendResponse(jsonRpcError(null, -32700, `Parse error: ${e.message}`));
            process.exit(0);
        }
    } else {
        process.exit(0);
    }
});

log('Permission MCP server started');
log(`Chat ID: ${CHAT_ID || '(not set)'}`);
log(`Permission callback URL: ${PERMISSION_CALLBACK_URL || '(not set)'}`);
