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
COPY apps/worker apps/worker

RUN npm run build --workspace=@workout-logging/shared
RUN npm run build --workspace=@workout-logging/worker

FROM node:22 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace=@workout-logging/worker --workspace=@workout-logging/shared --include-workspace-root && \
    rm -rf node_modules/ts-node node_modules/typescript node_modules/@swc

FROM node:22-slim AS final
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules

COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY apps/worker/package.json ./apps/worker/package.json

CMD ["node", "apps/worker/dist/index.js"]