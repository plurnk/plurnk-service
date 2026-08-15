// {§operator-config-zero-pin-gate} — remove tuning without changing provider selection.
export const isZeroPinTuning = (key: string): boolean =>
    /^PLURNK_PROVIDERS_CONTEXT_WINDOW(_.+)?$/.test(key)              // any window pin → force the probe
    || /^PLURNK_PROVIDERS_(REASONING|COMPLETION)_RESERVE_.+$/.test(key)  // per-alias reserve pins (bare percent stays)
    || /^PLURNK_SERVICE_SAFETY_.+$/.test(key)                        // per-alias safety pins (bare stays)
    || /^PLURNK_SERVICE_PROMPT_PROJECTION_.+$/.test(key)             // per-alias projection tuning (bare percent stays)
    || /^PLURNK_SERVICE_PROMPT_BUDGET(_.+)?$/.test(key);             // virtual operator pressure → restore natural budget

// Report every removed key so the counterfactual gate is auditable.
export const scrubZeroPinTuning = (env: NodeJS.ProcessEnv): string[] => {
    const stripped = Object.keys(env).filter(isZeroPinTuning);
    for (const k of stripped) delete env[k];
    return stripped;
};
