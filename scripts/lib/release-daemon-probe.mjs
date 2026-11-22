import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

// The release gate accepts identity only from the child it spawned: that
// child's build line plus its OS-assigned listener address. An unrelated
// responder has neither channel, and no fixed port survives between trains.
const childClose = (child) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
    : new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });

const within = async (promise, timeoutMs) => {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const stopChild = async (child, timeoutMs = 5_000) => {
    if (child.pid === undefined) return;
    const exited = childClose(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const graceful = await within(exited, timeoutMs);
    if (graceful !== null) {
        if (graceful.code !== 0) {
            throw new Error(`installed daemon shutdown failed (${graceful.code ?? graceful.signal ?? "unknown"})`);
        }
        return;
    }
    child.kill("SIGKILL");
    const forced = await within(exited, timeoutMs);
    if (forced === null) {
        throw new Error(`release probe child ${child.pid ?? "unknown"} did not exit after SIGKILL`);
    }
    throw new Error(`installed daemon did not shut down within ${timeoutMs}ms; forced termination (${forced.code ?? forced.signal ?? "unknown"})`);
};

const identityVersion = (stderr, packageName) => {
    const marker = `plurnk-service: ${packageName}@`;
    const line = stderr.split("\n").find((candidate) => candidate.startsWith(marker));
    return line?.slice(marker.length).split(/\s/, 1)[0] ?? null;
};

const startupAddress = (stdout) => {
    const match = stdout.match(/(?:^|\n)plurnk-service acp=(http:\/\/[^\s]+)/);
    return match?.[1] ?? null;
};

const listenerProblem = async (response, status, type) => {
    if (response.status !== status || !response.headers.get("content-type")?.startsWith("application/problem+json")) {
        throw new Error(`installed daemon listener returned ${response.status} ${response.headers.get("content-type") ?? "without content type"}; expected ${status} application/problem+json`);
    }
    const problem = await response.json();
    if (problem?.type !== `https://problems.plurnk.xyz/acp/http/${type}`) {
        throw new Error(`installed daemon listener did not return the ACP ${type} Problem`);
    }
};

const startEphemeralOidcIssuer = async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "probe-1", alg: "ES256", use: "sig" };
    let origin = "";
    const server = createServer((req, res) => {
        if (req.url === "/.well-known/openid-configuration") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ issuer: origin, jwks_uri: `${origin}/jwks.json` }));
            return;
        }
        if (req.url === "/jwks.json") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ keys: [jwk] }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    origin = `http://127.0.0.1:${addr.port}`;
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const input = `${b64({ alg: "ES256", typ: "JWT", kid: "probe-1" })}.${b64({
        iss: origin,
        sub: "release-probe",
        aud: "release-probe-client",
        exp: Math.floor(Date.now() / 1000) + 120,
    })}`;
    const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return {
        issuer: origin,
        clientId: "release-probe-client",
        token: `${input}.${signature}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
};

export const probeInstalledDaemon = async ({
    command,
    args = [],
    cwd,
    env,
    packageName,
    version,
    timeoutMs = 30_000,
    stopTimeoutMs = 5_000,
    writeStdout = (chunk) => process.stdout.write(chunk),
    writeStderr = (chunk) => process.stderr.write(chunk),
}) => {
    const idp = await startEphemeralOidcIssuer();
    const child = spawn(command, args, {
        cwd,
        env: {
            ...env,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_AUTH_ISSUER: idp.issuer,
            PLURNK_AUTH_CLIENT_ID: idp.clientId,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
        writeStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
        writeStderr(chunk);
    });

    let probeResult;
    let probeFailure;
    try {
        const identity = await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (outcome, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.stdout.off("data", inspect);
                child.stderr.off("data", inspect);
                child.off("error", onError);
                child.off("close", onExit);
                outcome(value);
            };
            const inspect = () => {
                const observedVersion = identityVersion(stderr, packageName);
                if (observedVersion !== null && observedVersion !== version) {
                    finish(reject, new Error(`installed daemon identified ${packageName}@${observedVersion}; expected ${packageName}@${version}`));
                    return;
                }
                const address = startupAddress(stdout);
                if (observedVersion === version && address !== null) finish(resolve, { address });
            };
            const onError = (cause) => finish(reject, cause);
            const onExit = (code, signal) => finish(
                reject,
                new Error(`installed daemon exited before readiness (${code ?? signal ?? "unknown"})\nstdout:\n${stdout}\nstderr:\n${stderr}`),
            );
            const timer = setTimeout(
                () => finish(reject, new Error(`installed daemon did not identify a live listener within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
                timeoutMs,
            );
            child.stdout.on("data", inspect);
            child.stderr.on("data", inspect);
            child.once("error", onError);
            child.once("close", onExit);
        });

        const url = new URL(identity.address);
        if (url.hostname !== "127.0.0.1" || url.port === "" || url.port === "0") {
            throw new Error(`installed daemon announced invalid probe address ${identity.address}`);
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`installed daemon exited before its listener probe (${child.exitCode ?? child.signalCode})`);
        }
        // {§acp-http-authorization} {§auth-oauth}: verify RFC 9728 protected-resource metadata and ES256 JWKS bearer admission.
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        await listenerProblem(response, 401, "bearer-token-required");
        const challenge = response.headers.get("www-authenticate") ?? "";
        const metadataUrl = new URL("/.well-known/oauth-protected-resource", url);
        if (!/^Bearer\s/iu.test(challenge) || !challenge.includes(`resource_metadata="${metadataUrl.href}"`)) {
            throw new Error("installed daemon listener did not advertise its Bearer credential authority");
        }
        const metaResponse = await fetch(metadataUrl, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        if (metaResponse.status !== 200 || !metaResponse.headers.get("content-type")?.startsWith("application/json")) {
            throw new Error(`installed daemon protected-resource metadata returned ${metaResponse.status}`);
        }
        const metaDoc = await metaResponse.json();
        if (!Array.isArray(metaDoc?.authorization_servers) || metaDoc.authorization_servers[0] !== idp.issuer) {
            throw new Error("installed daemon protected-resource metadata did not advertise the configured OIDC issuer");
        }
        const admitted = await fetch(url, {
            headers: { authorization: `Bearer ${idp.token}` },
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
        });
        await listenerProblem(admitted, 404, "route-not-found");
        probeResult = { address: url.href, pid: child.pid };
    } catch (cause) {
        probeFailure = cause;
    }
    let cleanupFailure;
    try {
        if (probeFailure === undefined || (child.exitCode === null && child.signalCode === null)) {
            await stopChild(child, stopTimeoutMs);
        }
    } catch (cause) {
        cleanupFailure = cause;
    } finally {
        await idp.close().catch(() => {});
    }
    if (probeFailure !== undefined && cleanupFailure !== undefined) {
        throw new AggregateError(
            [probeFailure, cleanupFailure],
            "installed daemon probe and teardown failed",
        );
    }
    if (probeFailure !== undefined) throw probeFailure;
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (probeResult === undefined) throw new Error("installed daemon probe settled without a result");
    return probeResult;
};
