# syntax=docker/dockerfile:1
#
# One image, three entrypoints:
#   server.js  — the dashboard Deployment (default CMD)
#   run.js     — the daily CronJob
#   watch.js   — the price alert watcher Deployment
#
# No build step: the app is plain ESM with no bundler or transpiler.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev keeps the image to runtime deps only; there are no devDependencies
# today, but this stops one being shipped by accident later.
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so `kubectl delete pod` and CronJob
# termination are clean rather than a 30s grace-period wait.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY *.js ./
COPY storage ./storage
COPY public ./public

# The file backend is a fallback; on Postgres nothing is written here. Still
# created and owned by the app user so a DATABASE_URL outage degrades to the
# file backend rather than crashing on a read-only filesystem.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 8787
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
