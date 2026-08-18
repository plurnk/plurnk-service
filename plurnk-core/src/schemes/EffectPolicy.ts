import type { Effect } from "@plurnk/plurnk-execs";

export type ExecPolicy = "propose" | "auto";

// Service-owned policy: maps an executor-declared `effect` to the proposal
// lifecycle. The executor declares the FACT (does this invocation mutate the
// host?); the service decides the POLICY (does it need a human gate?).
//
// {§exec-host-proposes} `host` runs code / mutates the host → propose;
// `read` (observes external state) and `pure` (no observable effect) are
// side-effect-free → auto-run, no human in the loop ({§exec-readpure-ungated}).
// Conservative by construction — an undeclared/unknown effect classifies as
// `host` upstream (BaseExecutor.effect defaults to host), so it lands here as
// propose.
//
// {§effect-policy-tunable} — the default map is the contract; the operator may
// override it deployment-wide with `PLURNK_SERVICE_EFFECT_POLICY` (a
// comma-separated `<effect>:<policy>` list, e.g. `read:propose` for a
// high-security deployment proposing even reads). Unlisted effects keep the
// default. Invalid entries fail configuration, never degrade silently.
export const EFFECT_POLICY_ENV = "PLURNK_SERVICE_EFFECT_POLICY";

const DEFAULT_POLICY: Readonly<Record<Effect, ExecPolicy>> = {
    host: "propose",
    read: "auto",
    pure: "auto",
};

export default class EffectPolicy {
    static isEffect(value: unknown): value is Effect {
        return value === "pure" || value === "read" || value === "host";
    }

    static validateConfiguration(): void {
        EffectPolicy.#parse(process.env[EFFECT_POLICY_ENV] ?? "");
    }

    static decide(effect: Effect): ExecPolicy {
        return EffectPolicy.#parse(process.env[EFFECT_POLICY_ENV] ?? "")[effect] ?? DEFAULT_POLICY[effect];
    }

    static #parse(raw: string): Partial<Record<Effect, ExecPolicy>> {
        const map: Partial<Record<Effect, ExecPolicy>> = {};
        for (const entry of raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0)) {
            const colon = entry.indexOf(":");
            if (colon <= 0) {
                throw new Error(`${EFFECT_POLICY_ENV} entry ${JSON.stringify(entry)} must be <effect>:<policy>.`);
            }
            const effect = entry.slice(0, colon);
            const policy = entry.slice(colon + 1);
            if (!EffectPolicy.isEffect(effect)) {
                throw new Error(`${EFFECT_POLICY_ENV}: unknown effect ${JSON.stringify(effect)} (host, read, pure).`);
            }
            if (policy !== "propose" && policy !== "auto") {
                throw new Error(`${EFFECT_POLICY_ENV}: unknown policy ${JSON.stringify(policy)} (propose, auto).`);
            }
            map[effect] = policy;
        }
        return map;
    }
}
