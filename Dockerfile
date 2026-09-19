FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.docker.json ./
COPY api ./api
COPY db ./db
COPY services ./services
RUN npx tsc -p tsconfig.docker.json

FROM node:22-bookworm-slim AS runtime-deps

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM runtime-deps AS web

COPY --from=build /app/dist ./dist
COPY server ./server
COPY index.html styles.css ./
COPY src ./src
COPY assets ./assets

ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/http.mjs"]

FROM runtime-deps AS gateway

COPY services ./services
RUN mkdir -p /app/data/baileys_auth && chown -R node:node /app/data

ENV WA_SESSION_DIR=/app/data/baileys_auth
VOLUME ["/app/data"]
USER node
CMD ["node", "services/gateway/whatsapp.js"]
