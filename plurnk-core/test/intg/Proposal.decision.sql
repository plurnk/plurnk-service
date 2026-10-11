-- PREP: test_proposal_decision
SELECT decision, resolver, body, outcome, decided_at FROM proposal_decisions
WHERE log_entry_id = $id;

-- PREP: test_proposal_decision_rewrite
UPDATE proposal_decisions SET decision = 'reject' WHERE log_entry_id = $id;

-- PREP: test_proposal_decision_delete
DELETE FROM proposal_decisions WHERE log_entry_id = $id;
