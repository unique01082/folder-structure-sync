import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { PassportModule } from "@nestjs/passport";

import { JwtAuthGuard, JwtStrategy, PermissionsGuard } from "./auth.js";
import type { RootlineApiConfig } from "./config.js";
import { HealthController } from "./health.controller.js";
import { PrismaService } from "./prisma.service.js";
import { UserRateLimitGuard } from "./rate-limit.guard.js";
import { SyncController } from "./sync.controller.js";
import { SyncService } from "./sync.service.js";

export function createAppModule(config: RootlineApiConfig) {
  @Module({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), PassportModule.register({ defaultStrategy: "jwt" })],
    controllers: [HealthController, SyncController],
    providers: [
      { provide: "ROOTLINE_API_CONFIG", useValue: config },
      { provide: PrismaService, useFactory: () => new PrismaService(config.databaseUrl) },
      { provide: JwtStrategy, useFactory: () => new JwtStrategy(config) },
      SyncService,
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector), inject: [Reflector] },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new PermissionsGuard(reflector), inject: [Reflector] },
      { provide: APP_GUARD, useFactory: (reflector: Reflector) => new UserRateLimitGuard(reflector, config), inject: [Reflector] },
    ],
  })
  class RootlineAppModule {}
  return RootlineAppModule;
}
