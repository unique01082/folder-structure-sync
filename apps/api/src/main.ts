import "reflect-metadata";
import { createApplication } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApplication(config);
await app.listen(config.port, "0.0.0.0");
