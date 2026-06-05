// Transport-agnostic content primitives — matching, <L> slicing, mimetype
// classification, path→mimetype. Uniform across every scheme and mimetype;
// folded in from the former @plurnk/plurnk-schemes daughter, which was
// misnamed: this is service-level content logic, not protocol-specific.

export { default as MimetypeBinary } from "./mimetype-binary.ts";

export { default as LineMarkerOps } from "./line-marker.ts";
export type { EditResult as LineEditResult, JsonSliceResult, SliceResult } from "./line-marker.ts";

export { default as PathMimetype } from "./path-mimetype.ts";

export { default as Matcher } from "./matcher.ts";
export type { MatchResult } from "./matcher.ts";
