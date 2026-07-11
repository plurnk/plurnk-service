import type { ExecInfo, ExecRegistry } from "./types.ts";

// The EXEC family's capability contribution to the consumer's `# Plurnk System
// Tools` sheet for ONE loop (SPEC §3.4). Its whole job is the legible no: when
// a loop leaves ZERO EXEC runtimes Active (§3.2), the sheet must carry a
// positive statement rather than silent absence — the grammar still teaches
// `EXEC` as a valid op, so a bare op mention with no availability signal reads
// as *unknown*, and the model confabulates runtimes that the gate then refuses
// (execs#24). The negative line closes that window.
//
// One contributor, both cases. `permitted` and the `notice` fall out of the
// SAME filter, so the N-runtime sheet and the 0-runtime line cannot drift: a
// non-empty result never carries a notice.
//
// Cause-agnostic by contract. `isPermitted` resolves whether a registered tag
// survives THIS loop's gates — execs supplies the §3.3 policy cascade as the
// baseline, and the consumer composes stricter gates into it (the effect-typed
// host bar of ask-mode, execs#24). WHY the set is empty is never execs'
// business: execs owns the §2.3 `effect()` classification and this tally; the
// consumer owns the loop-mode decision. Execs counts survivors and speaks the
// count — nothing about the mode reaches this module.
export default class Advertise {
    // The single family-level line spoken when zero EXEC runtimes survive.
    // "permitted", not "disabled": true whether §3.3 policy zeroed every tag or
    // an effect-typed host bar caught them all — one word must not imply one cause.
    static readonly NO_EXECS_NOTICE = "No EXEC operations permitted";

    static contribute(
        registry: ExecRegistry,
        isPermitted: (tag: string) => boolean,
    ): { permitted: ExecInfo[]; notice: string | null } {
        const permitted = [...registry.values()].filter(({ runtime }) => isPermitted(runtime));
        return { permitted, notice: permitted.length === 0 ? Advertise.NO_EXECS_NOTICE : null };
    }
}
