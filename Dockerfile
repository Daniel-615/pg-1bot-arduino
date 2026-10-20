FROM node:22-bookworm-slim

WORKDIR /app

ARG ARDUINO_CLI_VERSION=1.5.1
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv tar \
  && rm -rf /var/lib/apt/lists/*

# Install the toolchains while building the image, not on the first API request.
RUN case "${TARGETARCH:-amd64}" in \
      amd64) CLI_ARCH="64bit" ;; \
      arm64) CLI_ARCH="ARM64" ;; \
      *) echo "Unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/arduino-cli_${ARDUINO_CLI_VERSION}_Linux_${CLI_ARCH}.tar.gz" \
    -o /tmp/arduino-cli.tar.gz \
  && tar -xzf /tmp/arduino-cli.tar.gz -C /usr/local/bin arduino-cli \
  && chmod +x /usr/local/bin/arduino-cli \
  && /usr/local/bin/arduino-cli version \
  && rm /tmp/arduino-cli.tar.gz \
  && python3 -m venv /opt/codey-venv \
  && /opt/codey-venv/bin/pip install --no-cache-dir mpremote

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV LOCAL_AGENT_MODE=false
ENV ARDUINO_CLI_VERSION=1.5.1
ENV ARDUINO_CLI_PATH=/usr/local/bin/arduino-cli
ENV CODEY_PYTHON_PATH=/usr/bin/python3
ENV CODEY_MPREMOTE_PATH=/opt/codey-venv/bin/mpremote

RUN mkdir -p /app/arduino-data \
  && groupadd --system app \
  && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app \
  && chown -R app:app /app

USER app

EXPOSE 3000

VOLUME ["/app/arduino-data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
