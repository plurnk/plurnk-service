-- {§validation-topology} witness statements: one settled result applied to chapter 7.

-- PREP: test_topology_settle_subscription
UPDATE subscriptions
SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    close_status = $status,
    close_result = $result,
    channel_results = '{}'
WHERE id = $subscription_id;

-- PREP: test_topology_subscription_closed
SELECT close_status FROM subscriptions WHERE id = $subscription_id AND closed_at IS NOT NULL;
