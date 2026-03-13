const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = process.env.MCP_PORT || 9090;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const WS_STATUS_URL = 'http://localhost:8080/internal/ws-status';
const DEFAULT_MCP_WORKDIR = '/home/claude/workspace/mcp';

// Track if a query is currently in progress
let queryInProgress = false;

// Track active queries with their metadata (for permission routing)
const activeQueries = new Map(); // queryId -> { chatId, ... }

// JSON-RPC error codes
const JSONRPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    UNAUTHORIZED: -32001,
    BROWSER_ACTIVE: -32002,
    QUERY_IN_PROGRESS: -32003,
    TIMEOUT: -32004
};

// Tool definitions for MCP
const TOOLS = [
    {
        name: 'query_claude',
        description: 'Send a prompt to Claude Code running in this container and get the response. Use this to have Claude Code perform tasks, answer questions, or write code.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'The prompt or question to send to Claude Code'
                },
                continueSession: {
                    type: 'boolean',
                    description: 'Whether to continue the previous conversation session (default: true)'
                },
                workdir: {
                    type: 'string',
                    description: 'Working directory for the query, determines which project history to use (default: /home/claude/mcp-workspace)'
                },
                timeout: {
                    type: 'number',
                    description: 'Timeout in seconds for the query (default: 120)'
                },
                chatId: {
                    type: 'string',
                    description: 'Telegram chat ID for permission prompts. When provided, Claude will request permission via Telegram before executing tools.'
                },
                permissionCallbackUrl: {
                    type: 'string',
                    description: 'URL of the permission REST endpoint (e.g., http://telegram-mcp:8080/api/permission). Required for permission prompts.'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'check_status',
        description: 'Check if Claude Code in the container is available for queries. Returns availability status and whether a browser session is active.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

function jsonRpcError(id, code, message) {
    return {
        jsonrpc: '2.0',
        id: id,
        error: { code, message }
    };
}

function jsonRpcResult(id, result) {
    return {
        jsonrpc: '2.0',
        id: id,
        result: result
    };
}

// Check if browser WebSocket is connected via auth-proxy
async function isBrowserConnected() {
    return new Promise((resolve) => {
        const req = http.get(WS_STATUS_URL, { timeout: 2000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const status = JSON.parse(data);
                    resolve(status.connected === true);
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

// Parse JSON body from request
function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// Verify bearer token authorization
function isAuthorized(req) {
    if (!AUTH_PASSWORD) return true;

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const token = authHeader.substring(7);
    return token === AUTH_PASSWORD;
}

// Send SSE event
function sendSSE(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Handle initialize method
function handleInitialize(id, params, res) {
    const result = {
        protocolVersion: '2024-11-05',
        capabilities: {
            tools: {
                listChanged: false
            }
        },
        serverInfo: {
            name: 'claude-code-container',
            version: '1.0.0'
        }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jsonRpcResult(id, result)));
}

// Handle tools/list method
function handleToolsList(id, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jsonRpcResult(id, { tools: TOOLS })));
}

// Handle tools/call method
async function handleToolsCall(id, params, res, req) {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'check_status') {
        const browserActive = await isBrowserConnected();
        const content = [{
            type: 'text',
            text: JSON.stringify({
                available: !browserActive && !queryInProgress,
                browserConnected: browserActive,
                queryInProgress: queryInProgress
            }, null, 2)
        }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcResult(id, { content })));
        return;
    }

    if (toolName === 'query_claude') {
        await handleQueryClaude(id, args, res, req);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jsonRpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool: ${toolName}`)));
}

// Handle query_claude tool execution
async function handleQueryClaude(id, args, res, req) {
    if (queryInProgress) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(id, JSONRPC_ERRORS.QUERY_IN_PROGRESS, 'Query already in progress')));
        return;
    }

    const prompt = args?.prompt;
    if (!prompt || typeof prompt !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Missing or invalid prompt parameter')));
        return;
    }

    queryInProgress = true;

    // Timeout in seconds (default 120)
    const timeoutSec = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 120;

    // Working directory (default to MCP-specific workspace)
    const workdir = args.workdir || DEFAULT_MCP_WORKDIR;

    // Permission prompts configuration
    const chatId = args.chatId;
    const permissionCallbackUrl = args.permissionCallbackUrl;
    const enablePermissionPrompts = !!chatId && !!permissionCallbackUrl;

    // Ensure workdir exists
    if (!fs.existsSync(workdir)) {
        try {
            fs.mkdirSync(workdir, { recursive: true });
            console.log(`[MCP] Created workdir: ${workdir}`);
        } catch (err) {
            console.error(`[MCP] Failed to create workdir: ${err.message}`);
        }
    }

    // Build command args
    const cmdArgs = ['-p'];
    if (args.continueSession !== false) {
        cmdArgs.push('-c');
    }

    // Add permission prompt tool if enabled
    let mcpConfigPath = null;
    if (enablePermissionPrompts) {
        // Create a temporary MCP config for the permission server
        const mcpConfig = {
            mcpServers: {
                'permission': {
                    command: 'node',
                    args: ['/app/mcp-server/permission-mcp.js'],
                    env: {
                        PERMISSION_CHAT_ID: chatId,
                        PERMISSION_CALLBACK_URL: permissionCallbackUrl,
                        PERMISSION_TIMEOUT: String(timeoutSec)
                    }
                }
            }
        };

        // Write temp config file
        mcpConfigPath = `/tmp/mcp-config-${id}.json`;
        try {
            fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
            cmdArgs.push('--mcp-config', mcpConfigPath);
            cmdArgs.push('--permission-prompt-tool', 'mcp__permission__permission_prompt');
            console.log(`[MCP] Permission prompts enabled for chat ${chatId}`);
        } catch (err) {
            console.error(`[MCP] Failed to create MCP config: ${err.message}`);
            // Continue without permission prompts
        }
    }

    cmdArgs.push(prompt);

    console.log(`[MCP] Starting query (timeout: ${timeoutSec}s, workdir: ${workdir}, permissions: ${enablePermissionPrompts}): claude ${cmdArgs.slice(0, -1).join(' ')} '${prompt.substring(0, 50)}'...`);

    // Build environment
    const env = {
        ...process.env,
        HOME: '/home/claude',
        USER: 'claude',
        PATH: '/home/claude/.local/bin:' + (process.env.PATH || '')
    };

    // Spawn claude directly (MCP server runs as claude user)
    const claude = spawn('claude', cmdArgs, {
        cwd: workdir,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // Close stdin immediately since we're not sending any input
    claude.stdin.end();

    let outputBuffer = '';
    let stderrBuffer = '';
    let timedOut = false;

    // Set up timeout
    const timeoutId = setTimeout(() => {
        if (!claude.killed) {
            timedOut = true;
            console.log(`[MCP] Query timed out after ${timeoutSec}s, killing process`);
            claude.kill('SIGTERM');
            setTimeout(() => {
                if (!claude.killed) {
                    claude.kill('SIGKILL');
                }
            }, 2000);
        }
    }, timeoutSec * 1000);

    claude.stdout.on('data', (data) => {
        outputBuffer += data.toString();
    });

    claude.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        console.error(`[MCP] Claude stderr: ${data.toString()}`);
    });

    claude.on('close', (code) => {
        clearTimeout(timeoutId);
        queryInProgress = false;
        console.log(`[MCP] Query completed with exit code: ${code}${timedOut ? ' (timed out)' : ''}`);

        // Clean up temp MCP config
        if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
            try {
                fs.unlinkSync(mcpConfigPath);
            } catch (err) {
                console.error(`[MCP] Failed to clean up config: ${err.message}`);
            }
        }

        if (timedOut) {
            res.writeHead(408, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(jsonRpcError(id, -32004, `Query timed out after ${timeoutSec} seconds`)));
            return;
        }

        // Plain text output - just use the buffer directly
        const resultText = outputBuffer.trim();

        const content = [{
            type: 'text',
            text: resultText || 'No response received'
        }];

        if (stderrBuffer && code !== 0) {
            content.push({
                type: 'text',
                text: `[stderr]: ${stderrBuffer}`
            });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcResult(id, { content })));
    });

    claude.on('error', (err) => {
        clearTimeout(timeoutId);
        queryInProgress = false;
        console.error(`[MCP] Claude spawn error: ${err.message}`);

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(id, JSONRPC_ERRORS.INTERNAL_ERROR, err.message)));
    });

    // Handle client disconnect
    req.on('close', () => {
        if (!claude.killed) {
            clearTimeout(timeoutId);
            console.log('[MCP] Client disconnected, killing claude process');
            claude.kill('SIGTERM');
            queryInProgress = false;
        }
    });
}

// Main request handler
async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Status endpoint (no auth required, internal use)
    if (url.pathname === '/mcp/status' && req.method === 'GET') {
        const browserActive = await isBrowserConnected();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            available: !browserActive && !queryInProgress,
            browserConnected: browserActive,
            queryInProgress: queryInProgress
        }));
        return;
    }

    // All other endpoints require authentication
    if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jsonRpcError(null, JSONRPC_ERRORS.UNAUTHORIZED, 'Unauthorized')));
        return;
    }

    // Main MCP endpoint
    if (url.pathname === '/mcp' && req.method === 'POST') {
        let body;
        try {
            body = await parseJsonBody(req);
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(jsonRpcError(null, JSONRPC_ERRORS.PARSE_ERROR, 'Parse error')));
            return;
        }

        // Validate JSON-RPC request
        if (!body.jsonrpc || body.jsonrpc !== '2.0' || !body.method) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(jsonRpcError(body?.id, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request')));
            return;
        }

        const { id, method, params } = body;

        // Route to method handler
        switch (method) {
            case 'initialize':
                handleInitialize(id, params, res);
                break;

            case 'initialized':
                // Client notification that initialization is complete
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcResult(id, {})));
                break;

            case 'tools/list':
                handleToolsList(id, res);
                break;

            case 'tools/call':
                await handleToolsCall(id, params, res, req);
                break;

            default:
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(jsonRpcError(id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`)));
        }
        return;
    }

    // 404 for unknown paths
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
        console.error('[MCP] Request error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(jsonRpcError(null, JSONRPC_ERRORS.INTERNAL_ERROR, 'Internal server error')));
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[MCP] Server listening on 127.0.0.1:${PORT}`);
});
