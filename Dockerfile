# Imagen de producción: compila la página y ejecuta la API (que también sirve la página compilada).
# Un solo proceso, una sola instancia (SQLite): ver docs/DESPLIEGUE.md.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATABASE_PATH=/data/orama.db BACKUP_DIR=/data/backups TRUST_PROXY=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
# La base de datos y los respaldos viven en /data: monta ahí un volumen persistente
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "server/index.js"]
