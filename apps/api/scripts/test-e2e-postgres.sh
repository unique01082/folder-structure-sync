#!/bin/sh
set -eu

compose_file="$(dirname "$0")/../compose.test.yml"
project="rootline-api-e2e"
database_url="postgresql://rootline:rootline@127.0.0.1:55433/rootline_test?schema=public"

cleanup() {
  docker compose -p "$project" -f "$compose_file" down --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose -p "$project" -f "$compose_file" up --detach --wait
DATABASE_URL="$database_url" pnpm exec prisma migrate deploy
DATABASE_URL="$database_url" pnpm exec vitest run test/sync.e2e.spec.ts
