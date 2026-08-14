import { readFileSync } from "node:fs";

export interface RootlineApiConfig {
  databaseUrl: string;
  issuer: string;
  audience: string;
  jwksPath: string;
  rateLimit: number;
  port: number;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required; Rootline API refuses to start without it.`);
  return value;
}

export function loadConfig(overrides: Partial<RootlineApiConfig> = {}): RootlineApiConfig {
  const config = {
    databaseUrl: overrides.databaseUrl ?? required(process.env.DATABASE_URL, "DATABASE_URL"),
    issuer: overrides.issuer ?? required(process.env.JWT_ISSUER, "JWT_ISSUER"),
    audience: overrides.audience ?? required(process.env.JWT_AUDIENCE, "JWT_AUDIENCE"),
    jwksPath: overrides.jwksPath ?? required(process.env.JWT_JWKS_PATH, "JWT_JWKS_PATH"),
    rateLimit: overrides.rateLimit ?? Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
    port: overrides.port ?? Number(process.env.PORT ?? 3000),
  };
  if (!Number.isInteger(config.rateLimit) || config.rateLimit < 1) throw new Error("RATE_LIMIT_PER_MINUTE must be a positive integer.");
  const jwks = JSON.parse(readFileSync(config.jwksPath, "utf8")) as { keys?: unknown[] };
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error("JWT_JWKS_PATH must contain at least one static signing key.");
  return config;
}
