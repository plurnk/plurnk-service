import { copyFile, mkdir } from "node:fs/promises";
import { usage } from "../../scripts/lib/usage.mjs";

usage(import.meta, `
usage: npm run build:assets   (a step of npm run build, from plurnk-mcp)
Build step: copies the module's watchdog script beside dist/.
Reads: src/mcp-watchdog.mjs.
Writes: dist/mcp-watchdog.mjs.
`);

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await copyFile(
    new URL("../src/mcp-watchdog.mjs", import.meta.url),
    new URL("../dist/mcp-watchdog.mjs", import.meta.url),
);
