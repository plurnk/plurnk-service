// #510 — the zero-pin gate mode strips operator model tuning so a demo/live run
// walks the fresh-user derivation path. Kept: model selection and shipped defaults.
// Stripped: physical envelope pins and virtual prompt pressure.
export const isZeroPinTuning = (key: string): boolean =>
    /^PLURNK_PROVIDERS_CONTEXT_WINDOW(_.+)?$/.test(key)              // any window pin → force the probe
    || /^PLURNK_PROVIDERS_(REASONING|COMPLETION)_RESERVE_.+$/.test(key)  // per-alias reserve pins (bare percent stays)
    || /^PLURNK_SERVICE_SAFETY_.+$/.test(key)                        // per-alias safety pins (bare stays)
    || /^PLURNK_SERVICE_PROMPT_BUDGET(_.+)?$/.test(key);             // virtual operator pressure → restore natural budget

// Delete every tuning pin from `env` in place; return the stripped keys (for a loud report —
// a green zero-pin run must be trustworthy).
export const scrubZeroPinTuning = (env: NodeJS.ProcessEnv): string[] => {
    const stripped = Object.keys(env).filter(isZeroPinTuning);
    for (const k of stripped) delete env[k];
    return stripped;
};
