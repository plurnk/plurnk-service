#!/usr/bin/env node
// {§mcp-transports} acceptance holder — boots one ServerConnection to a stdio MCP fixture
// server and idles. The test SIGKILLs THIS process; the watchdog wrapper must
// then take the fixture server (and any grandchildren) down with it.
import { setTimeout as delay } from "node:timers/promises";
import ServerConnection from "../src/client.ts";
import { stdioServer } from "./definitions.ts";

const fixture = process.argv[2];
const workingDirectory = process.argv[3];
if (!fixture || !workingDirectory) {
    console.error("holder: usage: holder.mjs <fixture-path> <working-directory>");
    process.exit(64);
}
const conn = new ServerConnection(stdioServer("watchdog-probe", [fixture], { cwd: workingDirectory }), process.env);
try {
    const catalog = await conn.catalog();
    console.log(`HOLDER-READY tools=${catalog.tools.length} pid=${process.pid}`);
} catch (error) {
    console.error("holder: catalog failed:", error.message);
    process.exit(1);
}
// The connection stays open; the test kills us mid-idle. No cleanup path runs.
for (;;) await delay(60_000);
