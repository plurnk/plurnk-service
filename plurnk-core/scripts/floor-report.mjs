// Packet Token Floor report — a measurement INSTRUMENT, never a gate.
// Operator ruling (2026-08-23): no floor tripwire — "those kinds of tripwires
// can interfere with complex jobs." This script therefore ALWAYS exits 0; a
// broken measurement prints loudly and yields nothing else.
//
// The metric: input weight of the FIRST model call for a fresh worker in an
// empty project under default config — the price of existing, before any work.
// Decomposed with the packet's own per-row accounting (tokensActive is the
// daemon's exact weigher, embedded in each jsonplurnk row).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "../test/intg/_rpc.ts";

class Capture extends Mock {
    requests = [];
    generate(...args) {
        this.requests.push(args[0]);
        return super.generate(...args);
    }
}

const approxTokens = (text) => Math.round(text.length / 3.8);

try {
    const provider = new Capture({
        contextWindow: 65536,
        responses: [{ assistant: { content: "# PLAN0\n\n## SEND0 [200]\nfloor.", reasoning: null } }],
    });
    const root = await mkdtemp(join(tmpdir(), "plurnk-floor-"));
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", {
                    name: `floor-${crypto.randomUUID()}`,
                    projectRoot: root,
                });
                await runLoopToTerminal(ws, 2, { prompt: "ping", policy: { proposals: "accept" } });
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }

    const first = provider.requests[0];
    if (first === undefined) throw new Error("no model request was captured");
    const messages = first.messages ?? [];
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");

    // The packet's own accounting: every jsonplurnk row reports tokensActive/tokensMetadata.
    const rows = [...user.matchAll(/^\{"path":"([^"]+)".*$/gm)].map((m) => {
        const active = Number(/"tokensActive":(\d+)/.exec(m[0])?.[1] ?? 0);
        const bodyTokens = Number(/"tokensBody":(\d+)/.exec(m[0])?.[1] ?? 0);
        const open = /"body":/.test(m[0]);
        return { path: m[1], active, metadata: active - (open ? bodyTokens : 0) };
    });
    const byOp = new Map();
    for (const row of rows) {
        const op = row.path.split("/").pop() ?? "?";
        byOp.set(op, (byOp.get(op) ?? 0) + row.active);
    }
    const rowActive = rows.reduce((sum, row) => sum + row.active, 0);
    const rowMetadata = rows.reduce((sum, row) => sum + row.metadata, 0);
    const systemTokens = approxTokens(system);
    const userTokens = approxTokens(user);

    console.log("packet token floor (fresh worker, empty project, mock model) — report only, never a gate");
    console.log(`  system prompt : ~${systemTokens} tok (${system.length} chars)`);
    console.log(`  user packet   : ~${userTokens} tok (${user.length} chars)`);
    console.log(`    log rows    : ${rows.length} rows, ${rowActive} tok active, ${rowMetadata} metadata — daemon-weighed (mock weigher; ratios comparable, scale differs from the ~ estimates)`);
    console.log(`    by op       : ${[...byOp].map(([op, tok]) => `${op} ${tok}`).join(" · ")}`);
    console.log(`  FLOOR (approx): ~${systemTokens + userTokens} tok`);
} catch (error) {
    console.log(`floor report unavailable (never fails the drill): ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
