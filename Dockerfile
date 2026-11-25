# Lumen VR Player — server edition (ZimaOS, CasaOS, Unraid, Synology, any Docker host)
FROM node:20-alpine
RUN apk add --no-cache openssl tini
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && find node_modules/onnxruntime-web -mindepth 1 -maxdepth 1 ! -name dist ! -name package.json -exec rm -rf {} + \
 && npm cache clean --force
COPY lib ./lib
COPY server ./server
COPY src ./src
ENV MEDIA_DIR=/media MODELS_DIR=/models CONFIG_DIR=/config HTTP_PORT=8080 HTTPS_PORT=8443 NODE_ENV=production
RUN mkdir -p /media /models /config
EXPOSE 8080 8443
VOLUME ["/models", "/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/info >/dev/null || exit 1
LABEL org.opencontainers.image.title="Lumen VR Player" \
      org.opencontainers.image.description="VR / 3D / 360° video player with GPU and AI upscaling, served from your NAS" \
      org.opencontainers.image.source="https://github.com/unknownleaves/lumen-vr-player" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/server.js"]
