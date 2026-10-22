// {§a2a-protocol-witness} {§a2a-tck-rulings} {§tier-census} — the upstream A2A Technology Compatibility Kit, an
// independent Python HTTP+JSON client, against a real daemon whose only scripted part is inference. The specimen
// requires `uv` and the pinned TCK checkout (PLURNK_A2A_TCK_CHECKOUT, else `../a2a-tck`) and skips by name
// otherwise; its evidence (service log, checker log, compatibility report, JUnit) lands in the run directory
// beside the daemon's database and digest.
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

// {§a2a-tck-rulings} Each failure the checker must report: the requirement it tests and the reason it must give.
const RULED: ReadonlyMap<string, { readonly requirement: string; readonly reason: RegExp }> = new Map([
    ["tests.compatibility.core_operations.test_transport_behavior.TestRestFormat::test_response_content_type",
        { requirement: "HTTP_JSON-SVC-001", reason: /got: 'application\/a2a\+json/u }],
    ["tests.compatibility.http_json.test_problem_details.TestAIP193ErrorFormat::test_error_content_type",
        { requirement: "HTTP_JSON-ERR-001", reason: /got: 'application\/a2a\+json/u }],
    ["tests.compatibility.core_operations.test_error_handling.TestRestErrorStructure::test_error_uses_aip193_format",
        { requirement: "HTTP_JSON-ERR-001", reason: /got: 'application\/a2a\+json/u }],
    ["tests.compatibility.http_json.test_http_status.TestHttpJsonStatusCodes::test_content_type_not_supported_returns_415",
        { requirement: "HTTP_JSON-STATUS-001", reason: /ContentTypeNotSupportedError \(415\), got 400/u }],
    ["tests.compatibility.core_operations.test_task_lifecycle.TestCancelTask::test_cancel_terminal_task_returns_error[http_json]",
        { requirement: "CORE-CANCEL-002", reason: /409 \(TaskNotCancelableError\), got 400/u }],
    ["tests.compatibility.core_operations.test_artifacts.TestMessageResponse::test_returns_message_with_text_part[http_json]",
        { requirement: "DM-MSG-001", reason: /Expected a Message response, but got a Task/u }],
    ["tests.compatibility.core_operations.test_artifacts.TestDataArtifact::test_task_has_data_artifact[http_json]",
        { requirement: "DM-ART-001", reason: /Expected part type 'data', got 'text'/u }],
    ["tests.compatibility.core_operations.test_artifacts.TestFileUrlArtifact::test_task_has_file_url_artifact[http_json]",
        { requirement: "DM-ART-001", reason: /Expected file URL part \(url\), got 'text'/u }],
    ["tests.compatibility.core_operations.test_artifacts.TestFileArtifact::test_task_has_file_artifact[http_json]",
        { requirement: "DM-ART-001", reason: /Expected mediaType 'text\/plain', got 'text\/markdown'/u }],
    ["tests.compatibility.agent_card.test_agent_card_caching.TestAgentCardLastModified::test_last_modified_present",
        { requirement: "CARD-CACHE-003", reason: /may include a Last-Modified header/u }],
]);

// Every reason the checker may give for a skip, each a capability the hosted card declares or a rule of the exposure.
const EXPLAINED_SKIPS: readonly RegExp[] = [
    // {§a2a-hosted-card} HTTP+JSON is the one binding.
    /^(Transport '(grpc|jsonrpc)' not configured( \(filtered by --transport\))?|JSON-RPC transport not configured|gRPC transport not configured)$/u,
    // {§a2a-hosted-card} streaming, no push notifications, no extended card; this card declares no required extension.
    /^Agent supports streaming(; cannot trigger .+)?$/u,
    /^Agent does not support push notifications$/u,
    /^Agent does not declare extendedAgentCard capability$/u,
    /^Agent card does not declare urn:a2a:tck:required-extension as required$/u,
    // {§a2a-worker-ownership} The exposure never asks its caller for input.
    /^Expected task state 'TASK_STATE_INPUT_REQUIRED' but got 'TASK_STATE_COMPLETED'$/u,
    // The checker's own: a requirement tier with nothing at this level.
    /^No requirements at this level$/u,
];

// The checker's JUnit report: each case's outcome and the message its failure or skip carries.
const xmlText = (raw: string): string => raw.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/giu, (_entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[body.toLowerCase() as "amp" | "lt" | "gt" | "quot" | "apos"];
});
const attribute = (attributes: string, name: string): string => xmlText(new RegExp(`\\b${name}="([^"]*)"`, "u").exec(attributes)?.[1] ?? "");
const outcomes = (junit: string): Array<{ readonly id: string; readonly outcome: "passed" | "failed" | "skipped"; readonly message: string }> =>
    [...junit.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)].map(([, attributes = "", body = ""]) => {
        const id = `${attribute(attributes, "classname")}::${attribute(attributes, "name")}`;
        const failure = /<(?:failure|error)\b([^>]*)>/u.exec(body);
        if (failure !== null) return { id, outcome: "failed", message: attribute(failure[1] ?? "", "message") };
        const skipped = /<skipped\b([^>]*)>/u.exec(body);
        if (skipped !== null) return { id, outcome: "skipped", message: attribute(skipped[1] ?? "", "message") };
        return { id, outcome: "passed", message: "" };
    });

test("live a2a: the upstream TCK's HTTP+JSON requirement tiers find only the ruled divergences in the assembled daemon", {
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
            `--sut-host=${String(ready.baseUrl)}`, "--transport=http_json", "--tb=short", "-q", "-rxXs",
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
        // pytest exits 0 when every case passed and 1 when some failed; anything else is a checker that did not run.
        assert.ok(code === 0 || code === 1, `the checker exited ${code ?? signal}; its log is ${join(run.runDir, "tck.log")}`);
        const results = outcomes(await readFile(join(run.runDir, "junit.xml"), "utf8"));
        assert.ok(results.length > 0, `the checker reported its cases in ${join(run.runDir, "junit.xml")}`);
        const failed = results.filter(({ outcome }) => outcome === "failed");
        const verdict = {
            unruled: failed.filter(({ id }) => !RULED.has(id)).map(({ id, message }) => `${id}: ${message}`),
            resolved: [...RULED.keys()].filter((id) => !failed.some((result) => result.id === id)),
            reasons: failed.filter(({ id, message }) => {
                const ruled = RULED.get(id);
                return ruled !== undefined && !(message.includes(ruled.requirement) && ruled.reason.test(message));
            }).map(({ id, message }) => `${id}: ${message}`),
            unexplained: results.filter(({ outcome, message }) => outcome === "skipped" && !EXPLAINED_SKIPS.some((reason) => reason.test(message)))
                .map(({ id, message }) => `${id}: ${message}`),
        };
        await writeFile(join(run.runDir, "rulings.json"), `${JSON.stringify(verdict, null, 2)}\n`);
        assert.deepEqual(verdict, { unruled: [], resolved: [], reasons: [], unexplained: [] },
            `the checker's failures and skips match their rulings; its log is ${join(run.runDir, "tck.log")}`);
    } finally {
        service.kill("SIGTERM");
        const kill = setTimeout(() => service.kill("SIGKILL"), 10_000);
        try { await closed; }
        finally { clearTimeout(kill); await serviceLog.close(); run.finish(); }
    }
});
