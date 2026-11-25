# tzproof, hosted: Node + Google Chrome + Kane CLI (+ Claude Code for live fixes on the demo app)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget gnupg unzip git fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @testmuai/kane-cli@0.10.9 @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV TZPROOF_PUBLIC=1 \
    TZPROOF_DATA=/data \
    TZPROOF_CHROME_PATH=/usr/bin/google-chrome \
    TZPROOF_NO_SANDBOX=1 \
    KANE_CLI_CHROME_PATH=/usr/bin/google-chrome \
    PORT=8080
EXPOSE 8080
CMD ["sh", "docker/start.sh"]
