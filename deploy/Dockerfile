# JARVIS bridge only (no frontend). Build from the REPO ROOT:
#   docker build -f deploy/Dockerfile -t jarvis-bridge .
FROM node:24-slim

ENV NODE_ENV=production \
    JARVIS_BRIDGE_HOST=0.0.0.0

WORKDIR /app

# The bridge needs only ws, zod and @anthropic-ai/claude-agent-sdk, but the
# lockfile is shared with the frontend, so `npm ci --omit=dev` also installs the
# frontend's runtime deps (larger image, no functional effect). Install scripts
# are skipped; the SDK's native binary ships as a prebuilt optional package.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bridge ./bridge

# Trade journal + daily state live in bridge/data. Create it owned by the
# unprivileged user so a fresh named volume mounted here inherits that owner.
RUN mkdir -p /app/bridge/data && chown -R node:node /app/bridge/data
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.JARVIS_BRIDGE_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "bridge/server.mjs"]
