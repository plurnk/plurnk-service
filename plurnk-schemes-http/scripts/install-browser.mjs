import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skipped = /^(1|true|yes)$/i.test(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? "");
if (skipped) {
    console.info("plurnk-schemes-http: browser download skipped by PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD");
    process.exit(0);
}

const playwrightEntry = fileURLToPath(import.meta.resolve("playwright"));
const cli = resolve(dirname(playwrightEntry), "cli.js");
const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "0",
};
const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
