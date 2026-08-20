#!/usr/bin/env node
// {§mcp-stdio-process-ownership} acceptance holder — boots one ServerConnection to a stdio MCP fixture
// server and idles. The test SIGKILLs THIS process; the watchdog wrapper must
// then take the fixture server (and any grandchildren) down with it.
import { setTimeout as delay } from "node:timers/promises";
import ServerConnection from "../src/client.ts";

// The holder may run outside the suite's env floor; the connection constructor
// requires these knobs.
process.env.PLURNK_MCP_CONNECT_TIMEOUT ??= "30000";
process.env.PLURNK_MCP_REQUEST_TIMEOUT ??= "86400000";

const fixture = process.argv[2];
if (typeof fixture !== "string" || fixture.length === 0) {
    console.error("holder: usage: holder.mjs <fixture-path>");
    process.exit(64);
}
const conn = new ServerConnection({
    name: "watchdog-probe",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
}, process.env, {});
try {
    const catalog = await conn.catalog();
    console.log(`HOLDER-READY tools=${catalog.tools.length} pid=${process.pid}`);
} catch (error) {
    console.error("holder: catalog failed:", error.message);
    process.exit(1);
}
// The connection stays open; the test kills us mid-idle. No cleanup path runs.
for (;;) await delay(60_000);
