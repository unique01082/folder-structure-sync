import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

import { createApplication } from "./bootstrap.js";
import { loadConfig, type RootlineApiConfig } from "./config.js";
import { PrismaService } from "./prisma.service.js";

export interface TestApplication {
  app: INestApplication;
  server: Server;
  resetDatabase(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestApplication(overrides: Partial<RootlineApiConfig>): Promise<TestApplication> {
  const app = await createApplication(loadConfig(overrides));
  const prisma = app.get(PrismaService);
  return {
    app,
    server: app.getHttpServer() as Server,
    async resetDatabase() {
      await prisma.mutationReceipt.deleteMany();
      await prisma.syncChange.deleteMany();
      await prisma.profileRecord.deleteMany();
      await prisma.userSyncState.deleteMany();
    },
    close: () => app.close(),
  };
}
