import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Module from "./Module.ts";

interface SeamFixture {
    readonly seam: {
        subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void;
    };
    emit(workspaceId: number | null, method: string, params: unknown): void;
    subscribed(): boolean;
}

const seamFixture = (): SeamFixture => {
    let handler: ((workspaceId: number | null, method: string, params: unknown) => void) | null = null;
    return {
        seam: {
            subscribeToEvents(next) {
                handler = next;
                return () => { handler = null; };
            },
        },
        emit(workspaceId, method, params) {
            if (handler === null) throw new Error("fixture has no event subscriber");
            handler(workspaceId, method, params);
        },
        subscribed: () => handler !== null,
    };
};

test("[{§hooks-command-delivery}] selected events reach one no-shell command as exact JSON stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hooks-"));
    try {
        const script = join(root, "capture.mjs");
        const output = join(root, "captured.json");
        const shellSideEffect = join(root, "must-not-exist");
        await writeFile(script, [
            'import { writeFile } from "node:fs/promises";',
            'let input = "";',
            'process.stdin.setEncoding("utf8");',
            'for await (const chunk of process.stdin) input += chunk;',
            'await writeFile(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), input }));',
        ].join("\n"));

        const module = Module.init({
            env: {
                PLURNK_HOOKS_COMMAND: process.execPath,
                PLURNK_HOOKS_ARGS: JSON.stringify([
                    script,
                    output,
                    `literal;touch ${shellSideEffect}`,
                ]),
                PLURNK_HOOKS_EVENTS: "loop/terminated",
                PLURNK_HOOKS_TIMEOUT_MS: "30000",
            },
        });
        const fixture = seamFixture();
        module.start(fixture.seam);
        fixture.emit(42, "notice/event", { loopId: 9 });
        fixture.emit(42, "loop/terminated", {
            workerId: 7,
            loopId: 9,
            result: { status: 200 },
        });
        await module.close();

        const captured = JSON.parse(await readFile(output, "utf8")) as { argv: string[]; input: string };
        assert.deepEqual(captured.argv, [`literal;touch ${shellSideEffect}`]);
        assert.equal(existsSync(shellSideEffect), false);
        assert.equal(captured.input, `${JSON.stringify({
            workspaceId: 42,
            method: "loop/terminated",
            params: {
                workerId: 7,
                loopId: 9,
                result: { status: 200 },
            },
        })}\n`);
        assert.equal(fixture.subscribed(), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("[{§hooks-failure-isolation}] command failures are reported after the event source returns", async () => {
    const reports: Array<{ message: string; cause: unknown }> = [];
    const module = Module.init({
        env: {
            PLURNK_HOOKS_COMMAND: "/missing/plurnk-hook",
            PLURNK_HOOKS_EVENTS: "notice/event",
            PLURNK_HOOKS_TIMEOUT_MS: "30000",
        },
        report: (message, cause) => { reports.push({ message, cause }); },
    });
    const fixture = seamFixture();
    module.start(fixture.seam);

    assert.doesNotThrow(() => fixture.emit(4, "notice/event", { loopId: 3 }));
    await module.close();

    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /hook command failed for notice\/event/);
    assert.ok(reports[0].cause instanceof Error);
});

test("[{§hooks-failure-isolation}] nonzero exits and delivery timeouts are reported", async (t) => {
    for (const specimen of [
        {
            name: "nonzero exit",
            args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(9));"],
            timeout: "30000",
            cause: /exited with status 9/,
        },
        {
            name: "timeout",
            args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
            timeout: "20",
            cause: /aborted/i,
        },
    ]) {
        await t.test(specimen.name, async () => {
            const reports: Array<{ message: string; cause: unknown }> = [];
            const module = Module.init({
                env: {
                    PLURNK_HOOKS_COMMAND: process.execPath,
                    PLURNK_HOOKS_ARGS: JSON.stringify(specimen.args),
                    PLURNK_HOOKS_EVENTS: "loop/terminated",
                    PLURNK_HOOKS_TIMEOUT_MS: specimen.timeout,
                },
                report: (message, cause) => { reports.push({ message, cause }); },
            });
            const fixture = seamFixture();
            module.start(fixture.seam);
            fixture.emit(2, "loop/terminated", { workerId: 3, loopId: 4 });
            await module.close();

            assert.equal(reports.length, 1);
            assert.match(reports[0].message, /hook command failed for loop\/terminated/);
            assert.match(String(reports[0].cause), specimen.cause);
        });
    }
});

test("an unconfigured hooks module does not subscribe", () => {
    const module = Module.init({
        env: { PLURNK_HOOKS_TIMEOUT_MS: "30000" },
    });
    const fixture = seamFixture();
    module.start(fixture.seam);
    assert.equal(fixture.subscribed(), false);
});
