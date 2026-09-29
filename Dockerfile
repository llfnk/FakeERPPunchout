FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.mjs ./

USER node
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${ERP_PORT:-${PORT:-8095}}/health" >/dev/null || exit 1

CMD ["node", "server.mjs"]
