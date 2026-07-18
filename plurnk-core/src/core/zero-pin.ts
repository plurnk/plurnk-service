// #510 — the zero-pin gate mode: strip the agent-written alias ENVELOPE pins so a demo/live run
// walks the fresh-user derivation path (#507 — probed window + shipped percent reserves), and a
// path that only works WITH a hand-written pin reads RED. Kept: the model SELECTION + defs, the
// shipped BARE percent reserves + safety — everything a fresh install has. Stripped: box tuning.
export const isEnvelopePin = (key: string): boolean =>
    /^PLURNK_PROVIDERS_CONTEXT_WINDOW(_.+)?$/.test(key)              // any window pin → force the probe
    || /^PLURNK_PROVIDERS_(REASONING|COMPLETION)_RESERVE_.+$/.test(key)  // per-alias reserve pins (bare percent stays)
    || /^PLURNK_SERVICE_SAFETY_.+$/.test(key);                       // per-alias safety pins (bare stays)

// Delete every envelope pin from `env` in place; return the stripped keys (for a loud report —
// a green zero-pin run must be trustworthy).
export const scrubEnvelopePins = (env: NodeJS.ProcessEnv): string[] => {
    const stripped = Object.keys(env).filter(isEnvelopePin);
    for (const k of stripped) delete env[k];
    return stripped;
};
