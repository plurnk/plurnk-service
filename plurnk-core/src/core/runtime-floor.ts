// {§startup-admission} — the Node.js floor this package declares in `engines.node`, checked before the
// executable loads anything else, so an older runtime is named instead of failing in some later module.
import { readFileSync } from "node:fs";

// `engines.node` is a `>=MAJOR[.MINOR[.PATCH]]` floor; any other range is a packaging defect.
export const floorOf = (range: string): { floor: [number, number, number]; spelled: string } => {
    const match = /^>=\s*((\d+)(?:\.(\d+))?(?:\.(\d+))?)$/u.exec(range.trim());
    if (match === null) throw new Error(`engines.node must be a ">=" floor, not "${range}".`);
    return { floor: [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)], spelled: match[1] };
};

// The refusal for `version` (spelled as `process.versions.node`), or null when it meets the floor.
export const refusal = (name: string, range: string, version: string): string | null => {
    const { floor, spelled } = floorOf(range);
    const current = version.split(/[.-]/u, 3).map(Number);
    for (const [index, part] of floor.entries()) {
        const actual = current[index] ?? 0;
        if (actual > part) return null;
        if (actual < part) return `${name} requires Node.js ${spelled} or later; this is v${version}.`;
    }
    return null;
};

// The package's own `engines.node`, read without loading anything beyond node:fs.
export const declaredFloor = (): string => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const engines = typeof manifest === "object" && manifest !== null && "engines" in manifest ? manifest.engines : undefined;
    const node = typeof engines === "object" && engines !== null && "node" in engines ? engines.node : undefined;
    if (typeof node !== "string") throw new TypeError("package.json declares engines.node.");
    return node;
};

export const refuseBelowFloor = (name: string): void => {
    const message = refusal(name, declaredFloor(), process.versions.node);
    if (message === null) return;
    process.stderr.write(`${message}\n`);
    process.exit(1);
};
