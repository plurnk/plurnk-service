import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const mode = process.env.PLURNK_RELEASE_PROBE_FIXTURE ?? "ready";
const version = process.env.PLURNK_RELEASE_PROBE_VERSION ?? "1.10.1";
const cleanup = process.env.PLURNK_RELEASE_PROBE_CLEANUP;

if (mode === "exit") {
    process.stderr.write("fixture exits before readiness\n");
    process.exit(7);
}

const server = createServer((_request, response) => {
    if (mode === "bad-http") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("not AG-UI");
        return;
    }
    response.writeHead(404, { "content-type": "application/problem+json" });
    response.end(JSON.stringify({ type: "https://problems.plurnk.xyz/agui/http/route-not-found" }));
});

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.PLURNK_PORT), process.env.PLURNK_HOST, resolve);
});
const stop = () => {
    server.close(() => {
        void (cleanup === undefined ? Promise.resolve() : writeFile(cleanup, "closed\n", "utf8"))
            .then(() => process.exit(0), (cause) => {
                process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
                process.exit(1);
            });
    });
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

const address = server.address();
if (address === null || typeof address === "string") throw new Error("fixture did not bind TCP");
process.stderr.write(`plurnk-service: @plurnk/plurnk-service@${version} fixture fixture-path\n`);
process.stdout.write(`plurnk-service agui=http://${process.env.PLURNK_HOST}:${address.port} db=fixture no model\n`);
