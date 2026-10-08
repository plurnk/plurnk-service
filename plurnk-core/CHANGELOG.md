# @plurnk/plurnk-service

## 3.0.0

### Major Changes

- 36277b1: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 0d5480b: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings and
  owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no longer
  accept loop policy. A2A clarification still returns to the caller, separately
  from local operation approval. Existing databases upgrade in place.

### Patch Changes

- 0d5480b: Replace body-truncated assistant-history operations with one complete
  Previous Emission section at the end of the user packet. The most recent
  emission retains its real bodies, so examples no longer teach destructive empty
  EDIT operations. Older operation results remain in the ordinary curated log.
- 0b21165: Disable the native question tool by default through the existing executor switch;
  explicit opt-in preserves its implementation and client-interaction lifecycle.
  Clarify that SEND carries progress updates and WAIT yields to children and streams,
  without changing either operation's behavior.
- 6d0dfe7: Exclude runtime bookkeeping from model-call ceiling inheritance. Model trees
  beneath `_plurnk` retain their own shared cap across children, grandchildren, and
  BARE; the default remains unlimited.
- 8461082: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.
- Updated dependencies [36277b1]
- Updated dependencies [0d5480b]
- Updated dependencies [0b21165]
- Updated dependencies [ab05652]
- Updated dependencies [8461082]
- Updated dependencies [0d5480b]
  - @plurnk/plurnk-agui@3.0.0
  - @plurnk/plurnk-contracts@3.0.0
  - @plurnk/plurnk-modules@2.0.1
  - @plurnk/plurnk-meta@2.0.1
  - @plurnk/plurnk-execs@2.0.1
  - @plurnk/plurnk-schedule@3.0.0
  - @plurnk/plurnk-parser@3.0.0
  - @plurnk/plurnk-a2a@3.0.0
  - @plurnk/plurnk-digest@2.0.1
  - @plurnk/plurnk-hooks@2.0.1
  - @plurnk/plurnk-execs-common@2.0.1
  - @plurnk/plurnk-mcp@2.0.1
  - @plurnk/plurnk-skills@2.0.1
  - @plurnk/plurnk-providers@2.0.1
  - @plurnk/plurnk-agent-skills@2.0.1
  - @plurnk/plurnk-mimetypes@2.0.1
  - @plurnk/plurnk-schemes@2.0.1
  - @plurnk/plurnk-schemes-http@2.0.1

## 2.0.0

### Major Changes

- Tavily is a separately installed opt-in plugin. Users selecting `tavily-extract`
  must install `@plurnk/plurnk-tavily-plugin` beside the service; it is no longer bundled.
- Move Skills ownership to `@plurnk/plurnk-skills` and reporting to
  `@plurnk/plurnk-digest`. The service no longer exports `Skill`, `/digest`, or
  `/share`. Reporting consumers import the named `Digest` and `Share` exports from
  `@plurnk/plurnk-digest` and supply `openEvidence: EvidenceReader.open`, with
  `EvidenceReader` imported from `@plurnk/plurnk-service/evidence`.

  Rename `PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS` to
  `PLURNK_SKILLS_FETCH_TIMEOUT_MS`, and `PLURNK_SERVICE_REQUIEM_MAX_TOKENS` and
  `PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS` to `PLURNK_DIGEST_REQUIEM_MAX_TOKENS`
  and `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`. Retired names are rejected rather
  than maintained as aliases. The CLI's `share` command remains unchanged, and
  existing databases are upgraded in place.
- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-skills@2.0.0
  - @plurnk/plurnk-digest@2.0.0
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-modules@2.0.0
  - @plurnk/plurnk-parser@2.0.0
  - @plurnk/plurnk-agent-skills@2.0.0
  - @plurnk/plurnk-agent-plugins@2.0.0
  - @plurnk/plurnk-models@2.0.0
  - @plurnk/plurnk-mimetypes-application-json@2.0.0
  - @plurnk/plurnk-mimetypes-application-xml@2.0.0
  - @plurnk/plurnk-mimetypes-application-jsonl@2.0.0
  - @plurnk/plurnk-mimetypes-application-ipynb@2.0.0
  - @plurnk/plurnk-mimetypes-application-pdf@2.0.0
  - @plurnk/plurnk-mimetypes-image@2.0.0
  - @plurnk/plurnk-mimetypes-audio@2.0.0
  - @plurnk/plurnk-mimetypes-text-csv@2.0.0
  - @plurnk/plurnk-mimetypes-text-html@2.0.0
  - @plurnk/plurnk-mimetypes-text-markdown@2.0.0
  - @plurnk/plurnk-mimetypes-text-plain@2.0.0
  - @plurnk/plurnk-mimetypes-text-diff@2.0.0
  - @plurnk/plurnk-mimetypes-text-ini@2.0.0
  - @plurnk/plurnk-mimetypes-text-dotenv@2.0.0
  - @plurnk/plurnk-mimetypes@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
  - @plurnk/plurnk-schemes-http@2.0.0
  - @plurnk/plurnk-execs@2.0.0
  - @plurnk/plurnk-execs-common@2.0.0
  - @plurnk/plurnk-mcp@2.0.0
  - @plurnk/plurnk-hooks@2.0.0
  - @plurnk/plurnk-execs-jq@2.0.0
  - @plurnk/plurnk-execs-sqlite@2.0.0
  - @plurnk/plurnk-providers@2.0.0
  - @plurnk/plurnk-a2a@2.0.0
  - @plurnk/plurnk-schedule@2.0.0
  - @plurnk/plurnk-agui@2.0.0
