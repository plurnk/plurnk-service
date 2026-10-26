import test from "node:test";
import { fileURLToPath } from "node:url";
import { exerciseRuntimeNeutralSession } from "./runtime-neutral-session-control.mjs";

test("{§provider-runtime-neutral-errors} {§provider-runtime-neutral-accounting} the public accounting and error subpaths initialize in a browser Session", async () => {
    await exerciseRuntimeNeutralSession({
        absWorkingDir: fileURLToPath(new URL("../../..", import.meta.url)),
        conditions: ["plurnk-dev"],
    });
});
