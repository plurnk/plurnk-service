// {§operator-config-only-home} — a knob is read from the system environment, and its value lives on
// the panel and nowhere else. The floor guarantees every declared key, so an unset key is a broken
// deployment and an invalid one is the operator's mistake: both crash by name, never degrade. No
// reader here accepts a value, because a signature that could carry one is a second home for a choice.
export default class Knob {
    static text(name: string): string {
        const raw = process.env[name];
        if (raw === undefined) throw new Error(`${name} is missing from the assembled environment floor.`);
        return raw;
    }

    // A comma list; empty is the empty list.
    static list(name: string): string[] {
        return Knob.text(name).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    }

    // `floor` is a bound on what the operator may say, never a value used in the operator's place.
    static integer(name: string, floor: number): number {
        const raw = Knob.text(name);
        const value = Number(raw);
        if (raw.trim().length === 0 || !Number.isSafeInteger(value) || value < floor) {
            throw new Error(`${name} must be a safe integer of at least ${floor}; got ${JSON.stringify(raw)}.`);
        }
        return value;
    }
}
