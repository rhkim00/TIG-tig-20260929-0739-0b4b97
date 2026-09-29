CREATE INDEX tasks_requester_period ON tasks(requester_id,created_at);
CREATE INDEX tasks_worker_lookup ON tasks(worker_id) WHERE worker_id IS NOT NULL;
CREATE INDEX settlements_period ON settlements(created_at);
