import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

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
    const secret = randomBytes(32).toString("base64url");
    const child = spawn(command, args, {
        cwd,
        env: {
            ...env,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_SECRET: secret,
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
        // {§acp-http-authorization} {§auth-oauth-clients}: the probe exercises the
        // shipped authentication posture with its own credential, never the operator's.
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        await listenerProblem(response, 401, "bearer-token-required");
        const challenge = response.headers.get("www-authenticate") ?? "";
        const metadata = new URL("/.well-known/oauth-protected-resource", url);
        if (!/^Bearer\s/iu.test(challenge) || !challenge.includes(`resource_metadata="${metadata.href}"`)) {
            throw new Error("installed daemon listener did not advertise its Bearer credential authority");
        }
        const tokenResponse = await fetch(new URL("/oauth/token", url), {
            method: "POST",
            headers: { authorization: `Basic ${Buffer.from(`operator:${secret}`).toString("base64")}` },
            body: new URLSearchParams({ grant_type: "client_credentials", scope: "acp", resource: url.href }),
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (tokenResponse.status !== 200 || !tokenResponse.headers.get("content-type")?.startsWith("application/json")) {
            throw new Error(`installed daemon token exchange returned ${tokenResponse.status} ${tokenResponse.headers.get("content-type") ?? "without content type"}`);
        }
        const token = await tokenResponse.json();
        if (typeof token?.access_token !== "string" || token.access_token.length === 0
            || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
            throw new Error("installed daemon token exchange did not return a Bearer access token");
        }
        const admitted = await fetch(url, {
            headers: { authorization: `Bearer ${token.access_token}` },
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
        // A premature exit is already the probe failure. Otherwise validate
        // shutdown, including a child that exited just after the HTTP probe.
        if (probeFailure === undefined || (child.exitCode === null && child.signalCode === null)) {
            await stopChild(child, stopTimeoutMs);
        }
    }
    catch (cause) { cleanupFailure = cause; }
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
