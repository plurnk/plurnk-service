---
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-service": major
---

Retire `.env`-mutating `service.env.*` and `models.local` actions, scope
`ProposalPolicy` (`mode`) to the session and single-loop `?` prompt override
(`027_session_proposal_policy.sql`), enforce `ModelCatalogQuery` `limit <= 100`,
and share interactive slash-command completion across clients (#1545).
