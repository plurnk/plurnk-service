import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import HostPaths from "../plurnk-core/src/core/HostPaths.ts";

// {§test-artifact-retention} — one home for every harness. A live worker, a benchlet run and an
// integration suite all write a self-contained directory under PLURNK_BENCHMARKS: the database is
// born where it lives, and nothing counts, reuses, moves, hides or conditionally sweeps it. The
// checkout holds source; it never holds run output. This is the one resolver of that home: a blank
// value is unset, `~` expands, and a relative value is the working directory's.
export const benchmarksRoot = (env: NodeJS.ProcessEnv = process.env): string => {
    const configured = env.PLURNK_BENCHMARKS?.trim();
    return resolve(new HostPaths().expandUserPath(configured === undefined || configured.length === 0 ? "~/benchmarks" : configured));
};

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
// `<kind>-<stamp>`, every worker the run claims lands inside it, and the census is written beside
// them. Unstamped (a bare `node --test` on one specimen), a worker lands directly in the home.
export const tierRunPath = (run: string | undefined = process.env.PLURNK_TIER_RUN): string | null =>
    run === undefined ? null : join(benchmarksRoot(), `tier-${run}`);
