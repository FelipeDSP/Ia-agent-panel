# syntax=docker/dockerfile:1
#
# O agente em código — imagem do SEGUNDO projeto no Coolify (DESENHO §1).
#
# Contexto de build: a RAIZ do repositório (não a pasta agente/), porque a
# imagem carrega `n8n/extrair-e-filtrar.js` e `n8n/filtro-texto.js`, que
# continuam sendo a fonte da decisão de entrada durante a transição
# (agente/src/entrada/extrair.ts). No Coolify: Dockerfile = agente/Dockerfile,
# Build context = /.
#
# Node 24 roda TypeScript direto (type stripping) — não há etapa de build.
# `tsc --noEmit` roda na suíte do repo, não na imagem.

FROM node:24-alpine AS deps
WORKDIR /app/agente
COPY agente/package.json agente/package-lock.json* ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S agente && adduser -S agente -G agente
COPY --from=deps /app/agente/node_modules ./agente/node_modules
COPY agente/package.json ./agente/
COPY agente/src ./agente/src
COPY n8n/extrair-e-filtrar.js n8n/filtro-texto.js ./n8n/
ENV N8N_JS_DIR=/app/n8n
ENV PORT=3100
USER agente
EXPOSE 3100
# Healthcheck do Coolify: a fila viva (o worker passou há menos de ~15 s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/saude || exit 1
CMD ["node", "agente/src/main.ts"]
