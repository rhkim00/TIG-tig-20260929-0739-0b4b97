CREATE TABLE notifications (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), task_id uuid NOT NULL REFERENCES tasks(id),
 business_key text NOT NULL, type text NOT NULL, title text NOT NULL, body text NOT NULL,
 created_at timestamptz NOT NULL, read_at timestamptz, UNIQUE(user_id,business_key)
);
CREATE INDEX notifications_inbox ON notifications(user_id,created_at DESC,id DESC);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE TABLE insight_snapshots (
 user_id uuid NOT NULL REFERENCES users(id), report_day date NOT NULL,
 segment text NOT NULL CHECK(segment IN ('real','development')), query_version integer NOT NULL,
 generated_at timestamptz NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(user_id,report_day,segment,query_version)
);
