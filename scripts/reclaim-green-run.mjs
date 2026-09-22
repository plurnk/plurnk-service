// {§test-artifact-retention} — a green suite leaves nothing behind; a red one is never touched,
// because this only runs after `node --test` has already exited 0.
import { rm } from "node:fs/promises";
import { testArtifactPath } from "./test-artifacts.ts";

const [lane] = process.argv.slice(2);
if (lane === undefined) throw new Error("name the lane whose green run to reclaim");
if (process.env.PLURNK_TEST_RUN === undefined) throw new Error("no stamped run: an adhoc directory is never reclaimed");
await rm(testArtifactPath(lane), { recursive: true, force: true });
