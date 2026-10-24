import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const mode = process.env.PLURNK_RELEASE_PROBE_FIXTURE ?? "ready";
const version = process.env.PLURNK_RELEASE_PROBE_VERSION ?? "1.10.1";
const cleanup = process.env.PLURNK_RELEASE_PROBE_CLEANUP;

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
    if (request.url === "/oauth/token") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const form = new URLSearchParams(body);
        const basic = `Basic ${Buffer.from(`operator:${process.env.PLURNK_SECRET}`).toString("base64")}`;
        const accepted = mode !== "token-fails"
            && request.method === "POST"
            && request.headers.authorization === basic
            && request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
            && form.get("grant_type") === "client_credentials"
            && form.get("scope") === "acp"
            && form.get("resource") === `http://${request.headers.host}/acp`;
        response.writeHead(accepted ? 200 : 401, { "content-type": "application/json" });
        response.end(JSON.stringify(!accepted ? { error: "invalid_client" }
            : mode === "bad-token" ? { token_type: "Bearer" }
                : { token_type: "Bearer", access_token: "fixture-access", expires_in: 60 }));
        return;
    }
    if (mode !== "no-auth" && (mode === "invalid-access" || request.headers.authorization !== "Bearer fixture-access")) {
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
