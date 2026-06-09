// Mimetype classifiers used at op-handler boundaries — single source of truth
// is @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the
// daughter's functions (mandate: static-method class); call sites stay
// `MimetypeBinary.isBinaryMimetype(...)`.
//
//   isBinaryMimetype       — enforces 415 on binary entries (SPEC §16.9)
//   isLineNavigableMimetype — decides the render layer's `N:\t` line prefixes
//   TEXT_PRIMITIVE_MIMETYPE — text/markdown, the auto-derived text default
import {
    isBinaryMimetype as _isBinaryMimetype,
    isJsonMimetype as _isJsonMimetype,
    isLineNavigableMimetype as _isLineNavigableMimetype,
    normalizeAutoTextMimetype as _normalizeAutoTextMimetype,
    TEXT_PRIMITIVE_MIMETYPE as _TEXT_PRIMITIVE_MIMETYPE,
} from "@plurnk/plurnk-schemes";

export default class MimetypeBinary {
    static TEXT_PRIMITIVE_MIMETYPE = _TEXT_PRIMITIVE_MIMETYPE;
    static isBinaryMimetype(mimetype: string): boolean { return _isBinaryMimetype(mimetype); }
    static isJsonMimetype(mimetype: string): boolean { return _isJsonMimetype(mimetype); }
    static isLineNavigableMimetype(mimetype: string): boolean { return _isLineNavigableMimetype(mimetype); }
    static normalizeAutoTextMimetype(mimetype: string | null | undefined): string { return _normalizeAutoTextMimetype(mimetype); }
}
