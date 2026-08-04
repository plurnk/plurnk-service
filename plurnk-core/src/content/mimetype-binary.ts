// Mimetype classifiers used at op-handler boundaries.
//
//   isBinaryMimetype       - enforces 415 on binary entries (SPEC {§op-invariants})
//   TEXT_PRIMITIVE_MIMETYPE - text/markdown, the auto-derived text default
import { MimetypeClassifier, TEXT_PRIMITIVE_MIMETYPE as _TEXT_PRIMITIVE_MIMETYPE } from "@plurnk/plurnk-schemes";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

export default class MimetypeBinary {
    static TEXT_PRIMITIVE_MIMETYPE = _TEXT_PRIMITIVE_MIMETYPE;
    static async isBinaryMimetype(mimetype: string, mimetypes: Mimetypes | undefined): Promise<boolean> {
        if (mimetypes === undefined) {
            throw new Error("MimetypeBinary.isBinaryMimetype: configured mimetype registry is required");
        }
        return (await mimetypes.classify(mimetype)).binary;
    }
    static isJsonMimetype(mimetype: string): boolean { return MimetypeClassifier.isJson(mimetype); }
    static normalizeAutoTextMimetype(mimetype: string | null | undefined): string { return MimetypeClassifier.normalizeAutoText(mimetype); } // auto-text → the text/markdown primitive — {§markdown-primitive-text-markdown-normalize}
}
