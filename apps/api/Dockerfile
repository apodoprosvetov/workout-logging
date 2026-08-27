FROM node:22 AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build --workspace=@workout-logging/shared
RUN npm run build --workspace=@workout-logging/api

FROM node:22 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# --omit=dev doesn't reach into a *linked local workspace's* own
# devDependencies (a known npm workspaces limitation, confirmed by testing:
# @workout-logging/shared's ts-node/typescript devDependencies get
# installed anyway, since @workout-logging/api depends on that workspace
# directly). Neither is ever needed at runtime here (only by shared's
# migration:run CLI scripts, never by `node apps/api/dist/main.js`) — safe
# to strip explicitly.
RUN npm ci --omit=dev --workspace=@workout-logging/api --workspace=@workout-logging/shared --include-workspace-root && \
    rm -rf node_modules/ts-node node_modules/typescript node_modules/@swc

FROM node:22-slim AS final
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
# npm's hoisting doesn't always put every dependency in the root
# node_modules — when it can't (a version conflict, or similar), it nests
# a copy inside the specific workspace that needs it. Confirmed for real:
# @nestjs/platform-fastify (apps/api's own Fastify adapter — used directly
# in src/main.ts) only exists at apps/api/node_modules/, and dotenv (a real
# dependency of packages/shared) only at packages/shared/node_modules/ —
# neither is under the root node_modules copied above. Missing this caused
# a real `Error: Cannot find module '@nestjs/platform-fastify'` at
# container startup.
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
# node_modules/@workout-logging/shared is a symlink to ../../packages/shared
# (npm workspaces) — Node reads packages/shared/package.json's "main" field
# to follow it to dist/index.js. Without this file, the symlink resolves to
# a directory Node can't make sense of.
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY apps/api/package.json ./apps/api/package.json

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
