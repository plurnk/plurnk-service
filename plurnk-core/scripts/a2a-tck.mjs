import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import HostPaths from "../src/core/HostPaths.ts";

const revision = "263b9cfaf16a554bdfb166a7ba5b67716e946349";
const core = resolve(import.meta.dirname, "..");
const checkout = process.argv[2];
if (!checkout || process.argv.length > 3) {
    throw new Error("Usage: npm run test:a2a:tck -- <a2a-tck checkout>; see plurnk-a2a/test/README.md");
}
const upstream = resolve(checkout);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: upstream, encoding: "utf8" }).trim();
if (head !== revision || dirty) throw new Error(`The TCK checkout must be unmodified at ${revision}.`);

const artifactsRoot = new HostPaths().expandUserPath("~/benchmarks");
await mkdir(artifactsRoot, { recursive: true });
const artifacts = await mkdtemp(join(artifactsRoot, "a2a-tck-"));
const serviceLog = await open(join(artifacts, "service.log"), "w");
const metadata = {
    tck: { repository: "https://github.com/a2aproject/a2a-tck", revision },
    specification: JSON.parse(await readFile(join(upstream, "specification/version.json"), "utf8")),
    service: execFileSync("git", ["rev-parse", "HEAD"], { cwd: core, encoding: "utf8" }).trim(),
    serviceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: core, encoding: "utf8" }).trim().length > 0,
    provider: "Mock (no inference spend)",
    startedAt: new Date().toISOString(),
};
await writeFile(join(artifacts, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`A2A TCK evidence: ${artifacts}\n`);

const service = spawn(process.execPath, [
    "--conditions=plurnk-dev", "--import=./test/setup.ts", "--env-file-if-exists=.env.defaults",
    "test/fixtures/a2a-tck.ts", join(artifacts, "plurnk.db"),
], { cwd: core, stdio: ["ignore", serviceLog.fd, serviceLog.fd, "ipc"] });
const closed = once(service, "close");
try {
    const ready = await Promise.race([
        once(service, "message", { signal: AbortSignal.timeout(30_000) }).then(([message]) => message),
        closed.then(([code, signal]) => { throw new Error(`A2A fixture exited before readiness (${code ?? signal}).`); }),
    ]);
    if (typeof ready?.baseUrl !== "string") throw new Error("A2A fixture did not publish a base URL.");
    const args = [
        "run", "--frozen", "pytest", "tests/compatibility/",
        `--sut-host=${ready.baseUrl}`, "--transport=http_json", "--tb=short", "-q", "-rxXs",
        `--compatibility-report=${join(artifacts, "compatibility")}`,
        `--html=${join(artifacts, "report.html")}`, "--self-contained-html",
        `--junitxml=${join(artifacts, "junit.xml")}`,
    ];
    await writeFile(join(artifacts, "command.json"), `${JSON.stringify(["uv", ...args], null, 2)}\n`);
    const output = createWriteStream(join(artifacts, "tck.log"));
    try {
        const checker = spawn("uv", args, { cwd: upstream, stdio: ["ignore", "pipe", "pipe"] });
        checker.stdout.on("data", (chunk) => { process.stdout.write(chunk); });
        checker.stderr.on("data", (chunk) => { process.stderr.write(chunk); });
        checker.stdout.pipe(output, { end: false });
        checker.stderr.pipe(output, { end: false });
        const [code, signal] = await once(checker, "close");
        output.end();
        await once(output, "finish");
        process.exitCode = code ?? 1;
        await writeFile(join(artifacts, "result.json"), `${JSON.stringify({ code, signal, finishedAt: new Date().toISOString() }, null, 2)}\n`);
    } finally {
        output.destroy();
    }
} finally {
    service.kill("SIGTERM");
    const kill = setTimeout(() => service.kill("SIGKILL"), 10_000);
    try { await closed; }
    finally { clearTimeout(kill); await serviceLog.close(); }
}
