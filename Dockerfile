# RuralAI Core API
#
# NEW file (not in the specified structure) — docker-compose.yml has a `build`
# stanza, which requires a Dockerfile. Flagged in docs/DECISIONS.md.

FROM node:22-alpine AS base
WORKDIR /app
# tini gives us correct PID-1 signal handling, so SIGTERM reaches Node and
# graceful shutdown in server.js actually runs.
RUN apk add --no-cache tini

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Never run as root.
RUN addgroup -g 1001 -S nodejs \
  && adduser -S ruralai -u 1001 \
  && mkdir -p public/temp \
  && chown -R ruralai:nodejs /app
USER ruralai

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
