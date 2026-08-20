-- PREP: digest_derivation_state
SELECT COALESCE(SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END), 0) AS complete,
       COALESCE(SUM(CASE WHEN state = 'building' THEN 1 ELSE 0 END), 0) AS building
FROM derivations;
