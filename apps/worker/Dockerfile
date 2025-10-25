FROM node:20-alpine AS build

WORKDIR /workspace

RUN apk add --no-cache python3 make g++
RUN npm install -g npm@10.9.2

# Copy package files for all workspaces first
COPY package*.json tsconfig.base.json ./
COPY apps/worker/package.json ./apps/worker/
COPY apps/shared/package.json ./apps/shared/

RUN npm install --workspaces --include-workspace-root

COPY . .

RUN npm run build --workspace @stringcost/shared \
 && npm run build --workspace @stringcost/worker \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine

RUN apk add --no-cache libc6-compat
RUN npm install -g npm@10.9.2

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build /workspace/apps/shared/dist ./apps/shared/dist

EXPOSE 8080

CMD ["node", "apps/worker/dist/server.js"]
