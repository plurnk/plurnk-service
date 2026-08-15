import test from "node:test";
import { fileURLToPath } from "node:url";
import { exerciseAccountingWorker } from "./accounting-worker-control.mjs";

test("the public accounting subpath bundles and initializes in a browser Worker", async () => {
    await exerciseAccountingWorker({
        absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
        conditions: ["plurnk-dev"],
    });
});
