import type { Effect } from "@plurnk/plurnk-execs";

export type ExecPolicy = "propose" | "auto";

// Service-owned policy: maps an executor-declared `effect` to the proposal
// lifecycle. The executor declares the FACT (does this invocation mutate the
// host?); the service decides the POLICY (does it need a human gate?).
//
// Default (plurnk-service#182): `host` runs code / mutates the host → propose;
// `read` (observes external state) and `pure` (no observable effect) are
// side-effect-free → auto-run, no human in the loop. Conservative by
// construction — an undeclared/unknown effect classifies as `host` upstream
// (BaseExecutor.effect defaults to host), so it lands here as propose.
//
// Deployment-tunability (a high-security deployment proposing even `read`) is a
// later env knob; the default map is the contract until one is needed.
export default class EffectPolicy {
    static isEffect(value: unknown): value is Effect {
        return value === "pure" || value === "read" || value === "host";
    }

    static decide(effect: Effect): ExecPolicy {
        return effect === "host" ? "propose" : "auto";
    }
}
