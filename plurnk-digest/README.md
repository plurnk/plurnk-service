# Plurnk Digest

Forensic Markdown, JSON, packet artifacts, SQLite snapshots and model interviews. Rendering is
independent of the daemon; the service supplies its canonical evidence reader.

```ts
import { Digest, Share } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";

// A live database is snapshotted before reading.
await Share.write({ dbPath: "/data/plurnk.db", folder: "./report", openEvidence: EvidenceReader.open });

// A closed database can be read directly.
Digest.run({ dbPath: "./saved.db", digestDir: "./digest", openEvidence: EvidenceReader.open });
```

Neither path overwrites existing reports. An interview additionally requires an explicit
`provider`: `Digest.requiem({ dbPath, digestDir, openEvidence, provider })`; `Share.write`
accepts that provider as `requiem`. No route is selected and no inference occurs implicitly.

The service CLI remains `plurnk-service share [database] [folder] [--requiem]`.
See [SPEC.md](./SPEC.md) for evidence ownership, artifact fidelity and reader lifetime;
[.env.defaults](./.env.defaults) owns interview allowances.

## Upgrading

The former service `/digest` and `/share` exports are removed. Import this package and explicitly
supply the service's `/evidence` reader. The interview settings are
`PLURNK_DIGEST_REQUIEM_MAX_TOKENS` and `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`; the former
`PLURNK_SERVICE_REQUIEM_*` names are refused, not aliases. Database and share-directory selection
remain service-owned.
