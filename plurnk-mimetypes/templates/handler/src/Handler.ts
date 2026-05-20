import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";

// TODO: implement extract() to return structural declarations in {{MIMETYPE}}
// content. The framework derives symbols/preview/validate from this method.
//
// For grammar-backed extraction:
//   1. Vendor your .g4 files in grammar/.
//   2. Run `npx plurnk-mimetypes-compile` to generate the parser in src/generated/.
//   3. Switch the parent class to AntlrExtractor.
//   4. Implement parseTree(content) and createVisitor() instead of extract().
export default class {{CLASS_NAME}} extends BaseHandler {
    extract(_content: string): MimeSymbol[] {
        return [];
    }
}
