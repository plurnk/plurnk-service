import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import HostPaths from "../plurnk-core/src/core/HostPaths.ts";

// {§test-artifact-retention} — one home for every harness. A live worker, a benchlet run and an
// integration suite all write a self-contained directory under PLURNK_BENCHMARKS: the database is
// born where it lives, and nothing counts, reuses, moves, hides or conditionally sweeps it. The
// checkout holds source; it never holds run output.
export const benchmarksRoot = (): string =>
    process.env.PLURNK_BENCHMARKS ?? new HostPaths().expandUserPath("~/benchmarks");

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
