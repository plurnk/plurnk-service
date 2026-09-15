import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const run = (
    command: string,
    args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: path.resolve(import.meta.dirname, "../../.."),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
    });

interface Check {
    readonly source: string;
    readonly status?: string;
    readonly id?: string;
    readonly description?: string;
    readonly errorMessage?: string;
}

const readChecks = async (directory: string): Promise<Check[]> => {
    const result: Check[] = [];
    for await (const relative of glob("**/checks.json", { cwd: directory })) {
        const checks = JSON.parse(await readFile(path.join(directory, relative), "utf8")) as Omit<Check, "source">[];
        result.push(...checks.map((check) => ({ ...check, source: relative.replace(/\/checks\.json$/, "") })));
    }
    return result;
};

for (const { name, selection, requiredChecks } of [
    {
        name: "official 2026-07-28 client requirements exercise the Plurnk host",
        selection: ["--requirements", "2026-07-28"],
        requiredChecks: [],
    },
    {
        name: "{§oauth-client-credentials} official client-secret extension checks exercise the Plurnk grant",
        selection: ["--scenario", "auth/client-credentials-basic"],
        requiredChecks: ["client-credentials-basic-auth", "valid-bearer-token"],
    },
]) {
test(name, {
    timeout: 120_000,
}, async (t) => {
    const output = await mkdtemp(path.join(tmpdir(), "plurnk-mcp-conformance-"));
    t.after(() => rm(output, { recursive: true, force: true }));

    const result = await run(process.execPath, [
        "node_modules/@modelcontextprotocol/conformance/dist/index.js",
        "client",
        "--command",
        `${process.execPath} --conditions=plurnk-dev --env-file=plurnk-mcp/.env.defaults plurnk-mcp/test/conformance-client.ts`,
        ...selection,
        "--output-dir",
        output,
    ]);

    const checks = await readChecks(output);
    const failures = checks.filter(({ status }) => status === "FAILURE");
    const report = failures.map((check) => [
        check.source, check.id ?? "unknown-check", check.description, check.errorMessage,
    ].filter(Boolean).join(": ")).join("\n");
    // {§mcp-conformance}: the official verdict owns required vs not_scored checks.
    assert.equal(
        result.code,
        0,
        `official MCP conformance failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nreport:\n${report}`,
    );
    assert.ok(checks.some(({ status }) => status === "SUCCESS"), `no successful checks were recorded; a skipped run is not a pass\n${result.stdout}`);
    for (const id of requiredChecks) {
        assert.ok(checks.some((check) => check.id === id && check.status === "SUCCESS"), `required check '${id}' did not pass`);
    }
});
}
