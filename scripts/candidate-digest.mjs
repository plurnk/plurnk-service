import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// {§candidate-pinned-runtime} — the exporter is the pinned runtime's own build, the daemon's.
const [runtime, dbPath, digestDir] = process.argv.slice(2);
if (!runtime || !dbPath || !digestDir) throw new Error("Candidate digest requires the pinned runtime, database and output paths");
const { Digest } = await import(pathToFileURL(resolve(runtime, "plurnk-digest", "dist", "index.js")).href);
const { default: EvidenceReader } = await import(pathToFileURL(resolve(runtime, "plurnk-core", "dist", "evidence", "EvidenceReader.js")).href);
Digest.run({ dbPath, digestDir, openEvidence: EvidenceReader.open });
