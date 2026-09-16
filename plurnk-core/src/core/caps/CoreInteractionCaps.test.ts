import test from "node:test";
import assert from "node:assert/strict";
import CoreInteractionCaps from "./CoreInteractionCaps.ts";
import type { Db } from "../Db.ts";
import type { PlurnkSchemeContext } from "../scheme-types.ts";

for (const abort of ["owner", "interaction"] as const) {
    test(`{§scheme-interactions}: the ${abort} signal can cancel a narrowed interaction`, async () => {
        const owner = new AbortController();
        const interaction = new AbortController();
        let forwarded: AbortSignal | undefined;
        const context: PlurnkSchemeContext = {
            db: {} as Db,
            workspaceId: 1, workerId: 2, loopId: 3, turnId: 4,
            writer: "model", signal: owner.signal, weigh: () => 0,
            requestInteraction: async (_request, signal) => {
                forwarded = signal;
                return { status: "cancelled" };
            },
        };
        await new CoreInteractionCaps(context).request({
            toolName: "example", arguments: {}, message: "Choose.", responseSchema: { type: "boolean" },
        }, interaction.signal);
        assert.ok(forwarded);
        assert.equal(forwarded.aborted, false);
        const reason = new Error(`${abort} ended`);
        (abort === "owner" ? owner : interaction).abort(reason);
        assert.equal(forwarded.aborted, true);
        assert.equal(forwarded.reason, reason);
        assert.equal((abort === "owner" ? interaction : owner).signal.aborted, false,
            "narrowed cancellation does not abort another owner");
    });
}
