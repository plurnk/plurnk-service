import { resolve } from "node:path";

const optionalPath = (value) => {
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
};

export const resolveClientCheckout = (env, cwd = process.cwd()) => {
    const clientCheckout = optionalPath(env.PLURNK_CLIENT_CHECKOUT);
    if (clientCheckout === undefined) {
        throw new Error("PLURNK_CLIENT_CHECKOUT must name the outside open-client checkout");
    }
    return resolve(cwd, clientCheckout);
};

export const resolveExternalReposRoot = (env, cwd = process.cwd()) => {
    const reposRoot = optionalPath(env.PLURNK_EXTERNAL_REPOS_ROOT);
    if (reposRoot === undefined) {
        throw new Error("PLURNK_EXTERNAL_REPOS_ROOT must name the external repository forest");
    }
    return resolve(cwd, reposRoot);
};

export const RELEASE_PROBE_PORT = 17821;

export const resolveCandidateTopology = (serviceRoot, env, cwd = process.cwd()) => {
    const benchmarks = optionalPath(env.PLURNK_BENCHMARKS);
    const candidateDir = optionalPath(env.PLURNK_CANDIDATE_DIR);
    return {
        clientRoot: resolveClientCheckout(env, cwd),
        benchmarks: benchmarks === undefined
            ? resolve(serviceRoot, "..", "benchmarks")
            : resolve(cwd, benchmarks),
        candidateDir: candidateDir === undefined ? undefined : resolve(cwd, candidateDir),
    };
};
