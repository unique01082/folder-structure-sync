import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { PUBLIC_ROUTE, type AuthUser } from "./auth.js";
import type { RootlineApiConfig } from "./config.js";

@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly requests = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(private readonly reflector: Reflector, private readonly config: RootlineApiConfig) {}
  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) return true;
    const now = Date.now();
    if (now - this.lastSweep >= 60_000) {
      for (const [subject, timestamps] of this.requests) {
        const fresh = timestamps.filter((value) => value > now - 60_000);
        if (fresh.length === 0) this.requests.delete(subject);
        else this.requests.set(subject, fresh);
      }
      this.lastSweep = now;
    }
    const active = (this.requests.get(user.sub) ?? []).filter((value) => value > now - 60_000);
    if (active.length >= this.config.rateLimit) throw new HttpException("Per-user request limit exceeded.", HttpStatus.TOO_MANY_REQUESTS);
    active.push(now);
    this.requests.set(user.sub, active);
    return true;
  }
}
