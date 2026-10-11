// Core facade over the shared resolver; callers supply their creation type
// under {§ext-mimetype-extension-mimetype} and {§copy-destination-mimetype}.
import { PathMimetype as _PathMimetype } from "@plurnk/plurnk-schemes";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

export default class PathMimetype {
    static resolveEntryMimetype(pathname: string, schemeDefault: string, mimetypes: Mimetypes | undefined): Promise<string> {
        return _PathMimetype.resolve(pathname, schemeDefault, mimetypes);
    }
}
