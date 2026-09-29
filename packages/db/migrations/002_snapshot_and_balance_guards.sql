ALTER TABLE artifacts ADD COLUMN deleted_paths jsonb NOT NULL DEFAULT '[]';
CREATE FUNCTION check_account_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual numeric; expected numeric;
BEGIN
 SELECT balance INTO actual FROM ledger_accounts WHERE id=NEW.id;
 SELECT coalesce(sum(delta),0) INTO expected FROM ledger_entries WHERE account_id=NEW.id;
 IF actual<>expected THEN RAISE EXCEPTION 'Account balance differs from entries'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER checked_account_update AFTER INSERT OR UPDATE ON ledger_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_account_update();
