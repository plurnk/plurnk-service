import test from "node:test";
import assert from "node:assert/strict";
import FabricatedLog from "./FabricatedLog.ts";

test("{§emission-admission} finds a log-entry heading at line start and names its line", () => {
    assert.deepEqual(FabricatedLog.find("### log:///2/1/5/read (CONTRIBUTING.md) · 3004\n{}"), { heading: "### log:///2/1/5/read", line: 0 });
    assert.deepEqual(FabricatedLog.find("Checking.\n\n### log:///12/3/40/sh · 9"), { heading: "### log:///12/3/40/sh", line: 2 });
});

test("{§emission-admission} a log address in prose, or another heading, is not an entry", () => {
    assert.equal(FabricatedLog.find("The receipt at log:///2/1/5/read says 200."), null);
    assert.equal(FabricatedLog.find("## log:///2/1/5/read"), null);
    assert.equal(FabricatedLog.find("### Log summary"), null);
});

test("{§emission-admission} {§diagnostic-observation} the diagnostic quotes the heading and says only who writes the log", () => {
    assert.equal(FabricatedLog.message("### log:///2/1/5/read"),
        "`### log:///2/1/5/read` is a log entry, and only the harness writes the log.");
});

test("{§emission-admission} {§turn-source-resources} an echoed emission heading is tolerated, and a later invented receipt still is not", () => {
    assert.equal(FabricatedLog.find("### log:///1/4/2/emission (ops://exampleSessionName/1/4) · 88"), null);
    assert.equal(FabricatedLog.find("### log:///1/4/2/EMISSION · 88"), null, "the leaf compares case-insensitively");
    assert.deepEqual(FabricatedLog.find("### log:///1/4/2/emission · 88\n\n### log:///1/4/3/read (a.md) · 9"), { heading: "### log:///1/4/3/read", line: 2 });
    assert.equal(FabricatedLog.echoes("### log:///1/4/2/emission · 88\ntext\n### log:///1/5/1/emission · 9\n### log:///1/5/2/read · 3"), 2);
    assert.equal(FabricatedLog.echoes("no headings here"), 0);
});

test("{§emission-admission} finds fabricated Markdown tool-result transcripts and ignores ordinary bold lists", () => {
    const fabricated = [
        "**roblox_family_planner: save_chat_media**",
        "- alt: `Gookie Rainbow Bridge Test Badge`",
        "- filename: `gookie-badge.svg`",
        "- svg: `<svg>\n  <text>🐹</text>\n</svg>`",
        "- Result:",
        "```json",
        "{\"ok\":true}",
        "```",
    ].join("\n");
    assert.deepEqual(FabricatedLog.find(fabricated), {
        heading: "**roblox_family_planner: save_chat_media**",
        line: 0,
    });
    assert.deepEqual(
        FabricatedLog.find("Intro.\n- Stream: `brave:///c3c7ae49`"),
        { heading: "- Stream: `brave:///c3c7ae49`", line: 1 },
    );
    assert.equal(
        FabricatedLog.find("**Summary: Options**\n- First item\n- Second item"),
        null,
    );
});
