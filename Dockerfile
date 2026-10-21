# node:22.22.0-bookworm-slim, pinned by digest so rebuilds are reproducible.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck && pnpm exec vite build --config apps/web/vite.config.ts
# Production dependencies only; tsx is a runtime dependency.
RUN pnpm prune --prod

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages packages
COPY --from=build --chown=node:node /app/connectors connectors
COPY --from=build --chown=node:node /app/services services
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
USER node
EXPOSE 4310
# Node runs as PID 1's child under --init (see compose) and receives SIGTERM directly.
CMD ["node", "--import", "tsx", "services/api/src/index.ts"]
