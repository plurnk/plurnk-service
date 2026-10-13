// {§a2a-protocol-witness} {§tier-census} — the upstream A2A Technology Compatibility Kit, an independent
// Python HTTP+JSON client, against a real daemon whose only scripted part is inference. The specimen
// requires `uv` and the pinned TCK checkout (PLURNK_A2A_TCK_CHECKOUT, else `../a2a-tck`) and skips
// by name otherwise; its evidence (service log, checker log, compatibility report, JUnit) lands in
// the run directory beside the daemon's database and digest.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { liveTest as test } from "../live-test.ts";
import { liveRun } from "../_live-harness.ts";
import { checkoutPath } from "../live-requirements.ts";

const REVISION = "263b9cfaf16a554bdfb166a7ba5b67716e946349";
const CORE = resolve(import.meta.dirname, "../..");

test("live a2a: the upstream TCK's HTTP+JSON requirement tiers pass against the assembled daemon", {
    timeout: 1_200_000,
    requires: ["bin:uv", "checkout:a2a-tck"],
}, async () => {
    const upstream = checkoutPath("a2a-tck");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: upstream, encoding: "utf8" }).trim();
    assert.equal(head, REVISION, `the TCK checkout at ${upstream} is at the pinned revision`);
    assert.equal(dirty, "", `the TCK checkout at ${upstream} is unmodified`);

    const run = await liveRun("live-a2a-tck");
    const serviceLog = await open(join(run.runDir, "service.log"), "w");
    await writeFile(join(run.runDir, "run.json"), `${JSON.stringify({
        tck: { repository: "https://github.com/a2aproject/a2a-tck", revision: REVISION },
        specification: JSON.parse(await readFile(join(upstream, "specification/version.json"), "utf8")),
        provider: "Mock (no inference spend)",
        startedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const service = spawn(process.execPath, [
        "--conditions=plurnk-dev", "--import=./test/setup.ts", "--env-file-if-exists=.env.defaults",
        "test/fixtures/a2a-tck.ts", run.dbPath,
    ], { cwd: CORE, stdio: ["ignore", serviceLog.fd, serviceLog.fd, "ipc"] });
    const closed = once(service, "close");
    try {
        const ready = await Promise.race([
            once(service, "message", { signal: AbortSignal.timeout(30_000) }).then(([message]) => message as { baseUrl?: unknown }),
            closed.then(([code, signal]) => { throw new Error(`A2A fixture exited before readiness (${code ?? signal}).`); }),
        ]);
        assert.equal(typeof ready?.baseUrl, "string", "the A2A fixture published its base URL");
        const args = [
            "run", "--frozen", "pytest", "tests/compatibility/",
            `--sut-host=${ready.baseUrl}`, "--transport=http_json", "--tb=short", "-q", "-rxXs",
            `--compatibility-report=${join(run.runDir, "compatibility")}`,
            `--html=${join(run.runDir, "report.html")}`, "--self-contained-html",
            `--junitxml=${join(run.runDir, "junit.xml")}`,
        ];
        await writeFile(join(run.runDir, "command.json"), `${JSON.stringify(["uv", ...args], null, 2)}\n`);
        const output = createWriteStream(join(run.runDir, "tck.log"));
        let code: number | null;
        let signal: NodeJS.Signals | null;
        try {
            const checker = spawn("uv", args, { cwd: upstream, stdio: ["ignore", "pipe", "pipe"] });
            checker.stdout.pipe(output, { end: false });
            checker.stderr.pipe(output, { end: false });
            [code, signal] = await once(checker, "close") as [number | null, NodeJS.Signals | null];
            output.end();
            await once(output, "finish");
        } finally {
            output.destroy();
        }
        await writeFile(join(run.runDir, "result.json"), `${JSON.stringify({ code, signal, finishedAt: new Date().toISOString() }, null, 2)}\n`);
        assert.equal(code, 0, `the checker exited ${code ?? signal}; its log is ${join(run.runDir, "tck.log")}`);
    } finally {
        service.kill("SIGTERM");
        const kill = setTimeout(() => service.kill("SIGKILL"), 10_000);
        try { await closed; }
        finally { clearTimeout(kill); await serviceLog.close(); run.finish(); }
    }
});
