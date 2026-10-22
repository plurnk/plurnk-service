// {§env-option} {§agui-client-operation} A person's command carries its own environment: `op.exec`'s `env` is the
// execution's layer over the workspace's, and the env family's admission refuses a name before anything runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { AguiEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (port: number, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<AguiEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/agui`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], ...input }),
    });
    assert.equal(response.status, 200);
    return (await response.text())
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
};

// Each `env` an action can carry: what the command then finds in its environment, or the refusal that names the
// offending key — the family's admission by its alias, the action's schema by its location — when it never runs.
type Refusal = { readonly alias: string } | { readonly at: string };
const SHAPES: ReadonlyArray<{ readonly label: string; readonly env?: unknown; readonly written?: string; readonly refusal?: Refusal }> = [
    { label: "no env", written: "" },
    { label: "an empty env", env: {}, written: "" },
    { label: "a value", env: { GREETING: "Hello" }, written: "Hello" },
    { label: "plurnk's own name", env: { PLURNK_GREETING: "Hello" }, refusal: { alias: "PLURNK_GREETING" } },
    { label: "a name a shell cannot export", env: { "9GREETING": "Hello" }, refusal: { alias: "9GREETING" } },
    { label: "a value that is not a string", env: { GREETING: 42 }, refusal: { at: "#/env/GREETING" } },
];

for (const shape of SHAPES) {
    test(`{§env-option} {§agui-client-operation} op.exec with ${shape.label} ${shape.refusal === undefined ? "runs in that environment" : "is refused before the command runs"}`, { timeout: 30_000 }, async (t) => {
        await import(join(SERVICE, "test/setup.ts"));
        const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
        const db = await openTestDatabase();
        const root = await mkdtemp(join(tmpdir(), "plurnk-operation-env-"));
        const http = await bindListener();
        const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules"), http });
        t.after(async () => {
            await daemon.stop();
            await http.close();
            await db.close();
            await rm(root, { recursive: true, force: true });
        });
        await daemon.start();
        const action = { kind: "op.exec", command: "printf %s \"$GREETING\" > greeting.txt", ...(shape.env === undefined ? {} : { env: shape.env }) };
        const events = await post(http.httpAddress().port, {
            threadId: "operation-env",
            forwardedProps: { plurnk: { workspace: "operation-env", projectRoot: root, action } },
        }, t.signal);
        const result = (events.find(({ type }) => type === "RUN_FINISHED") as { result?: {
            ok?: boolean;
            problem?: { status?: number; alias?: string; issues?: ReadonlyArray<{ instanceLocation?: string }> };
        } } | undefined)?.result;
        const written = await readFile(join(root, "greeting.txt"), "utf8").catch(() => null);
        const { refusal } = shape;
        if (refusal === undefined) {
            assert.equal(result?.ok, true, JSON.stringify(result));
            assert.equal(written, shape.written, "the command sees the environment the action carried, and only that");
            return;
        }
        assert.equal(result?.ok, false, JSON.stringify(result));
        assert.equal(result?.problem?.status, 400, "a refused environment is the request's own fault");
        if ("alias" in refusal) {
            assert.equal(result?.problem?.alias, refusal.alias, "the family's refusal names the key");
        } else {
            const { at } = refusal;
            assert.ok(result?.problem?.issues?.some(({ instanceLocation }) => instanceLocation === at), `the schema names ${at}: ${JSON.stringify(result?.problem)}`);
        }
        assert.equal(written, null, "nothing runs under a refused environment");
    });
}
