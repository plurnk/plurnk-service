// {§test-artifact-retention} — a green suite leaves nothing behind; a red one is never touched,
// because this only runs after `node --test` has already exited 0.
import { rm } from "node:fs/promises";
import { testArtifactPath } from "./lib/test-artifacts.ts";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: node scripts/reclaim-green-run.mjs <lane>   (after a green test:intg)
Removes the lane's stamped run directory under the benchmark home: a green suite leaves nothing behind, a red one is never touched ({§test-artifact-retention}).
Reads: PLURNK_TEST_RUN, the stamp of the run that just passed.
Writes: nothing; deletes the run directory.
`);

const [lane] = process.argv.slice(2);
if (lane === undefined) throw new Error("name the lane whose green run to reclaim");
if (process.env.PLURNK_TEST_RUN === undefined) throw new Error("no stamped run: an adhoc directory is never reclaimed");
await rm(testArtifactPath(lane), { recursive: true, force: true });
