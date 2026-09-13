import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "src/web/client/app.ts");
const sourceStatic = resolve(root, "src/web/static");
const distStatic = resolve(root, "dist/web/static");

const options = {
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  await mkdir(distStatic, { recursive: true });

  await build({ ...options, outfile: resolve(distStatic, "app.js") });
  await build({ ...options, outfile: resolve(sourceStatic, "app.js") });

  await copyFile(resolve(sourceStatic, "index.html"), resolve(distStatic, "index.html"));
  await copyFile(resolve(sourceStatic, "styles.css"), resolve(distStatic, "styles.css"));

  console.log(`Built browser bundle into ${distStatic}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
