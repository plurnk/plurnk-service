import test from "node:test";
import assert from "node:assert/strict";
import FabricatedLog from "./FabricatedLog.ts";

test("{§fabricated-log-entry} finds a log-entry heading at line start and names its line", () => {
    assert.deepEqual(FabricatedLog.find("### log:///2/1/5/READ → CONTRIBUTING.md · 3004\n{}"), { heading: "### log:///2/1/5/READ", line: 0 });
    assert.deepEqual(FabricatedLog.find("Checking.\n\n### log:///12/3/40/sh · 9"), { heading: "### log:///12/3/40/sh", line: 2 });
});

test("{§fabricated-log-entry} a log address in prose, or another heading, is not an entry", () => {
    assert.equal(FabricatedLog.find("The receipt at log:///2/1/5/READ says 200."), null);
    assert.equal(FabricatedLog.find("## log:///2/1/5/READ"), null);
    assert.equal(FabricatedLog.find("### Log summary"), null);
});

test("{§fabricated-log-entry} the correction quotes the heading and states the one remedy", () => {
    assert.equal(FabricatedLog.message("### log:///2/1/5/READ"),
        "`### log:///2/1/5/READ` is a log entry, and only the harness writes the log. Write the operation, then wait for its receipt.");
});
