import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type ApplicationOperationEvent, type ProposalProjection } from "@plurnk/plurnk-contracts";
import EventProjection from "./EventProjection.ts";

const started: ApplicationOperationEvent = {
    workerId: 7, loopId: 9, turnId: 11, sequence: 2, origin: "model", projectRoot: "/project", phase: "started",
    statement: { op: "READ", target: { kind: "local", raw: "README.md" },
        aside: null, metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION },
};

test("{§hooks-event-projection} operation phase/status select hooks without treating system observations as tools", () => {
    for (const origin of ["model", "client", "_plurnk"] as const) {
        for (const status of [200, 202, 400, 499]) {
            const result = { status, detail: "Exact fixture result" };
            const params = { ...started, origin, phase: "settled" as const, result };
            const event = EventProjection.project(42, "operation/event", params);
            if (origin === "_plurnk") {
                assert.equal(event, null);
                continue;
            }
            assert.deepEqual(event, {
                hook_event_name: status >= 400 ? "PostToolUseFailure" : "PostToolUse",
                session_id: "7", cwd: "/project", tool_use_id: "11/2", tool_name: "READ",
                tool_input: started.statement, tool_response: result,
                plurnk: { workspaceId: 42, method: "operation/event", params },
            });
        }
    }
    const headless = EventProjection.project(42, "operation/event", { ...started, projectRoot: null });
    assert.equal(headless?.hook_event_name, "PreToolUse");
    assert.equal(Object.hasOwn(headless!, "cwd"), false);
    assert.equal(Object.hasOwn(headless!, "tool_response"), false);
    assert.equal(EventProjection.project(42, "log/entry", { entry: { op: "READ" } }), null);
    assert.equal(EventProjection.project(42, "stream/concluded", { result: { status: 200 } }), null);
});

test("{§hooks-event-projection} only client-owned proposals request permission", () => {
    const proposal: ProposalProjection = { logEntryId: 12, workerId: 7, loopId: 9, turnId: 11, op: "sh",
        target: { scheme: "exec", authority: "sh", pathname: "" }, body: "echo 42", attrs: {},
        policy: { proposals: "review", attended: true }, disposition: { owner: "client" } };
    const event = EventProjection.project(42, "loop/proposal", proposal);
    assert.equal(event?.hook_event_name, "PermissionRequest");
    assert.equal(event?.tool_name, "sh");
    assert.deepEqual(event?.tool_input, { target: proposal.target, body: proposal.body, attrs: proposal.attrs });
    for (const decision of ["accept", "reject"] as const) {
        assert.equal(EventProjection.project(42, "loop/proposal", { ...proposal, disposition: { owner: "loop", decision } }), null);
    }
});
