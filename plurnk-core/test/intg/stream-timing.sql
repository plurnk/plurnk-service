-- PREP: test_stream_opened_at
SELECT opened_at FROM subscriptions WHERE id = $id;

-- PREP: test_stream_clock
SELECT opened_at, output_changed_at FROM subscriptions WHERE id = $id;

-- PREP: test_stream_set_clock
UPDATE subscriptions SET opened_at = $opened_at, output_changed_at = $output_changed_at
WHERE id = $id;
