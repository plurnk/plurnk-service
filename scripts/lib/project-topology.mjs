import { benchmarksRoot } from "./benchmarks-root.mjs";
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

export const resolveWebCheckout = (env, cwd = process.cwd(), defaultCheckout) => {
    const webCheckout = optionalPath(env.PLURNK_WEB_CHECKOUT) ?? defaultCheckout;
    if (webCheckout === undefined) {
        throw new Error("PLURNK_WEB_CHECKOUT must name the outside plurnk-web checkout");
    }
    return resolve(cwd, webCheckout);
};

export const resolveCandidateTopology = (serviceRoot, env, cwd = process.cwd()) => {
    const benchmarks = optionalPath(env.PLURNK_BENCHMARKS);
    const candidateDir = optionalPath(env.PLURNK_CANDIDATE_DIR);
    return {
        clientRoot: resolveClientCheckout(env, cwd),
        // {§test-artifact-retention} — unset, the one benchmark home; set, the caller's directory resolves it.
        benchmarks: benchmarks === undefined ? benchmarksRoot(env) : resolve(cwd, benchmarks),
        candidateDir: candidateDir === undefined ? undefined : resolve(cwd, candidateDir),
    };
};
