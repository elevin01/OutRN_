FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=UTC

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@10.28.0 --activate

COPY . .

RUN --mount=type=cache,id=outrn-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile \
    && pnpm typecheck \
    && pnpm build \
    && chmod +x scripts/container-entrypoint.sh scripts/e2e.sh

ENTRYPOINT ["./scripts/container-entrypoint.sh"]
CMD ["--help"]
