# Stage 1: Build ttyd
FROM node:22-bookworm AS builder

RUN apt-get update && apt-get install -y \
    build-essential cmake git libjson-c-dev libwebsockets-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --branch 1.7.7 --depth 1 https://github.com/tsl0922/ttyd.git /tmp/ttyd && \
    cd /tmp/ttyd && mkdir build && cd build && \
    cmake .. && make && make install

# Stage 2: Runtime
FROM node:22-slim

ARG S6_OVERLAY_VERSION=3.2.0.2

# Install xz-utils first for s6-overlay extraction
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils && rm -rf /var/lib/apt/lists/*

# Install s6-overlay (arch-aware for multi-platform builds)
ARG TARGETARCH
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/s6-overlay-amd64.tar.xz
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-aarch64.tar.xz /tmp/s6-overlay-arm64.tar.xz
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-${TARGETARCH}.tar.xz && \
    rm /tmp/s6-overlay-*.tar.xz

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjson-c5 libwebsockets17 libwebsockets-evlib-uv libuv1 \
    git curl vim ca-certificates sudo jq htop \
    dnsutils iproute2 iputils-ping traceroute lsof \
    openssh-client openssh-server ncdu rsync python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

# Install yq
RUN curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$(dpkg --print-architecture) \
    -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# Install Docker CLI
RUN apt-get update && apt-get install -y --no-install-recommends gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Copy ttyd from builder
COPY --from=builder /usr/local/bin/ttyd /usr/local/bin/ttyd

# Create user (password set at runtime by init-permissions)
RUN groupadd -g 999 docker || true && \
    useradd -m -s /bin/bash -G docker claude && \
    mkdir -p /home/claude/workspace/mcp && \
    chown -R claude:claude /home/claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Configure SSH for local connections only
RUN sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    echo "ListenAddress 127.0.0.1" >> /etc/ssh/sshd_config

# Install wetty (needs build tools for node-pty) and compile abduco for session persistence
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 procps \
    && npm install -g wetty \
    && npm cache clean --force \
    && git clone --depth 1 https://github.com/martanne/abduco.git /tmp/abduco \
    && cd /tmp/abduco \
    && ./configure && make && make install \
    && rm -rf /tmp/abduco \
    && apt-get purge -y build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

ENV PATH="/home/claude/.local/bin:${PATH}"

# Setup MCP server
COPY mcp-server /app/mcp-server
WORKDIR /app/mcp-server
RUN npm install --omit=dev && npm cache clean --force

# Setup s6-overlay services
COPY s6-overlay/s6-rc.d /etc/s6-overlay/s6-rc.d

# Setup session wrapper scripts
COPY scripts /home/claude/scripts
RUN chmod +x /home/claude/scripts/*.sh && chown -R claude:claude /home/claude/scripts

WORKDIR /home/claude/workspace

EXPOSE 8080 9090

ENV ANTHROPIC_API_KEY="" \
    AUTH_PASSWORD="" \
    PROXY_PORT=8080 \
    WETTY_PORT=3000 \
    MCP_PORT=9090 \
    MCP_ENABLED=true \
    CLAUDE_SESSION_TTL=1800 \
    NODE_OPTIONS="--max-old-space-size=64" \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PROXY_PORT:-8080}/ || exit 1

ENTRYPOINT ["/init"]
