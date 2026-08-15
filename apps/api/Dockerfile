FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS base

RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --filter @rootline/api...

COPY apps/api apps/api
COPY packages/contracts packages/contracts
RUN pnpm --filter @rootline/contracts build \
  && pnpm --filter @rootline/api prisma:generate \
  && pnpm --filter @rootline/api build

FROM base AS runtime

ARG ROOTLINE_BUILD_ID=development
ENV NODE_ENV=production
ENV PORT=3000
ENV ROOTLINE_BUILD_ID=$ROOTLINE_BUILD_ID
WORKDIR /app

RUN groupadd --system rootline && useradd --system --gid rootline rootline
COPY --from=build --chown=rootline:rootline /app/node_modules /app/node_modules
COPY --from=build --chown=rootline:rootline /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build --chown=rootline:rootline /app/apps/api/dist /app/apps/api/dist
COPY --from=build --chown=rootline:rootline /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build --chown=rootline:rootline /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build --chown=rootline:rootline /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build --chown=rootline:rootline /app/packages/contracts/package.json /app/packages/contracts/package.json

USER rootline
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
