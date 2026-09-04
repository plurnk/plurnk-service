-- PREP: digest_curation_effects
SELECT operation_log_entry_id, target_log_entry_id,
       active_before, active_after,
       folded_before, folded_after
FROM log_curation_effects
ORDER BY operation_log_entry_id, target_log_entry_id;
