#!/usr/bin/env node
import Server from "../Server.ts";

const server = new Server();
const { host, port } = await server.listen();
process.stdout.write(`plurnk-agui http://${host}:${port} → ${process.env.PLURNK_AGUI_DAEMON_URL}\n`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { void server.close().then(() => process.exit(0)); });
}
