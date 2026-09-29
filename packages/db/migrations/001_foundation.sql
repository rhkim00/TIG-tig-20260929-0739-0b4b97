CREATE TABLE users(id uuid PRIMARY KEY, github_id text UNIQUE NOT NULL, login text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), optional_analytics boolean NOT NULL DEFAULT false);
CREATE TABLE sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE oauth_states(state_hash text PRIMARY KEY, verifier text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE devices(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, token_hash text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE TABLE pairings(device_hash text PRIMARY KEY, user_code text UNIQUE NOT NULL, name text NOT NULL, user_id uuid REFERENCES users(id), expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE projects(id uuid PRIMARY KEY, github_repo_id text UNIQUE NOT NULL, repository text NOT NULL, canonical_url text NOT NULL, fork_parent_id text, observed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_links(user_id uuid REFERENCES users(id), project_id uuid REFERENCES projects(id), project_type text NOT NULL, stack jsonb NOT NULL, PRIMARY KEY(user_id,project_id));
CREATE TABLE artifacts(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),base_commit text NOT NULL,summary text NOT NULL,manifest_hash text NOT NULL,files jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ledger_accounts(id text PRIMARY KEY, user_id uuid REFERENCES users(id),kind text NOT NULL CHECK(kind IN ('available','escrow','issuance')), balance numeric(20,2) NOT NULL DEFAULT 0 CHECK(kind='issuance' OR balance>=0));
CREATE TABLE ledger_transactions(id uuid PRIMARY KEY,business_key text UNIQUE NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ledger_entries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tx_id uuid NOT NULL REFERENCES ledger_transactions(id),account_id text NOT NULL REFERENCES ledger_accounts(id),delta numeric(20,2) NOT NULL CHECK(delta<>0));
CREATE TABLE tasks(id uuid PRIMARY KEY,requester_id uuid NOT NULL REFERENCES users(id),project_id uuid NOT NULL REFERENCES projects(id),artifact_id uuid NOT NULL REFERENCES artifacts(id),spec jsonb NOT NULL,reward numeric(20,2) NOT NULL CHECK(reward>0),state text NOT NULL CHECK(state IN ('OPEN','CLAIMED','EXECUTING','INTERRUPTED','VALIDATING','AWAITING_REVIEW','PAID','REFUNDED')),version integer NOT NULL DEFAULT 1,execution_deadline_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE settlements(task_id uuid PRIMARY KEY REFERENCES tasks(id),kind text NOT NULL CHECK(kind IN ('paid','refunded')),reason text NOT NULL,ledger_tx_id uuid UNIQUE NOT NULL REFERENCES ledger_transactions(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE observations(user_id uuid REFERENCES users(id),provider text CHECK(provider IN ('codex','claude')),body jsonb NOT NULL,observed_at timestamptz NOT NULL,PRIMARY KEY(user_id,provider));
CREATE TABLE plan_prices(id uuid PRIMARY KEY,provider text NOT NULL,plan_id text NOT NULL,monthly_usd numeric(12,2) NOT NULL CHECK(monthly_usd>0),source_url text NOT NULL,checked_at timestamptz NOT NULL,UNIQUE(provider,plan_id,checked_at));
-- A client observation is NEVER an entitlement. Only a separately trusted verifier may write this table.
CREATE TABLE entitlements(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),provider text NOT NULL CHECK(provider IN ('codex','claude')),subject_hash text NOT NULL,price_id uuid NOT NULL REFERENCES plan_prices(id),status text NOT NULL CHECK(status IN ('verified','unavailable','cancelled')),verified_until timestamptz NOT NULL,first_verified_at timestamptz NOT NULL,UNIQUE(user_id,provider),UNIQUE(provider,subject_hash));
CREATE TABLE subscription_grants(entitlement_id uuid REFERENCES entitlements(id),period_index integer CHECK(period_index>=0),price_id uuid NOT NULL REFERENCES plan_prices(id),amount numeric(20,2) NOT NULL,ledger_tx_id uuid UNIQUE NOT NULL REFERENCES ledger_transactions(id),PRIMARY KEY(entitlement_id,period_index));
CREATE TABLE idempotency(actor_id uuid NOT NULL,route text NOT NULL,key text NOT NULL,body_hash text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(actor_id,route,key));
CREATE TABLE outbox(id uuid PRIMARY KEY,aggregate_id uuid NOT NULL,type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz);
CREATE TABLE operational_events(id uuid PRIMARY KEY REFERENCES outbox(id),type text NOT NULL,payload jsonb NOT NULL,occurred_at timestamptz NOT NULL);
CREATE INDEX tasks_open ON tasks(created_at DESC) WHERE state='OPEN';
CREATE INDEX entries_account ON ledger_entries(account_id);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Ledger history is append-only'; END $$;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
CREATE TRIGGER transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
CREATE FUNCTION check_ledger_tx() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; count_entries integer;
BEGIN
 SELECT coalesce(sum(delta),0),count(*) INTO total,count_entries FROM ledger_entries WHERE tx_id=NEW.id;
 IF total<>0 OR count_entries<2 THEN RAISE EXCEPTION 'Unbalanced ledger transaction'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_transaction AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_tx();
CREATE FUNCTION check_ledger_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual numeric; expected numeric;
BEGIN
 SELECT balance INTO actual FROM ledger_accounts WHERE id=NEW.account_id;
 SELECT coalesce(sum(delta),0) INTO expected FROM ledger_entries WHERE account_id=NEW.account_id;
 IF actual<>expected THEN RAISE EXCEPTION 'Account balance differs from entries'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciled_account AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_account();
INSERT INTO ledger_accounts(id,kind) VALUES('system:issuance','issuance');
