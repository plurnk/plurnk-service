import type { EditStatement, LineMarker } from "@plurnk/plurnk-contracts";

// Scheme handlers receive EDIT only after core has lowered every model-facing
// line anchor. This type makes the plugin boundary incapable of carrying an
// unresolved anchor while preserving the rest of the authored statement.
export type ResolvedEditStatement = Omit<EditStatement, "lineMarker"> & {
    readonly lineMarker: LineMarker | null;
};
