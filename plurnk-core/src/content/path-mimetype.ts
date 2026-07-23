// Path-extension mimetype resolver for entry schemes — single source of truth
// is @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the
// plugin's function; call sites stay `PathMimetype.resolveEntryMimetype(...)`.
//
// A pathname's extension drives the effective mimetype (§ext-mimetype-extension-mimetype; via the sibling
// Mimetypes detect service); the scheme manifest's channel default is the
// fallback when no extension is present. `known:///users.json` →
// application/json; `known:///notes` → scheme default.
import { PathMimetype as _PathMimetype } from "@plurnk/plurnk-schemes";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

export default class PathMimetype {
    static resolveEntryMimetype(pathname: string, schemeDefault: string, mimetypes: Mimetypes | undefined): Promise<string> {
        return _PathMimetype.resolve(pathname, schemeDefault, mimetypes);
    }
}
