// proposal.list — every pending stop-the-world proposal in the attached session. The
// indefinite-wait ruling's mandatory companion ({§proposal-timeout-cancels}): loop/proposal is
// a NOTIFICATION — a client that reconnects during a stopped world (a file edit awaiting
// review, a [300] question awaiting its human, possibly for days) must be able to DISCOVER the
// pending proposal and re-render it, then answer via the ordinary loop.resolve.

import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";

export default class ProposalListMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("proposal.list", { // §proposal-list
            handler: async (_params, ctx) => {
                if (ctx.session === null) throw new Error("proposal.list requires an attached session");
                const rows = await (ctx.db.proposal_list_pending as PrepMethod).all<{
                    logEntryId: number; runId: number; loopId: number; turnId: number;
                    op: string; suffix: string; scheme: string | null; pathname: string | null;
                    tx: string | null; attrs: string | null; at: string; loop_flags: string | null;
                }>({ session_id: ctx.session.sessionId });
                return {
                    proposals: rows.map((r) => ({
                        logEntryId: r.logEntryId, runId: r.runId, loopId: r.loopId, turnId: r.turnId,
                        op: r.op, suffix: r.suffix,
                        target: { scheme: r.scheme, pathname: r.pathname },
                        body: ProposalListMethod.#txBody(r.tx),
                        attrs: JSON.parse(r.attrs ?? "{}") as Record<string, unknown>,
                        flags: JSON.parse(r.loop_flags ?? "{}") as Record<string, unknown>,
                        at: r.at,
                    })),
                };
            },
            description: "List every pending (state='proposed') stop-the-world proposal in the attached session — file edits, MCP auths, [300] questions — with the logEntryId loop.resolve needs. The indefinite-wait companion: a reconnecting client discovers the stopped world instead of inheriting a mystery hang.",
            params: {},
        });
    }

    static #txBody(tx: string | null): string {
        if (tx === null || tx.length === 0) return "";
        try {
            const parsed = JSON.parse(tx) as { body?: unknown };
            if (typeof parsed.body === "string") return parsed.body;
            const raw = (parsed.body as { raw?: unknown } | null)?.raw;
            return typeof raw === "string" ? raw : "";
        } catch { return ""; }
    }
}
