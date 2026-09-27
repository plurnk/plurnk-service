// Transport-agnostic content primitives — matching, <L> slicing, mimetype
// classification, path→mimetype. Uniform across every scheme and mimetype:
// service-level content logic, not protocol-specific.

export { default as MimetypeBinary } from "./mimetype-binary.ts";

export { default as LineMarkerOps } from "./line-marker.ts";
export { default as LineAnchors } from "./line-anchors.ts";
export { default as EditCollision } from "./edit-collision.ts";
export type {
    LineAnchorCheck,
    LineAnchorPrecondition,
} from "./line-anchors.ts";

export { default as PathMimetype } from "./path-mimetype.ts";

export { default as ReadProjector } from "./read-projector.ts";

export { editedSpan } from "./edited-span.ts";
export {
    assertEditBatchReceipt,
    assertEditReceipt,
    assertResourceEffects,
    EDIT_NOOP_DETAIL,
    editReceipt,
    projectEditReceipt,
    reviewerReplacementReceipt,
    withEditReceiptParseIssues,
} from "./edit-receipt.ts";
export type {
    EditBatchReceipt,
    EditReceipt,
    ResourceEffect,
    ResourceEffectAction,
} from "./edit-receipt.ts";
