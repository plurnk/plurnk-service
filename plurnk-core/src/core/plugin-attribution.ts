// #249 — plugin attribution. A plugin declares an opaque tag in its package.json
// (plurnk.attribution: string | string[]) that rides the generate() attributions wire.
// @plurnk/ is reserved: only a @plurnk/-scoped package may declare a @plurnk/ tag.

import { createRequire } from "node:module";

const RESERVED_PREFIX = "@plurnk/";

export default class PluginAttribution {
    // Normalize a raw `plurnk.attribution` value to a tag list AND enforce the reservation.
    // Pure (no I/O) so the contract is unit-testable. A plugin claiming the reserved
    // namespace is a fail-hard contract violation, not a silently-dropped tag.
    static normalize(raw: unknown, packageName: string): string[] {
        if (raw === undefined || raw === null) return [];
        const tags = Array.isArray(raw) ? raw : [raw];
        const firstParty = packageName.startsWith(RESERVED_PREFIX);
        const out: string[] = [];
        for (const tag of tags) {
            if (typeof tag !== "string" || tag.length === 0) {
                throw new Error(`plugin '${packageName}': plurnk.attribution must be a non-empty string or string[]`);
            }
            if (tag.startsWith(RESERVED_PREFIX) && !firstParty) {
                throw new Error(`plugin '${packageName}': '${RESERVED_PREFIX}' is reserved for ${RESERVED_PREFIX}-scoped packages — '${packageName}' cannot claim '${tag}'`);
            }
            out.push(tag);
        }
        return out;
    }

    // [] when the manifest can't be resolved (strict `exports` with no `./package.json`).
    static read(packageName: string): string[] {
        let manifest: { plurnk?: { attribution?: unknown } };
        try {
            manifest = createRequire(import.meta.url)(`${packageName}/package.json`) as typeof manifest;
        } catch {
            return [];
        }
        return PluginAttribution.normalize(manifest?.plurnk?.attribution, packageName);
    }
}
