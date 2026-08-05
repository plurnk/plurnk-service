import { resolve } from "node:path";

const optionalPath = (value) => {
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
};

export const resolveCandidateTopology = (serviceRoot, env, cwd = process.cwd()) => {
    const clientCheckout = optionalPath(env.PLURNK_CLIENT_CHECKOUT);
    if (clientCheckout === undefined) {
        throw new Error("PLURNK_CLIENT_CHECKOUT must name the outside open-client checkout");
    }

    const benchmarks = optionalPath(env.PLURNK_BENCHMARKS);
    const candidateDir = optionalPath(env.PLURNK_CANDIDATE_DIR);
    return {
        clientRoot: resolve(cwd, clientCheckout),
        benchmarks: benchmarks === undefined
            ? resolve(serviceRoot, "..", "benchmarks")
            : resolve(cwd, benchmarks),
        candidateDir: candidateDir === undefined ? undefined : resolve(cwd, candidateDir),
    };
};
