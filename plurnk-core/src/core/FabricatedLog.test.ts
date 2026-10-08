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

test("{§fabricated-log-entry} {§diagnostic-observation} the diagnostic quotes the heading and says only who writes the log", () => {
    assert.equal(FabricatedLog.message("### log:///2/1/5/READ"),
        "`### log:///2/1/5/READ` is a log entry, and only the harness writes the log.");
});

test("{§fabricated-log-entry} {§emission-row} an echoed emission heading is tolerated, and a later invented receipt still is not", () => {
    assert.equal(FabricatedLog.find("### log:///1/4/2/emission → ops://exampleWorkerName/1/4 · 88"), null);
    assert.equal(FabricatedLog.find("### log:///1/4/2/EMISSION · 88"), null, "the leaf compares case-insensitively");
    assert.deepEqual(FabricatedLog.find("### log:///1/4/2/emission · 88\n\n### log:///1/4/3/READ → a.md · 9"), { heading: "### log:///1/4/3/READ", line: 2 });
    assert.equal(FabricatedLog.echoes("### log:///1/4/2/emission · 88\ntext\n### log:///1/5/1/emission · 9\n### log:///1/5/2/READ · 3"), 2);
    assert.equal(FabricatedLog.echoes("no headings here"), 0);
});
