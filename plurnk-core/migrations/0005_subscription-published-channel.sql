-- MIGRATE: 5 subscription_published_channel
ALTER TABLE subscriptions
ADD COLUMN published_channel TEXT CHECK (published_channel IS NULL OR length(published_channel) > 0);
