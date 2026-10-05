# Build stage: the Vite web client needs devDependencies.
FROM node:24-slim AS web
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts skips the dev-only effect-tsgo postinstall patch.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN pnpm build

FROM node:24-slim
# ffmpeg/ffprobe normalize and split uploaded recordings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY src ./src
COPY --from=web /app/dist/web ./dist/web
# Uploads wait here until transcribed. Owned by node so a fresh named volume
# mounted at /data inherits a writable directory.
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=4280 DATA_DIR=/data
EXPOSE 4280
USER node
CMD ["node", "src/main.ts"]
