FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=30005 \
    SMTP_PORT=1025 \
    DB_TYPE=sqlite \
    SQLITE_PATH=/app/data/message-sandbox.sqlite \
    LOG_DIR=/app/logs \
    ACME_DIR=/app/data/certs

# All dependencies are pure JavaScript (SQLite uses Node's built-in node:sqlite), so no build tools are needed
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# The entrypoint checks that mounted data/log directories are writable and explains how to fix them if not.
# Stripping \r keeps it working when the file was checked out on Windows with CRLF line endings.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data /app/logs \
    && chown -R node:node /app/data /app/logs

# Run as the unprivileged node user (UID 1000, GID 1000). Named volumes inherit the ownership above.
USER node

# 30005: dashboard and API, 1025: SMTP
EXPOSE 30005 1025

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The app handles SIGTERM itself (graceful shutdown); exec form keeps node as the signal receiver
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
