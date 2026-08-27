import { spawn } from "node:child_process";

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

export const stopChild = async (child, timeoutMs = 5_000) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = childClose(child);
    child.kill("SIGTERM");
    if (await within(exited, timeoutMs) !== null) return;
    child.kill("SIGKILL");
    if (await within(exited, timeoutMs) === null) {
        throw new Error(`release probe child ${child.pid ?? "unknown"} did not exit after SIGKILL`);
    }
};

const identityVersion = (stderr, packageName) => {
    const marker = `plurnk-service: ${packageName}@`;
    const line = stderr.split("\n").find((candidate) => candidate.startsWith(marker));
    return line?.slice(marker.length).split(/\s/, 1)[0] ?? null;
};

const startupAddress = (stdout) => {
    const match = stdout.match(/(?:^|\n)plurnk-service agui=(http:\/\/[^\s]+)/);
    return match?.[1] ?? null;
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
    const child = spawn(command, args, {
        cwd,
        env: {
            ...env,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
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
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.status !== 404 || !response.headers.get("content-type")?.startsWith("application/problem+json")) {
            throw new Error(`installed daemon listener returned ${response.status} ${response.headers.get("content-type") ?? "without content type"}`);
        }
        const problem = await response.json();
        if (typeof problem !== "object"
            || problem === null
            || problem.type !== "https://problems.plurnk.xyz/agui/http/route-not-found") {
            throw new Error("installed daemon listener did not return the AG-UI route-not-found Problem");
        }
        probeResult = { address: url.origin, pid: child.pid };
    } catch (cause) {
        probeFailure = cause;
    }
    let cleanupFailure;
    try { await stopChild(child, stopTimeoutMs); }
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
