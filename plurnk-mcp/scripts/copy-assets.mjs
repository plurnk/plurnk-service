import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await copyFile(
    new URL("../src/mcp-watchdog.mjs", import.meta.url),
    new URL("../dist/mcp-watchdog.mjs", import.meta.url),
);
