FROM node:20-alpine AS build

WORKDIR /workspace

RUN apk add --no-cache python3 make g++
RUN npm install -g npm@10.9.2

# Copy package files for all workspaces first
COPY package*.json tsconfig.base.json ./
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/shared/package.json ./apps/shared/
COPY vendor/portkey-gateway/package.json ./vendor/portkey-gateway/

RUN npm install --workspaces --include-workspace-root

COPY . .

RUN npm run build --workspace @portkey-ai/gateway \
 && npm run build --workspace @stringcost/shared \
 && npm run build --workspace @stringcost/gateway \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine

RUN apk add --no-cache libc6-compat
RUN npm install -g npm@10.9.2

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=build /workspace/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /workspace/apps/shared/dist ./apps/shared/dist
COPY --from=build /workspace/vendor/portkey-gateway/build ./vendor/portkey-gateway/build
COPY --from=build /workspace/vendor/portkey-gateway/package.json ./vendor/portkey-gateway/package.json

EXPOSE 8787

CMD ["node", "apps/gateway/dist/server.js"]
