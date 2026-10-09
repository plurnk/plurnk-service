# @plurnk/plurnk-service

## 3.0.0

### Major Changes

- 85bcf56: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 69f3ffe: A family's `discover` advertises only the inputs it serves. An adapter declares
  `discovery.inputs` (and `emptyListsAll`), implements `discover` exactly when it
  does, and the coordinator builds the discover input schema from that
  declaration: any other input is refused 400 `arguments-invalid` by the shared
  schema check, naming the field. A family without discovery has no `discover`
  verb; MCP serves one only while `PLURNK_MCP_REGISTRY_URL` names a registry, and
  contains an invalid registry setting. Members discovery takes `query` alone and
  refuses a query naming no path or pattern as `query-invalid`; an empty env
  discovery is the whole catalog and needs no body. The refusals
  `query-unsupported`, `configuration-unsupported`, `source-unsupported`,
  `registry-not-configured`, `query-required` and schedule's `source-required`
  are gone.
- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them, and a setting nothing reads is inert. The package exports
  `./launch` and `./evidence`; the root export is removed. `plurnk-service paths
  migrate` and the startup check for a `~/.plurnk` home are removed; operator files
  live in the XDG locations. Workspace skills state is no longer moved from its
  pre-2.0 directory. Migration 20 carries existing databases forward in place: a
  WAIT receipt's unbounded `-1` marker is dropped, and the log projection loses its
  two unread admission columns.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.

### Minor Changes

- f1bbc46: Offer the native `question` tool only to a worker whose owner would receive
  it: an interactive owner that declares the tool. Other workers do not see it
  at turn 0 or in the reserved reference set, and a call is refused with a
  recovery saying nobody is present to answer. The tool is on by default;
  `PLURNK_EXECS_QUESTION=0` remains the operator's switch to remove it.
  Teaching now says SEND carries progress updates and WAIT yields to children
  and streams, without changing either operation's behavior.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.

### Patch Changes

- 85bcf56: Replace body-truncated assistant-history operations with one complete
  Previous Emission section at the end of the user packet. The most recent
  emission retains its real bodies, so examples no longer teach destructive empty
  EDIT operations. Older operation results remain in the ordinary curated log.
- e7e3b18: A loop no longer ends on a request the provider's exact count refuses while it
  could still fit: admission asks the provider to assess the exact request, then
  sheds the previous program and the newest rows by the refusal's excess. The
  context budget follows the current calibration both ways instead of holding a
  loop's high-water, so the over-budget row arrives at the provider's capacity.
- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- 0addc81: The worker summary gains a `Room:` line: the budget the model was shown, in
  provider tokens, against the capacity, and the wall's estimate against the
  provider's count, marking requests the estimate admitted over the wall.
  `EvidencePacket` carries `weight` and `budget`; an evidence implementation must
  provide them.
- 4153042: An owner declares whether a person attends it (`interactive`), beside the
  client tools it implements. A provider-recovery park and a clarification need
  an interactive owner; approval does not, so an automatically approving client
  that nobody attends concludes on a provider failure instead of parking. AG-UI
  reads `forwardedProps.plurnk.interactive`; unstated, nobody attends.
- 69f3ffe: A tool or family input schema that requires one of several inputs previews its
  first alternative's required fields, so the taught example satisfies the schema.
- 85bcf56: Exclude runtime bookkeeping from model-call ceiling inheritance. Model trees
  beneath `_plurnk` retain their own shared cap across children, grandchildren, and
  BARE; the default remains unlimited.
- 85bcf56: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.
- Updated dependencies [4bb8114]
- Updated dependencies [5f10995]
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [c053b24]
- Updated dependencies [0addc81]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [503ea87]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-a2a@3.0.0
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-agui@3.0.0
  - @plurnk/plurnk-modules@3.0.0
  - @plurnk/plurnk-meta@2.0.2
  - @plurnk/plurnk-schemes@3.0.0
  - @plurnk/plurnk-execs@3.0.0
  - @plurnk/plurnk-mcp@3.0.0
  - @plurnk/plurnk-skills@3.0.0
  - @plurnk/plurnk-schedule@3.0.0
  - @plurnk/plurnk-mimetypes@3.0.0
  - @plurnk/plurnk-parser@3.0.1
  - @plurnk/plurnk-digest@3.0.0
  - @plurnk/plurnk-models@3.0.0
  - @plurnk/plurnk-providers@3.0.0
  - @plurnk/plurnk-hooks@2.0.1
  - @plurnk/plurnk-schemes-http@2.0.1
  - @plurnk/plurnk-execs-sqlite@2.0.1
  - @plurnk/plurnk-execs-common@2.0.1
  - @plurnk/plurnk-agent-skills@2.0.1
  - @plurnk/plurnk-mimetypes-application-ipynb@2.0.1
  - @plurnk/plurnk-execs-jq@2.0.1
  - @plurnk/plurnk-mimetypes-application-json@2.0.1
  - @plurnk/plurnk-mimetypes-application-jsonl@2.0.1
  - @plurnk/plurnk-mimetypes-application-pdf@2.0.1
  - @plurnk/plurnk-mimetypes-application-xml@2.0.1
  - @plurnk/plurnk-mimetypes-audio@2.0.1
  - @plurnk/plurnk-mimetypes-image@2.0.1
  - @plurnk/plurnk-mimetypes-text-csv@2.0.1
  - @plurnk/plurnk-mimetypes-text-diff@2.0.1
  - @plurnk/plurnk-mimetypes-text-dotenv@2.0.1
  - @plurnk/plurnk-mimetypes-text-html@2.0.1
  - @plurnk/plurnk-mimetypes-text-ini@2.0.1
  - @plurnk/plurnk-mimetypes-text-markdown@2.0.1
  - @plurnk/plurnk-mimetypes-text-plain@2.0.1

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
