import { RUNTIME_TAG } from "@plurnk/plurnk-contracts";

const SHAPE = RUNTIME_TAG;
const SHAPE_TEXT = "[a-z][a-z0-9+.-]*";
// A runtime tag is also an execution's op on the wire, so the internal "exec" scheme and the
// prompt row's op can never be runtime names.
const RESERVED = new Map([
    ["only", "PLURNK_EXECS_ONLY"],
    ["exec", "the execution scheme"],
    ["prompt", "the prompt row"],
    ["extension", "extension rows"],
    ["error", "error rows"],
]);

// One admission rule for installed and module-owned executor identities
// ({§executor-runtime-declaration}). A runtime tag is also its output URI
// scheme, so canonical lowercase scheme syntax prevents folded aliases and
// keeps package-owned docs beneath docs/<tag>.md.
export default class RuntimeTag {
    static is(value: unknown): value is string {
        return typeof value === "string" && SHAPE.test(value) && !RESERVED.has(value);
    }

    static assert(value: unknown, owner: string): string {
        if (typeof value !== "string" || value.length === 0) {
            throw new Error(`exec runtime declaration invalid: ${owner} must declare a string name matching ${SHAPE_TEXT} (lowercase URI-scheme syntax)`);
        }
        if (!SHAPE.test(value)) {
            throw new Error(`exec runtime declaration invalid: ${owner} name '${value}' must match ${SHAPE_TEXT} (lowercase URI-scheme syntax)`);
        }
        const configuration = RESERVED.get(value);
        if (configuration !== undefined) {
            throw new Error(`exec runtime declaration invalid: ${owner} name '${value}' is reserved by ${configuration}`);
        }
        return value;
    }
}
