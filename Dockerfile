FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/liaison.db
WORKDIR /app
RUN groupadd --system liaison && useradd --system --gid liaison --home-dir /app liaison && mkdir -p /data && chown liaison:liaison /data
COPY --from=build --chown=liaison:liaison /app/package.json /app/package-lock.json ./
COPY --from=build --chown=liaison:liaison /app/node_modules ./node_modules
COPY --from=build --chown=liaison:liaison /app/dist ./dist
COPY --from=build --chown=liaison:liaison /app/dist-server ./dist-server
USER liaison
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist-server/server/index.js"]
