import { createPublicKey, type JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard, PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { RootlineApiConfig } from "./config.js";

export const PUBLIC_ROUTE = "rootline:public";
export const REQUIRED_PERMISSIONS = "rootline:permissions";
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const Permissions = (...permissions: string[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export interface AuthUser {
  sub: string;
  permissions: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function decodeHeader(token: string): { alg?: string; kid?: string } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { alg?: string; kid?: string };
  } catch {
    throw new UnauthorizedException("Invalid bearer token.");
  }
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: RootlineApiConfig) {
    const raw = JSON.parse(readFileSync(config.jwksPath, "utf8")) as { keys: Array<JsonWebKey & { kid?: string; alg?: string }> };
    const keys = new Map(raw.keys.map((key) => [key.kid, key]));
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ["RS256"],
      issuer: config.issuer,
      audience: config.audience,
      secretOrKeyProvider: (_request: unknown, token: string, done: (error: Error | null, key?: string) => void) => {
        try {
          const header = decodeHeader(token);
          if (header.alg !== "RS256" || !header.kid) return done(new Error("Unsupported signing key."));
          const jwk = keys.get(header.kid);
          if (!jwk || (jwk.alg && jwk.alg !== "RS256")) return done(new Error("Unknown signing key."));
          const pem = createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
          done(null, pem);
        } catch (error) {
          done(error instanceof Error ? error : new Error("Invalid token."));
        }
      },
    });
  }

  validate(payload: Record<string, unknown>): AuthUser {
    if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new UnauthorizedException("Token subject is required.");
    return { sub: payload.sub, permissions: stringArray(payload.permissions) };
  }
}

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) { super(); }
  canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    return super.canActivate(context);
  }
  handleRequest<TUser = AuthUser>(error: unknown, user: TUser | false | null): TUser {
    if (error || !user) throw new UnauthorizedException("A valid Rootline access token is required.");
    return user;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [context.getHandler(), context.getClass()]);
    if (!required?.length) throw new ForbiddenException("Endpoint permission metadata is required.");
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!required.some((permission) => request.user?.permissions.includes(permission))) throw new ForbiddenException("Required permission is missing.");
    return true;
  }
}
