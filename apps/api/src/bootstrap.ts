import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { json } from "express";

import { createAppModule } from "./app.module.js";
import type { RootlineApiConfig } from "./config.js";
import { SafeExceptionFilter } from "./safe-exception.filter.js";

export async function createApplication(config: RootlineApiConfig): Promise<INestApplication> {
  const app = await NestFactory.create(createAppModule(config), { bodyParser: false });
  app.use(json({ limit: 256 * 1024, strict: true }));
  app.useGlobalFilters(new SafeExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
