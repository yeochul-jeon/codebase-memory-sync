FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/core-service/package.json ./packages/core-service/
RUN pnpm install --frozen-lockfile
COPY packages/core-service ./packages/core-service
RUN pnpm --filter @cms/core-service build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable pnpm
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml* ./
COPY --from=builder /app/packages/core-service/package.json ./packages/core-service/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/core-service/dist ./packages/core-service/dist
COPY --from=builder /app/packages/core-service/src/storage/schema.sql ./packages/core-service/dist/storage/schema.sql
EXPOSE 3000
CMD ["node", "packages/core-service/dist/server.js"]
