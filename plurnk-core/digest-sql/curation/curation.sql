-- PREP: digest_curation_effects
SELECT operation_log_entry_id, target_log_entry_id,
       folded_before, folded_after, tags_added, tags_removed
FROM log_curation_effects
ORDER BY operation_log_entry_id, target_log_entry_id;
