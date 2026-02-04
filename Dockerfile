FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    vim \
    build-essential \
    cmake \
    libjson-c-dev \
    libwebsockets-dev \
    supervisor \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for optional Docker socket access)
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# Build ttyd from source for latest version
RUN git clone https://github.com/tsl0922/ttyd.git /tmp/ttyd && \
    cd /tmp/ttyd && \
    mkdir build && cd build && \
    cmake .. && \
    make && \
    make install && \
    rm -rf /tmp/ttyd

# Create a non-root user for security
# Add to docker group for optional Docker socket access
RUN groupadd -g 999 docker || true && \
    useradd -m -s /bin/bash -G docker claude && \
    mkdir -p /home/claude/workspace && \
    chown -R claude:claude /home/claude

# Install Claude Code using native installer (as claude user)
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

# Add Claude Code to PATH for all users
ENV PATH="/home/claude/.local/bin:${PATH}"

# Copy and setup auth proxy
COPY auth-proxy /app/auth-proxy
WORKDIR /app/auth-proxy
RUN npm install

# Copy supervisor config
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set workspace as working directory
WORKDIR /home/claude/workspace

# Expose auth proxy port
EXPOSE 8080

# Environment variables
ENV ANTHROPIC_API_KEY=""
ENV AUTH_PASSWORD=""
ENV PROXY_PORT=8080
ENV TTYD_PORT=7681
ENV TTYD_URL=http://localhost:7681

ENTRYPOINT ["/entrypoint.sh"]
