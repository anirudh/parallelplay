FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS build

ARG TARGET_PACKAGE
ENV COREPACK_HOME=/corepack \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /source
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter "${TARGET_PACKAGE}..." build
RUN pnpm --filter "${TARGET_PACKAGE}" deploy /output --prod --legacy

FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854
ENV NODE_ENV=production \
    HOME=/tmp \
    PATH=/usr/local/bin:/usr/bin:/bin \
    LANG=C \
    LC_ALL=C
WORKDIR /app
COPY --from=build --chown=65534:65534 /output/ /app/
USER 65534:65534
ENTRYPOINT ["node", "/app/dist/main.js"]
