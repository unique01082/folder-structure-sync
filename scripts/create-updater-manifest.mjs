import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [artifactDirectory, releaseBaseUrl, outputPath] = process.argv.slice(2);
if (!artifactDirectory || !releaseBaseUrl || !outputPath) {
  throw new Error("Usage: create-updater-manifest <artifact-directory> <https-release-base-url> <output-path>");
}
const baseUrl = new URL(releaseBaseUrl);
if (baseUrl.protocol !== "https:") throw new Error("Updater release base URL must use HTTPS.");

const artifacts = {
  "darwin-aarch64": "rootline-2.0.0-darwin-universal.app.tar.gz",
  "darwin-x86_64": "rootline-2.0.0-darwin-universal.app.tar.gz",
  "windows-x86_64": "rootline-2.0.0-windows-x86_64-setup.exe",
  "windows-aarch64": "rootline-2.0.0-windows-aarch64-setup.exe",
};
const platforms = Object.fromEntries(Object.entries(artifacts).map(([platform, fileName]) => {
  const signature = readFileSync(join(artifactDirectory, `${fileName}.sig`), "utf8").trim();
  if (!signature) throw new Error(`Updater signature is empty for ${platform}.`);
  readFileSync(join(artifactDirectory, fileName));
  return [platform, {
    signature,
    url: new URL(encodeURIComponent(fileName), `${baseUrl.toString().replace(/\/?$/, "/")}`).toString(),
  }];
}));

writeFileSync(outputPath, `${JSON.stringify({
  version: "2.0.0",
  notes: "Rootline by baole.space 2.0.0",
  pub_date: process.env.RELEASE_PUBLISHED_AT || new Date().toISOString(),
  platforms,
}, null, 2)}\n`);
