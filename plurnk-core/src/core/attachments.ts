import type { InputModality } from "@plurnk/plurnk-providers";

// {§packet-attachment-parts} — the kinds of member a packet can carry as a native part and the
// catalog modality the route must declare. Reactive lifecycle evidence rides beside an actual
// part; this table contributes no permanent packet teaching.
export type AttachmentKind = "image" | "pdf";

export interface AttachmentRow {
    readonly kind: AttachmentKind;
    readonly modality: InputModality;
}

export const ATTACHMENT_KINDS: readonly AttachmentRow[] = Object.freeze([
    { kind: "image", modality: "image" },
    { kind: "pdf", modality: "pdf" },
]);

// Stable curation weight by pixels, not a provider-token measurement.
export const imageWeight = (width: number, height: number): number => Math.ceil((width * height) / 750);

// Stable curation weight by pages; calibration adjusts capacity, never this cost.
export const PDF_TOKENS_PER_PAGE = 1500;
export const pdfWeight = (pages: number): number => pages * PDF_TOKENS_PER_PAGE;

export const acceptedKinds = (modalities: ReadonlySet<InputModality>): readonly AttachmentKind[] =>
    ATTACHMENT_KINDS.filter((row) => modalities.has(row.modality)).map((row) => row.kind);
