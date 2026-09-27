// Integration harness: the executor registry fixtures and execution-output addressing.

import type { Db } from "../../src/core/Db.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

// Boot-style executor registry for execution tests. Memoized — built once (discover
// + probe the installed siblings), shared across the suite. Pass to
// engine.setExecutors(...) or makeSchemeCtx({ executors }). Production wires
// this at Daemon.start(); direct-Engine fixtures must provide it themselves.
let _executorsPromise: Promise<ExecutorRegistry> | undefined;

export function testExecutors(): Promise<ExecutorRegistry> {
    _executorsPromise ??= ExecutorRegistry.build();
    return _executorsPromise;
}

// {§exec-entry-sink}: idle() settles every spawn tail, including serialized entry/narration
// writes. Tests quiesce streaming EXECs before db.close(); a long-lived child is cancelled first.
export const quiesceExecs = async (schemes: { get(name: string): unknown }): Promise<void> => {
    const exec = schemes.get("exec") as { idle?: () => Promise<void> } | undefined;
    if (exec?.idle !== undefined) await exec.idle();
};

// Follow the actual invocation receipt; output URIs do not encode log coordinates.
export const executionAddress = async (db: Db, turnId: number, sequence = 1): Promise<string> => {
    const rows = await db.test_log_entries_by_turn.all<{ sequence: number; op: string; attrs: string }>({ turn_id: turnId });
    const row = rows.find((item) => item.sequence === sequence && isExecutionOp(item.op));
    const stream: unknown = row === undefined ? undefined : JSON.parse(row.attrs).stream;
    if (typeof stream !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/\/[a-f0-9]{8}$/u.test(stream)) {
        throw new Error(`Execution ${turnId}/${sequence} did not publish a workspace output address.`);
    }
    return stream;
};

// {§exec-stream} — an execution dispatch answers `started`; the verb's outcome
// settles the channel of its `<tag>:///<loop>/<turn>/<seq>` output entry.
// Await the newest settled output for one runtime scheme and parse its JSON.
// A refusal travels on the operation's log row, never in the channel.
export const awaitExecOutcome = async (
    db: Db,
    { workspaceId, scheme, channel = "results", after = 0, timeoutMs = 5_000 }: {
        workspaceId: number;
        scheme: string;
        channel?: string;
        // Outputs already present before the dispatch under observation; the
        // reader waits for a NEWER settled output instead of an older one.
        after?: number;
        timeoutMs?: number;
    },
): Promise<Record<string, unknown>> => {
    const start = Date.now();
    for (;;) {
        const outputs = (await db.test_entries_by_scheme_prefix.all<{ pathname: string; id: number }>({ workspace_id: workspaceId, scheme, prefix: "/%" })).toSorted((a, b) => b.id - a.id);
        for (const { pathname } of outputs.length > after ? outputs : []) {
            const settled = await db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({ pathname, scheme, name: channel });
            // closed or errored — the two terminal channel states ({§stream-control}); a refused verb ends errored.
            if ((settled?.state === "closed" || settled?.state === "errored") && settled.content.length > 0) return JSON.parse(settled.content) as Record<string, unknown>;
            break; // only the newest output may still settle this dispatch
        }
        if (Date.now() - start >= timeoutMs) throw new Error(`awaitExecOutcome: no settled ${scheme} ${channel} output within ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};
