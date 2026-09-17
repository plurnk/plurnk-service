import assert from "node:assert/strict";
import test from "node:test";
import { hasAuditOutcome } from "../demo/_audit-oracle.ts";

test("packet audit oracle accepts numbered findings with Markdown emphasis", () => {
    for (const answer of [
        "1. The roster is inconsistent.",
        "## 1. The roster is inconsistent.",
        "**1. The roster is inconsistent.**\n\nThe two files disagree.",
        "**1.** The roster is inconsistent.",
        "Findings:\n\n2) The dependency is missing.",
        "I did not find any material errors.",
        "No findings.",
    ]) assert.equal(hasAuditOutcome(answer), true, answer);
    for (const answer of ["", "1.", "**1.**", "I will inspect the packet.", "There are 2 files."]) {
        assert.equal(hasAuditOutcome(answer), false, answer);
    }
});
