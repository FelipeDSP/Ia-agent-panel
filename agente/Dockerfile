# syntax=docker/dockerfile:1
#
# O agente em código — imagem do SEGUNDO projeto no Coolify (DESENHO §1).
#
# Contexto de build: a RAIZ do repositório (não a pasta agente/), por causa do
# `package.json` da raiz. As REGRAS que o serviço executa (portão, extração do
# webhook, consolidação da busca, as tools) moram em `agente/regras` desde
# 05/10/2026, quando a pasta `n8n/` foi apagada. No Coolify: Dockerfile =
# agente/Dockerfile, Build context = /.
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
# O Coolify injeta o SHA do commit como build arg SOURCE_COMMIT; vira a
# `versao_codigo` do trace e de `agente_prompts` (config.ts lê VERSAO_CODIGO).
# Variável VERSAO_CODIGO no ambiente do container, se existir, vence esta.
ARG SOURCE_COMMIT=dev
ENV VERSAO_CODIGO=${SOURCE_COMMIT}
RUN addgroup -S agente && adduser -S agente -G agente
COPY --from=deps /app/agente/node_modules ./agente/node_modules
COPY agente/package.json ./agente/
COPY agente/src ./agente/src
COPY agente/regras ./agente/regras
# `REGRAS_DIR` manda; o serviço confere se o diretório tem mesmo as regras antes
# de aceitá-lo (config.ts), então um `N8N_JS_DIR=/app/n8n` esquecido no Coolify
# não derruba o portão — ele cai no caminho embutido.
ENV REGRAS_DIR=/app/agente/regras
ENV PORT=3100
USER agente
EXPOSE 3100
# Healthcheck do Coolify: a fila viva (o worker passou há menos de ~15 s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/saude || exit 1
CMD ["node", "agente/src/main.ts"]
