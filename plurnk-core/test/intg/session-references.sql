-- PREP: test_session_reference_delete_session
DELETE FROM sessions WHERE id = $session_id;
