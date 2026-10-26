import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { benchmarksRoot } from "./benchmarks-root.mjs";

// {§test-artifact-retention} — one home for every harness. A live session, a benchlet run and an
// integration suite all write a self-contained directory under PLURNK_BENCHMARKS: the database is
// born where it lives, and nothing counts, reuses, moves, hides or conditionally sweeps it. The
// checkout holds source; it never holds run output. The home itself is resolved once, in
// benchmarks-root.mjs, and re-exported here for the TypeScript harnesses.
export { benchmarksRoot };

// One directory per suite run. The runner stamps PLURNK_TEST_RUN once and every test process
// inherits it, so a lane's databases land together without a pretest step, a marker file or a
// sweep. An unstamped run (a bare `node --test <file>`) lands in its own `adhoc` directory rather
// than being a special case with its own rules.
export const testArtifactPath = (lane: string): string =>
    join(benchmarksRoot(), `intg-${lane}-${process.env.PLURNK_TEST_RUN ?? "adhoc"}`);

export const testArtifactDirectory = async (lane: string): Promise<string> => {
    const directory = testArtifactPath(lane);
    await mkdir(directory, { recursive: true });
    return directory;
};

// {§tier-census} — a real-model tier run is one directory too: the driver stamps PLURNK_TIER_RUN as
// `<kind>-<stamp>`, every session the run claims lands inside it, and the census is written beside
// them. Unstamped (a bare `node --test` on one specimen), a session lands directly in the home.
export const tierRunPath = (run: string | undefined = process.env.PLURNK_TIER_RUN): string | null =>
    run === undefined ? null : join(benchmarksRoot(), `tier-${run}`);
