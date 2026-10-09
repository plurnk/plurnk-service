import { extname } from "node:path";
import { fileURLToPath } from "node:url";

// SqlRite uses each module's filename as its SQL name, in source and packed builds.
export const sqlFunctionPaths = ["content_weight", "glob_match", "sha256"].map((name) =>
    fileURLToPath(new URL(`./${name}${extname(import.meta.filename)}`, import.meta.url)),
);
