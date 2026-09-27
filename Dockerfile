FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=development \
    TZ=UTC

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@10.28.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
    && pnpm typecheck \
    && pnpm build \
    && chmod +x scripts/container-entrypoint.sh scripts/e2e.sh

ENTRYPOINT ["./scripts/container-entrypoint.sh"]
CMD ["--help"]

