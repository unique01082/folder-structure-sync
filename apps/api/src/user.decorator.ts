import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthUser } from "./auth.js";

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser =>
  context.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
