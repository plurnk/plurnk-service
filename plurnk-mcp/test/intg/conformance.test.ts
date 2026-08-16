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

const failureReport = async (directory: string): Promise<string> => {
    const failures: string[] = [];
    for await (const relative of glob("**/checks.json", { cwd: directory })) {
        const checks = JSON.parse(await readFile(path.join(directory, relative), "utf8")) as readonly {
            readonly status?: string;
            readonly id?: string;
            readonly description?: string;
            readonly errorMessage?: string;
        }[];
        for (const check of checks.filter(({ status }) => status === "FAILURE")) {
            failures.push([
                relative.replace(/\/checks\.json$/, ""),
                check.id ?? "unknown-check",
                check.description ?? "",
                check.errorMessage ?? "",
            ].filter(Boolean).join(": "));
        }
    }
    return failures.length === 0 ? "no failed checks were recorded" : failures.join("\n");
};

test("official 2026-07-28 client requirements exercise the Plurnk host", {
    timeout: 120_000,
}, async (t) => {
    const output = await mkdtemp(path.join(tmpdir(), "plurnk-mcp-conformance-"));
    t.after(() => rm(output, { recursive: true, force: true }));

    const result = await run(process.execPath, [
        "node_modules/@modelcontextprotocol/conformance/dist/index.js",
        "client",
        "--command",
        `${process.execPath} --conditions=plurnk-dev --env-file=plurnk-mcp/.env.defaults plurnk-mcp/test/conformance-client.ts`,
        "--requirements",
        "2026-07-28",
        "--output-dir",
        output,
    ]);

    const report = result.code === 0 ? "" : await failureReport(output);
    assert.equal(
        result.code,
        0,
        `official MCP conformance failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nreport:\n${report}`,
    );
});
