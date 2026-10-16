-- PREP: test_worker_reference_delete_worker
DELETE FROM workers WHERE id = $worker_id;
