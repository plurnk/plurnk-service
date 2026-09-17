import assert from "node:assert/strict";
import { jsonpatch, type JSONValue } from "json-p3";
import type { AguiEvent } from "../src/types.ts";

// {§agui-state-patches}: use RFC 6902, not a second implementation of the client reducer.
export const replayState = (events: readonly AguiEvent[]): JSONValue | undefined => {
    let state: JSONValue | undefined;
    for (const event of events) {
        if (event.type === "STATE_SNAPSHOT") state = structuredClone(event.snapshot);
        if (event.type !== "STATE_DELTA") continue;
        assert.notEqual(state, undefined, "STATE_DELTA requires a preceding STATE_SNAPSHOT");
        for (const patch of event.delta) assert.equal(patch.op, "replace", `unexpected patch operation at ${patch.path}`);
        state = jsonpatch.apply(event.delta, state!);
    }
    return state;
};
