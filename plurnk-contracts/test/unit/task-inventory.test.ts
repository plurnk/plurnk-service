import test from "node:test";
import assert from "node:assert/strict";
import { AcpPlanValue, PlanValue, PlurnkParser, TurnDisposition, Validator } from "../../src/index.ts";

const inventory = (statuses: readonly string[]) => statuses.map((status, index) => ({ content: `Task ${index + 1}`, status }));

test("{§task-inventory-intent} the native inventory determines one outcome irrespective of entry order", () => {
    const cases = [
        [[], "missing"],
        [["pending"], "pending"],
        [["completed"], "complete"],
        [["failed"], "fail"],
        [["completed", "failed"], "fail"],
        [["failed", "pending"], "pending"],
        [["waiting", "pending", "failed"], "wait"],
        [["in_progress", "pending", "waiting", "failed", "completed"], "continue"],
    ] as const;
    for (const [statuses, expected] of cases) {
        for (const ordered of [statuses, statuses.toReversed()]) {
            const value = PlanValue.assertCanonical(inventory(ordered));
            assert.equal(TurnDisposition.intent(value), expected);
        }
    }
});

test("{§turn-disposition} TASK is the only lifecycle operation and retains native inventory and timing", () => {
    const body = inventory(["pending", "waiting", "in_progress", "completed", "failed"]);
    const source = `${PlurnkParser.frame("SEND", "First finding.")}\n${PlurnkParser.frame("TASK <60,5>", JSON.stringify(body))}`;
    const parsed = PlurnkParser.parse(source);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map(({ op }) => op), ["SEND", "TASK"]);
    const task = statements.at(-1)!;
    assert.ok(TurnDisposition.is(task));
    assert.deepEqual(task.body, body);
    assert.deepEqual(task.lineMarker, { marks: [60, 5] });
    assert.equal(Validator.validatePlurnkStatement(task).valid, true);
    assert.deepEqual(PlurnkParser.parse(PlurnkParser.stringify(statements)).items.map((item) => item.kind), ["statement", "statement"]);
    for (const former of ["NEXT", "WAIT", "DONE", "FAIL"]) assert.equal(TurnDisposition.isOp(former), false);
});

test("{§task-inventory-intent} omitted and empty inventories retain useful operations and cannot imply success", () => {
    for (const ending of ["", PlurnkParser.frame("TASK", null), PlurnkParser.frame("TASK", "[]"), PlurnkParser.frame("TASK", " \t ")]) {
        const parsed = PlurnkParser.parse(`${PlurnkParser.frame("READ (answer.txt)", null)}\n${ending}`);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(statements.map(({ op }) => op), ["READ", "TASK"]);
        const task = statements.at(-1)!;
        assert.ok(TurnDisposition.is(task));
        assert.equal(TurnDisposition.intent(task.body), "missing");
        assert.equal(TurnDisposition.status(task), 102);
    }
});

test("{§plan-value} malformed TASK bodies retain all source text as one actionable item with a warning", () => {
    for (const body of ["Investigate the failure.", '{"entries":', '[{"content":"Missing status"}]']) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame("TASK", body));
        const task = parsed.items.find((item) => item.kind === "statement");
        assert.ok(task?.kind === "statement" && TurnDisposition.is(task.statement));
        assert.deepEqual(task.statement.body, [{ content: body, status: "in_progress" }]);
        const errors = parsed.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.severity, "warning");
        assert.match(errors[0]?.message ?? "", /retained as one in_progress item/);
    }
});

test("{§plan-acp-projection} waiting and failed remain native internally and explicit on a valid ACP surface", () => {
    const native = PlanValue.assertCanonical(inventory(["waiting", "failed", "completed"]));
    const before = structuredClone(native);
    const projected = AcpPlanValue.project(native);
    assert.equal(Validator.validateAcpPlan(projected).valid, true);
    assert.deepEqual(projected.entries.map(({ status }) => status), ["in_progress", "completed", "completed"]);
    assert.deepEqual(projected.entries.map(({ content }) => content), ["Waiting: Task 1", "Failed: Task 2", "Task 3"]);
    assert.deepEqual(projected.entries[0]?._meta, { "plurnk.xyz/status": "waiting" });
    assert.deepEqual(projected.entries[1]?._meta, { "plurnk.xyz/status": "failed" });
    assert.deepEqual(native, before);
});
