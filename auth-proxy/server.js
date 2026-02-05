const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PROXY_PORT || 8080;
const TTYD_URL = process.env.TTYD_URL || 'http://localhost:7681';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

// Simple session store (in-memory)
const sessions = new Map();

// Rate limiting for login attempts (per IP)
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPTS = 5;

function isRateLimited(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record) return false;
    // Clean up expired window
    if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        loginAttempts.delete(ip);
        return false;
    }
    return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record || now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else {
        record.count++;
    }
}

function clearLoginAttempts(ip) {
    loginAttempts.delete(ip);
}

// Create proxy
const proxy = httpProxy.createProxyServer({
    target: TTYD_URL,
    ws: true
});

proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err);
    if (res.writeHead) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway - ttyd not available');
    }
});

// Read login page HTML
const loginPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Code Terminal - Login</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-container {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .logo {
            text-align: center;
            margin-bottom: 30px;
        }
        .logo h1 {
            color: #fff;
            font-size: 28px;
            font-weight: 600;
        }
        .logo p {
            color: rgba(255, 255, 255, 0.6);
            margin-top: 8px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            color: rgba(255, 255, 255, 0.8);
            margin-bottom: 8px;
            font-size: 14px;
        }
        .form-group input {
            width: 100%;
            padding: 14px 16px;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 10px;
            color: #fff;
            font-size: 16px;
            transition: all 0.3s ease;
        }
        .form-group input:focus {
            outline: none;
            border-color: #e94560;
            background: rgba(255, 255, 255, 0.15);
        }
        .form-group input::placeholder {
            color: rgba(255, 255, 255, 0.4);
        }
        .submit-btn {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #e94560 0%, #0f3460 100%);
            border: none;
            border-radius: 10px;
            color: #fff;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        .submit-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 20px rgba(233, 69, 96, 0.4);
        }
        .submit-btn:active {
            transform: translateY(0);
        }
        .error-message {
            background: rgba(233, 69, 96, 0.2);
            border: 1px solid rgba(233, 69, 96, 0.5);
            color: #ff6b6b;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
            display: none;
        }
        .error-message.show {
            display: block;
        }
        .terminal-icon {
            font-size: 48px;
            margin-bottom: 10px;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="logo">
            <div class="terminal-icon">></div>
            <h1>Claude Code Terminal</h1>
            <p>Enter password to access the terminal</p>
        </div>
        <div id="error" class="error-message">Invalid password</div>
        <form id="loginForm" method="POST" action="/auth">
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" placeholder="Enter your password" required autofocus>
            </div>
            <button type="submit" class="submit-btn">Access Terminal</button>
        </form>
    </div>
    <script>
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('error') === '1') {
            document.getElementById('error').classList.add('show');
        }
    </script>
</body>
</html>`;

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, ...value] = cookie.trim().split('=');
            cookies[name] = value.join('=');
        });
    }
    return cookies;
}

function isAuthenticated(req) {
    if (!AUTH_PASSWORD) return true; // No password set, allow access

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies['session'];

    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (session.expires > Date.now()) {
            return true;
        }
        sessions.delete(sessionId);
    }
    return false;
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const params = new URLSearchParams(body);
            resolve(Object.fromEntries(params));
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Handle login page
    if (url.pathname === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginPageHtml);
        return;
    }

    // Handle authentication
    if (url.pathname === '/auth' && req.method === 'POST') {
        const clientIp = req.socket.remoteAddress;

        if (isRateLimited(clientIp)) {
            res.writeHead(429, { 'Content-Type': 'text/plain' });
            res.end('Too many login attempts. Try again later.');
            return;
        }

        const body = await parseBody(req);

        if (body.password === AUTH_PASSWORD) {
            clearLoginAttempts(clientIp);
            const sessionId = generateSessionId();
            sessions.set(sessionId, {
                expires: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
            });

            res.writeHead(302, {
                'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`,
                'Location': '/'
            });
            res.end();
        } else {
            recordLoginAttempt(clientIp);
            res.writeHead(302, { 'Location': '/login?error=1' });
            res.end();
        }
        return;
    }

    // Handle logout
    if (url.pathname === '/logout') {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies['session']) {
            sessions.delete(cookies['session']);
        }
        res.writeHead(302, {
            'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
            'Location': '/login'
        });
        res.end();
        return;
    }

    // Check authentication for all other routes
    if (!isAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/login' });
        res.end();
        return;
    }

    // Proxy to ttyd
    proxy.web(req, res);
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
    if (!isAuthenticated(req)) {
        socket.destroy();
        return;
    }
    proxy.ws(req, socket, head);
});

server.listen(PORT, () => {
    console.log(`Auth proxy listening on port ${PORT}`);
    console.log(`Proxying to ttyd at ${TTYD_URL}`);
    console.log(`Authentication: ${AUTH_PASSWORD ? 'enabled' : 'disabled'}`);
});
