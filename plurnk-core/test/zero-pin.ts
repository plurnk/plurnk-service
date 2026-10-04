// {§operator-config-zero-pin-gate} — remove tuning without changing provider selection.
export const isZeroPinTuning = (key: string): boolean =>
    /^PLURNK_PROVIDERS_CONTEXT_WINDOW(_.+)?$/.test(key)              // any window pin → force the probe
    || /^PLURNK_PROVIDERS_(OUTPUT|REASONING)_BUDGET_.+$/.test(key); // per-alias envelope pins (bare floor stays)

// Report every removed key so the counterfactual gate is auditable.
export const scrubZeroPinTuning = (env: NodeJS.ProcessEnv): string[] => {
    const stripped = Object.keys(env).filter(isZeroPinTuning);
    for (const k of stripped) delete env[k];
    return stripped;
};
