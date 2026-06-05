// Transport-agnostic content primitives — matching, <L> slicing, mimetype
// classification, path→mimetype. Uniform across every scheme and mimetype;
// folded in from the former @plurnk/plurnk-schemes daughter, which was
// misnamed: this is service-level content logic, not protocol-specific.

export {
    isBinaryMimetype,
    isJsonMimetype,
    isLineNavigableMimetype,
    normalizeAutoTextMimetype,
    TEXT_PRIMITIVE_MIMETYPE,
} from "./mimetype-binary.ts";

export {
    applyJsonItemEdit,
    applyLineMarkerEdit,
    sliceJsonItems,
    sliceLines,
    sliceLinesRaw,
} from "./line-marker.ts";
export type { EditResult as LineEditResult, JsonSliceResult, SliceResult } from "./line-marker.ts";

export { resolveEntryMimetype } from "./path-mimetype.ts";

export { matchAgainstContent } from "./matcher.ts";
export type { MatchResult } from "./matcher.ts";
