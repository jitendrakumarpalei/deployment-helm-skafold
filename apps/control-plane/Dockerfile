FROM node:20-alpine AS build

WORKDIR /workspace

RUN apk add --no-cache python3 make g++
RUN npm install -g npm@10.9.2

# Copy package files for all workspaces first
COPY package*.json tsconfig.base.json ./
COPY apps/control-plane/package.json ./apps/control-plane/
COPY apps/shared/package.json ./apps/shared/

RUN npm install --workspaces --include-workspace-root

COPY . .

RUN npm run build --workspace @stringcost/shared \
 && npm run build --workspace @stringcost/control-plane

FROM node:20-alpine

RUN apk add --no-cache libc6-compat
RUN npm install -g npm@10.9.2

WORKDIR /app
ENV NODE_ENV=production

# Copy everything from build stage (includes all dependencies)
COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/tsconfig.base.json ./
COPY --from=build /workspace/node_modules ./node_modules

# Copy control-plane app
COPY --from=build /workspace/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build /workspace/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=build /workspace/apps/control-plane/src ./apps/control-plane/src
COPY --from=build /workspace/apps/control-plane/tsconfig.json ./apps/control-plane/tsconfig.json
COPY --from=build /workspace/apps/control-plane/knexfile.ts ./apps/control-plane/knexfile.ts
COPY --from=build /workspace/apps/control-plane/knex ./apps/control-plane/knex

# Copy ledger app (needed for migrations)
COPY --from=build /workspace/apps/ledger/package.json ./apps/ledger/package.json
COPY --from=build /workspace/apps/ledger/src ./apps/ledger/src
COPY --from=build /workspace/apps/ledger/tsconfig.json ./apps/ledger/tsconfig.json
COPY --from=build /workspace/apps/ledger/knexfile.ts ./apps/ledger/knexfile.ts
COPY --from=build /workspace/apps/ledger/knex ./apps/ledger/knex

# Copy shared app
COPY --from=build /workspace/apps/shared/dist ./apps/shared/dist

EXPOSE 8080

CMD ["node", "apps/control-plane/dist/index.js"]
