// SqlRite adapter: SHA-256 as hex, the content address every stored item carries. The filename
// owns SQLite's `sha256` name; deterministic permits SQLite optimization. {§packet-items}
import { createHash } from "node:crypto";

export const deterministic = true;
export default (text: string): string => createHash("sha256").update(text).digest("hex");
