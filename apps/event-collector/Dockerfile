FROM node:20-alpine AS build

WORKDIR /workspace

COPY package*.json ./
COPY tsconfig.base.json ./
COPY patches ./patches

RUN apk add --no-cache python3 make g++
RUN npm install -g npm@10.9.2
RUN npm install --workspaces --include-workspace-root

COPY . .

RUN npm run build --workspace @stringcost/shared \
 && npm run build --workspace @stringcost/event-collector \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine

RUN apk add --no-cache libc6-compat
RUN npm install -g npm@10.9.2

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/event-collector/package.json ./apps/event-collector/package.json
COPY --from=build /workspace/apps/event-collector/dist ./apps/event-collector/dist
COPY --from=build /workspace/apps/shared/dist ./apps/shared/dist

EXPOSE 8080

CMD ["node", "apps/event-collector/dist/index.js"]
