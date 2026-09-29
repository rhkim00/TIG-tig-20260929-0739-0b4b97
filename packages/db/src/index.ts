import pg, { type PoolClient } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { amount } from "../../contracts/src/index.js";
export type DB = pg.Pool;
export type Tx = PoolClient;
export const pool = (url: string) =>
  new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}
export async function transaction<T>(
  db: DB,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (e) {
      await tx.query("ROLLBACK");
      if (
        attempt < 2 &&
        ["40001", "40P01"].includes((e as { code?: string }).code ?? "")
      )
        continue;
      throw e;
    } finally {
      tx.release();
    }
  }
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function idempotent<T>(
  db: DB,
  actor: string,
  route: string,
  key: unknown,
  body: unknown,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof key !== "string" || !/^[-A-Za-z0-9_:]{8,128}$/.test(key))
    throw new DomainError(
      "IDEMPOTENCY_REQUIRED",
      "Use a stable Idempotency-Key for this action.",
    );
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${actor}:${route}:${key}`,
    ]);
    const existing = (
      await tx.query(
        "SELECT * FROM idempotency WHERE actor_id=$1 AND route=$2 AND key=$3",
        [actor, route, key],
      )
    ).rows[0];
    const digest = hash(canonical(body));
    if (existing) {
      if (existing.body_hash !== digest)
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This key was used for different content.",
          409,
        );
      return existing.response as T;
    }
    const response = await fn(tx);
    await tx.query("INSERT INTO idempotency VALUES($1,$2,$3,$4,$5)", [
      actor,
      route,
      key,
      digest,
      JSON.stringify(response),
    ]);
    return response;
  });
}
export async function emit(
  tx: Tx,
  type: string,
  aggregate: string,
  payload: Record<string, unknown>,
) {
  await tx.query(
    "INSERT INTO outbox(id,aggregate_id,type,payload) VALUES($1,$2,$3,$4)",
    [randomUUID(), aggregate, type, JSON.stringify(payload)],
  );
}
export async function transfer(
  tx: Tx,
  key: string,
  reason: string,
  from: string,
  to: string,
  value: bigint,
): Promise<string> {
  if (value <= 0n)
    throw new DomainError("INVALID_AMOUNT", "Amount must be positive.");
  const accounts = (
    await tx.query(
      "SELECT * FROM ledger_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
      [[from, to]],
    )
  ).rows;
  if (accounts.length !== 2) throw new Error("Missing ledger accounts");
  const id = randomUUID();
  await tx.query(
    "INSERT INTO ledger_transactions(id,business_key,reason) VALUES($1,$2,$3)",
    [id, key, reason],
  );
  const debit = await tx.query(
    "UPDATE ledger_accounts SET balance=balance-$2 WHERE id=$1 AND (kind='issuance' OR balance >= $2) RETURNING id",
    [from, amount(value)],
  );
  if (!debit.rowCount)
    throw new DomainError(
      "INSUFFICIENT_TIG",
      "Your available TIG is below this reward.",
      409,
    );
  await tx.query("UPDATE ledger_accounts SET balance=balance+$2 WHERE id=$1", [
    to,
    amount(value),
  ]);
  await tx.query(
    "INSERT INTO ledger_entries(tx_id,account_id,delta) VALUES($1,$2,$4::numeric*-1),($1,$3,$4)",
    [id, from, to, amount(value)],
  );
  return id;
}
export async function upsertUser(tx: Tx, githubId: string, login: string) {
  const user = (
    await tx.query(
      "INSERT INTO users(id,github_id,login) VALUES($1,$2,$3) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login RETURNING *",
      [randomUUID(), githubId, login],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO ledger_accounts(id,user_id,kind) VALUES($1,$2,'available') ON CONFLICT DO NOTHING",
    [`user:${user.id}`, user.id],
  );
  return user as { id: string; login: string };
}
