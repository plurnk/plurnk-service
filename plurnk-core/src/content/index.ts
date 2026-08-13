// Transport-agnostic content primitives — matching, <L> slicing, mimetype
// classification, path→mimetype. Uniform across every scheme and mimetype;
// folded in from the former @plurnk/plurnk-schemes plugin, which was
// misnamed: this is service-level content logic, not protocol-specific.

export { default as MimetypeBinary } from "./mimetype-binary.ts";

export { default as LineMarkerOps } from "./line-marker.ts";
export type { EditResult as LineEditResult, SliceResult } from "./line-marker.ts";
export { default as LineAnchors } from "./line-anchors.ts";
export { default as EditCollision } from "./edit-collision.ts";
export type {
    LineAnchorCheck,
    LineAnchorFailure,
    LineAnchorPrecondition,
    LineAnchorResolution,
} from "./line-anchors.ts";

export { default as PathMimetype } from "./path-mimetype.ts";

export { default as Matcher } from "./matcher.ts";
export type { MatchResult } from "./matcher.ts";

export { default as ReadResolve } from "./read-resolve.ts";
export type { ReadSliceResult } from "./read-resolve.ts";

export { default as ReadProjector } from "./read-projector.ts";

export { editedSpan } from "./edited-span.ts";
export {
    assertEditBatchReceipt,
    assertEditReceipt,
    assertResourceEffects,
    editReceipt,
    projectEditReceipt,
    reviewerReplacementReceipt,
} from "./edit-receipt.ts";
export type {
    AppliedEditBatchReceipt,
    EditBatchReceipt,
    EditEffectReceipt,
    EditReceipt,
    EditReceiptUnit,
    ReviewerReplacementEditBatchReceipt,
    ReceiptEdit,
    ResourceEffect,
    ResourceEffectAction,
} from "./edit-receipt.ts";
