import type { EditStatement, LineMarker } from "@plurnk/plurnk-contracts";

// Scheme handlers receive EDIT only after core has lowered every model-facing
// line anchor. This type makes the plugin boundary incapable of carrying an
// unresolved anchor. Body syntax has likewise been prepared by core; a handler
// applies the supplied replacement literally, including at a zero-width span.
export type ResolvedEditStatement = Omit<EditStatement, "lineMarker"> & {
    readonly lineMarker: LineMarker | null;
};
