// Mimetype classifiers used at op-handler boundaries — single source of truth
// is @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the
// daughter's functions (mandate: static-method class); call sites stay
// `MimetypeBinary.isBinaryMimetype(...)`.
//
//   isBinaryMimetype       — enforces 415 on binary entries (SPEC §op-invariants)
//   isLineNavigableMimetype — decides the render layer's `N:` line prefixes
//   TEXT_PRIMITIVE_MIMETYPE — text/markdown, the auto-derived text default
import { MimetypeClassifier, TEXT_PRIMITIVE_MIMETYPE as _TEXT_PRIMITIVE_MIMETYPE } from "@plurnk/plurnk-schemes";

export default class MimetypeBinary {
    static TEXT_PRIMITIVE_MIMETYPE = _TEXT_PRIMITIVE_MIMETYPE;
    static isBinaryMimetype(mimetype: string): boolean { return MimetypeClassifier.isBinary(mimetype); }
    static isJsonMimetype(mimetype: string): boolean { return MimetypeClassifier.isJson(mimetype); }
    static isLineNavigableMimetype(mimetype: string): boolean { return MimetypeClassifier.isLineNavigable(mimetype); }
    static normalizeAutoTextMimetype(mimetype: string | null | undefined): string { return MimetypeClassifier.normalizeAutoText(mimetype); } // auto-text → the text/markdown primitive — §markdown-primitive-text-markdown-normalize
}
