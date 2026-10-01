import assert from "node:assert/strict";
import test from "node:test";
import Validator from "./Validator.ts";
import schema from "../schema/ApplicationOperationEvent.json" with { type: "json" };
import { UNKNOWN_POSITION } from "./types.ts";

test("{§notifications-operation-event} dispatch observations preserve the phase/result boundary", () => {
    const start = {
        workerId: 7, loopId: 9, turnId: 11, sequence: 2, origin: "model", projectRoot: null, phase: "started",
        statement: { op: "READ", target: { kind: "local", raw: "README.md" },
            aside: null, metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION },
    };
    const validate = (value: unknown) => Validator.validateJsonSchemaInstance(schema, value);
    for (const value of [start, { ...start, phase: "settled", result: { status: 200, content: "read body" } }]) {
        const result = validate(value);
        assert.equal(result.valid, true, JSON.stringify(result.errors));
    }
    for (const value of [
        { ...start, result: { status: 200 } },
        { ...start, phase: "settled" },
        { ...start, phase: "finished" },
        { ...start, sequence: 0 },
        { ...start, origin: "guessed-client" },
    ]) assert.equal(validate(value).valid, false, JSON.stringify(value));
});
