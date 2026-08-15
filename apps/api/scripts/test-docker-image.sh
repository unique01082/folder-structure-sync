#!/bin/sh
set -eu

smoke_suffix="${ROOTLINE_API_SMOKE_SUFFIX:-$$}"
smoke_image="rootline-api-smoke:${smoke_suffix}"
smoke_network="rootline-api-smoke-${smoke_suffix}"
postgres_container="rootline-api-smoke-postgres-${smoke_suffix}"
api_container="rootline-api-smoke-api-${smoke_suffix}"
build_id="rootline-api-smoke-${smoke_suffix}"
smoke_directory=$(mktemp -d "${TMPDIR:-/tmp}/rootline-api-image-smoke.XXXXXX")
jwks_path="$smoke_directory/jwks.json"

cleanup() {
  docker rm --force "$api_container" "$postgres_container" >/dev/null 2>&1 || true
  docker network rm "$smoke_network" >/dev/null 2>&1 || true
  docker image rm "$smoke_image" >/dev/null 2>&1 || true
  rm -f "$jwks_path"
  rmdir "$smoke_directory" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

node - "$jwks_path" <<'NODE'
const { generateKeyPairSync } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = publicKey.export({ format: "jwk" });
Object.assign(key, { kid: "rootline-image-smoke", alg: "RS256", use: "sig" });
writeFileSync(process.argv[2], JSON.stringify({ keys: [key] }));
NODE

docker build --file apps/api/Dockerfile \
  --build-arg "ROOTLINE_BUILD_ID=$build_id" \
  --tag "$smoke_image" .

docker network create "$smoke_network" >/dev/null
docker run --detach \
  --name "$postgres_container" \
  --network "$smoke_network" \
  --network-alias postgres \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data \
  --env POSTGRES_USER=rootline \
  --env POSTGRES_PASSWORD=rootline \
  --env POSTGRES_DB=rootline_smoke \
  postgres:16-alpine >/dev/null

postgres_ready=false
for attempt in $(seq 1 30); do
  if docker exec "$postgres_container" pg_isready --username rootline --dbname rootline_smoke >/dev/null 2>&1; then
    postgres_ready=true
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    docker logs "$postgres_container"
  else
    sleep 1
  fi
done
[ "$postgres_ready" = true ]

postgres_mapping=$(docker port "$postgres_container" 5432/tcp)
postgres_port=${postgres_mapping##*:}
host_database_url="postgresql://rootline:rootline@127.0.0.1:${postgres_port}/rootline_smoke?schema=public"
DATABASE_URL="$host_database_url" pnpm --filter @rootline/api exec prisma migrate deploy

docker run --detach \
  --name "$api_container" \
  --network "$smoke_network" \
  --read-only \
  --tmpfs /tmp \
  --mount "type=bind,source=$jwks_path,target=/run/rootline/jwks.json,readonly" \
  --env DATABASE_URL="postgresql://rootline:rootline@postgres:5432/rootline_smoke?schema=public" \
  --env JWT_ISSUER=https://auth.rootline.invalid/application/o/rootline/ \
  --env JWT_AUDIENCE=rootline-desktop-smoke \
  --env JWT_JWKS_PATH=/run/rootline/jwks.json \
  "$smoke_image" >/dev/null

api_healthy=false
for attempt in $(seq 1 30); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api_container")
  if [ "$health" = healthy ]; then
    api_healthy=true
    break
  fi
  if [ "$health" = unhealthy ] || [ "$attempt" -eq 30 ]; then
    docker logs "$api_container"
  else
    sleep 1
  fi
done
[ "$api_healthy" = true ]

docker exec "$api_container" node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(async response => { const body = await response.json(); if (!response.ok || body.status !== 'ok' || body.buildId !== '$build_id') process.exit(1); }).catch(() => process.exit(1))"
