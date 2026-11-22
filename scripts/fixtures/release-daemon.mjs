import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const mode = process.env.PLURNK_RELEASE_PROBE_FIXTURE ?? "ready";
const version = process.env.PLURNK_RELEASE_PROBE_VERSION ?? "1.10.1";
const cleanup = process.env.PLURNK_RELEASE_PROBE_CLEANUP;
const configuredIssuer = process.env.PLURNK_AUTH_ISSUER ?? "";

if (mode === "exit") {
    process.stderr.write("fixture exits before readiness\n");
    process.exit(7);
}

const server = createServer(async (request, response) => {
    if (mode === "bad-http") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("not ACP");
        return;
    }
    if (request.url === "/.well-known/oauth-protected-resource") {
        if (mode === "metadata-fails") {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "broken" }));
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            resource: `http://${request.headers.host}`,
            authorization_servers: mode === "bad-metadata" ? ["https://wrong.example.com"] : [configuredIssuer],
            bearer_methods_supported: ["header"],
        }));
        return;
    }
    const authHeader = request.headers.authorization ?? "";
    const hasJwt = /^Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(authHeader);
    if (mode !== "no-auth" && (mode === "invalid-access" || !hasJwt)) {
        response.writeHead(401, {
            "content-type": "application/problem+json",
            "www-authenticate": mode === "bad-challenge" ? "Basic realm=\"fixture\""
                : `Bearer realm="plurnk", resource_metadata="http://${request.headers.host}/.well-known/oauth-protected-resource"`,
        });
        response.end(JSON.stringify({ type: "https://problems.plurnk.xyz/acp/http/bearer-token-required" }));
        return;
    }
    response.writeHead(404, { "content-type": "application/problem+json" });
    response.end(JSON.stringify({ type: request.url === "/acp"
        ? "https://problems.plurnk.xyz/acp/http/route-not-found"
        : "https://problems.plurnk.xyz/http/route-not-found" }));
});

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.PLURNK_PORT), process.env.PLURNK_HOST, resolve);
});
const stop = () => {
    if (mode === "hang-stop") return;
    server.close(() => {
        void (cleanup === undefined ? Promise.resolve() : writeFile(cleanup, "closed\n", "utf8"))
            .then(() => process.exit(mode === "fail-stop" ? 9 : 0), (cause) => {
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
process.stdout.write(`plurnk-service acp=http://${process.env.PLURNK_HOST}:${address.port}/acp db="fixture" route="no model"\n`);
