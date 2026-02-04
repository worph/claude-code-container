# Claude Code Container

A Docker container that runs [Claude Code](https://github.com/anthropics/claude-code) (Anthropic's CLI for Claude) with [ttyd](https://github.com/tsl0922/ttyd) for web-based terminal access, protected by a login page.

## Features

- Web-based terminal access to Claude Code
- Styled login page with session management
- Multi-architecture support (amd64, arm64)
- Persistent workspace volume
- Optional Docker socket access
- Easy deployment with Docker Compose

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/claude-code-container.git
cd claude-code-container
```

### 2. Create environment file

```bash
cp .env.example .env
```

Edit `.env` and set your values:

```env
ANTHROPIC_API_KEY=your-api-key-here
AUTH_PASSWORD=your-secure-password-here
```

### 3. Run the container

```bash
docker compose up -d
```

Access at: `http://localhost:8080`

## Architecture

```
┌─────────────────────────────┐
│         Browser             │
└─────────────┬───────────────┘
              │ :8080
              ▼
┌─────────────────────────────┐
│     Auth Proxy (Node.js)    │
│   - Login page              │
│   - Session management      │
└─────────────┬───────────────┘
              │ :7681 (internal)
              ▼
┌─────────────────────────────┐
│          ttyd               │
│     ┌───────────────┐       │
│     │  Claude Code  │       │
│     │    + bash     │       │
│     └───────────────┘       │
└─────────────────────────────┘
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude | (required) |
| `AUTH_PASSWORD` | Password for terminal access | (required for security) |
| `PROXY_PORT` | Auth proxy port | `8080` |

## Optional Features

### Host Network Mode

Use host networking for direct access to host network interfaces. Edit `docker-compose.yml`:

```yaml
services:
  claude-code:
    # ...
    # Comment out 'ports' and uncomment 'network_mode'
    # ports:
    #   - "8080:8080"
    network_mode: host
```

### Docker Access

Give Claude Code access to Docker on the host machine. Edit `docker-compose.yml`:

```yaml
services:
  claude-code:
    # ...
    volumes:
      - workspace:/home/claude/workspace
      # Uncomment to enable Docker access
      - /var/run/docker.sock:/var/run/docker.sock
```

> **Warning**: Mounting the Docker socket gives the container full control over Docker on your host. Only enable this if you trust the environment and need Docker capabilities.

## Building Locally

```bash
docker build -t claude-code-container .
```

## Using Pre-built Images

Images are automatically built and pushed to GitHub Container Registry:

```bash
docker pull ghcr.io/YOUR_USERNAME/claude-code-container:main
```

## Security Considerations

1. **Always set `AUTH_PASSWORD`** - Without it, anyone can access your terminal
2. **Use HTTPS in production** - Put this behind a reverse proxy (nginx, Traefik, Caddy) with TLS
3. **Protect your API key** - Never commit `.env` files to version control
4. **Network isolation** - Consider running on a private network

### Example: Running behind Traefik

```yaml
services:
  claude-code:
    build: .
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - AUTH_PASSWORD=${AUTH_PASSWORD}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.claude.rule=Host(`claude.example.com`)"
      - "traefik.http.routers.claude.tls.certresolver=letsencrypt"
    volumes:
      - workspace:/home/claude/workspace
```

## Project Structure

```
.
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
├── supervisord.conf
├── auth-proxy/
│   ├── server.js
│   └── package.json
└── .github/
    └── workflows/
        └── docker-build.yml
```

## License

MIT
