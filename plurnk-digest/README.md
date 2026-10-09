# Plurnk Digest

Forensic Markdown, JSON, packet artifacts, SQLite snapshots and model interviews. Rendering is
independent of the daemon; the service supplies its canonical evidence reader.

Read `<worker>-<loop>-<turn>.request.md` for the model's ordered text input, with each message's
role and complete body. The digest names its role sequence beside each turn. `.assistant.md`
is that turn's **output**, not its input history; `.system.md` and `.user.md` are role-filtered
extracts. `.wire.json` contains the same ordered text input, not an HTTP capture.

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

The service CLI is `plurnk-service share [database] [folder] [--requiem]`; database and
share-directory selection are service-owned. See [SPEC.md](./SPEC.md) for evidence ownership,
artifact fidelity and reader lifetime. [.env.defaults](./.env.defaults) owns the interview
allowances, `PLURNK_DIGEST_REQUIEM_MAX_TOKENS` and `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`.
