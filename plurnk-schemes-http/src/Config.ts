import { Knob } from "@plurnk/plurnk-meta";

// {§env-knob} — the panel states the value; an unset key is a broken floor. A text knob this
// scheme reads is never blank: a blank user agent or origin is a misconfiguration, not a value.
export const requireTextEnv = (key: string): string => {
    const raw = Knob.text(key);
    if (raw.trim().length === 0) throw new Error(`${key} must not be blank; got ${JSON.stringify(raw)}.`);
    return raw;
};

export const requireFlagEnv = (key: string): boolean => Knob.flag(key);

export const requireNonNegativeIntegerEnv = (key: string): number => Knob.integer(key, 0);

export const requirePositiveIntegerEnv = (key: string): number => Knob.integer(key, 1);
