FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    ERP_PORT=8095

COPY package.json server.mjs ./

USER node
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${ERP_PORT}/health" >/dev/null || exit 1

CMD ["node", "server.mjs"]
