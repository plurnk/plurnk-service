// Redaction-by-default at the observational boundary ({§observability-boundary}):
// a loop whose prompt and workspace carry recognizable content — a secret
// sentinel, a fixture fact, a hostname, and a .example URL — must never leak any
// of it into exported span names, attributes, or events.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { withDaemon, connect, rpcCall, runLoopToTerminal } from "./_rpc.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";

const SECRET = "secret-xyzzy-9371";
const FACT = "phoenix-briefing";
const HOST = "db.internal";
const URL = "https://leak.example/path";

const settleExports = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const serialized = (spans: ReturnType<{ spans(): unknown[] }["spans"]>): string => {
    const parts: string[] = [];
    for (const span of spans as Array<Record<string, unknown>>) {
        parts.push(String(span.name));
        for (const [key, value] of Object.entries((span.attributes ?? {}) as Record<string, unknown>)) {
            parts.push(`${key}=${String(value)}`);
        }
        for (const event of (span.events ?? []) as Array<{ name: string; attributes?: Record<string, unknown> }>) {
            parts.push(`event:${event.name}`);
            for (const [key, value] of Object.entries(event.attributes ?? {})) parts.push(`${key}=${String(value)}`);
        }
    }
    return parts.join("\n");
};

test("observe: prompts, bodies, hosts, URLs, and secrets never cross the boundary", async () => {
    const memory = await mountMemoryTracing();
    try {
        const provider = new Mock({
            contextWindow: 8192,
            responses: [{
                assistant: {
                    content: `# PLAN1\ncurate:\n\n## SEND1 [200]\ntask complete.`,
                    reasoning: null,
                },
            }],
        });
        await withDaemon(provider, async (db, daemon) => {
            const ws = await connect({ daemon });
            const created = (await rpcCall(ws, 1, "workspace.create", {
                name: "redaction-probe", projectRoot: null,
            })).result as { id: number };
            assert.ok(Number.isInteger(created.id));
            const term = await runLoopToTerminal(ws, 2, {
                prompt: `The codename is ${FACT}, the host is ${HOST}, and the vault secret is ${SECRET}. Read ${URL} to confirm.`,
                flags: { auto: true },
            }, { timeoutMs: 60_000 });
            assert.equal(term.finalStatus, 200);
        });
        await settleExports();

        const text = serialized(memory.spans());
        for (const forbidden of [SECRET, FACT, HOST, URL, "leak.example", "secret-"] as const) {
            assert.ok(!text.includes(forbidden), `span surface must not contain ${JSON.stringify(forbidden)}`);
        }
        assert.ok(text.includes("loop.run"), "the boundary still exports its topology names");
    } finally {
        await memory.shutdown();
    }
});
