import type { Effect } from "@plurnk/plurnk-execs";
import { Knob } from "@plurnk/plurnk-meta";

export type ExecPolicy = "propose" | "auto";

// Service-owned policy: maps an executor-declared `effect` to the proposal
// lifecycle. The executor declares the FACT (does this invocation mutate the
// host?); the service decides the POLICY (does it need a human gate?).
//
// {§exec-host-proposes} `host` runs code / mutates the host; `read` observes
// external state and `pure` has no observable effect ({§exec-readpure-ungated}).
// Conservative by construction — an undeclared/unknown effect classifies as
// `host` upstream (BaseExecutor.effect), so it lands here as whatever the
// panel says of `host`.
//
// {§effect-policy-tunable} — one knob per effect, and the panel is the whole
// map: no entry is held in code, so an effect's admission is always a value an
// operator can read. An invalid value refuses admission, never invents a policy.
const POLICIES: readonly ExecPolicy[] = ["propose", "auto"];
const KNOBS: Readonly<Record<Effect, string>> = Object.freeze({
    host: "PLURNK_SERVICE_EFFECT_HOST",
    read: "PLURNK_SERVICE_EFFECT_READ",
    pure: "PLURNK_SERVICE_EFFECT_PURE",
});

export default class EffectPolicy {
    static isEffect(value: unknown): value is Effect {
        return value === "pure" || value === "read" || value === "host";
    }

    static validateConfiguration(): void {
        for (const effect of Object.keys(KNOBS) as Effect[]) EffectPolicy.decide(effect);
    }

    static decide(effect: Effect): ExecPolicy {
        return Knob.choice(KNOBS[effect], POLICIES);
    }
}
