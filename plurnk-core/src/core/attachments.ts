import type { InputModality } from "@plurnk/plurnk-providers";

// {§packet-attachment-parts} {§attachment-teaching} — the kinds of member a packet carries as a
// native part, one row each: the catalog modality the route must declare, the weight the readout
// charges before the provider's usage corrects it, and the one example line the system slot
// teaches when the route can take the kind. A kind is listed only once the daemon can produce
// its part (a handler that projects the facts, a scheme that still holds the bytes).
export type AttachmentKind = "image" | "pdf";

export interface AttachmentRow {
    readonly kind: AttachmentKind;
    readonly modality: InputModality;
    readonly mimetype: string;
    readonly example: string;
}

export const ATTACHMENT_KINDS: readonly AttachmentRow[] = Object.freeze([
    { kind: "image", modality: "image", mimetype: "image/png", example: "### READ0 (assets/logo.png) <!-- the picture itself rides this packet -->" },
    { kind: "pdf", modality: "pdf", mimetype: "application/pdf", example: "### READ0 (docs/contract.pdf) <!-- the document itself rides this packet -->" },
]);

// A picture's weight in the readout: an estimate by pixels.
export const imageWeight = (width: number, height: number): number => Math.ceil((width * height) / 750);

// A document's weight in the readout: an estimate by pages, at the low end of what providers
// bill per page, corrected by the provider's reported usage like every other weight.
export const PDF_TOKENS_PER_PAGE = 1500;
export const pdfWeight = (pages: number): number => pages * PDF_TOKENS_PER_PAGE;

export const acceptedKinds = (modalities: ReadonlySet<InputModality>): readonly AttachmentKind[] =>
    ATTACHMENT_KINDS.filter((row) => modalities.has(row.modality)).map((row) => row.kind);

// {§attachment-teaching} — the system slot's Attachments section: one example per kind the route
// accepts and the daemon can attach; empty, and therefore absent, for every other route.
export const attachmentTeaching = (
    modalities: ReadonlySet<InputModality>,
    installedMimetypes: ReadonlySet<string>,
): string => {
    const rows = ATTACHMENT_KINDS.filter((row) =>
        modalities.has(row.modality) && installedMimetypes.has(row.mimetype));
    return rows.length === 0 ? "" : ["```example", ...rows.map((row) => row.example), "```"].join("\n");
};
