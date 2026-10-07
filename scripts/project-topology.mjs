import { resolve } from "node:path";

const optionalPath = (value) => {
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
};

export const resolveClientCheckout = (env, cwd = process.cwd(), defaultCheckout) => {
    const clientCheckout = optionalPath(env.PLURNK_CLIENT_CHECKOUT) ?? defaultCheckout;
    if (clientCheckout === undefined) {
        throw new Error("PLURNK_CLIENT_CHECKOUT must name the outside open-client checkout");
    }
    return resolve(cwd, clientCheckout);
};

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
