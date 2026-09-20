import test from "node:test";
import { fileURLToPath } from "node:url";
import { exerciseRuntimeNeutralWorker } from "./runtime-neutral-worker-control.mjs";

test("{§provider-runtime-neutral-errors} {§provider-runtime-neutral-accounting} the public accounting and error subpaths initialize in a browser Worker", async () => {
    await exerciseRuntimeNeutralWorker({
        absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
        conditions: ["plurnk-dev"],
    });
});
