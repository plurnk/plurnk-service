import Digest from "../plurnk-core/dist/digest/Digest.js";

const [dbPath, digestDir] = process.argv.slice(2);
if (!dbPath || !digestDir) throw new Error("Candidate digest requires database and output paths");
Digest.run({ dbPath, digestDir });
