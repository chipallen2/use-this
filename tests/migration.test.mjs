// tests/migration.test.mjs - the drop migration really removes every ut_ object
// created by the old design, touches nothing else, and is idempotent (PGlite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("sql: 20261111 drop migration removes ut_ objects only, idempotent", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(`DO $$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  // Old objects: ut_state (setup.sql minus pg_cron) + lease migration.
  await db.exec(`CREATE TABLE public.ut_state (id int PRIMARY KEY DEFAULT 1, last_calc timestamptz NOT NULL DEFAULT now(), picks jsonb NOT NULL DEFAULT '{}'::jsonb); INSERT INTO public.ut_state DEFAULT VALUES;`);
  await db.exec(readFileSync(new URL("../supabase/migrations/20260924_ut_recalc_lease.sql", import.meta.url), "utf8"));
  // A neighbouring app's objects in the shared project.
  await db.exec(`CREATE TABLE public.other_app (id int); CREATE TABLE public.utm_keep (id int); CREATE FUNCTION public.ut_claim_recalc_other() RETURNS int LANGUAGE sql AS 'select 1';`);
  const drop = readFileSync(new URL("../supabase/migrations/20261111_utm_drop_ut_recalc.sql", import.meta.url), "utf8");
  await db.exec(drop);
  await db.exec(drop); // idempotent
  const tables = (await db.query(`select tablename from pg_tables where schemaname='public' order by 1`)).rows.map((r) => r.tablename);
  assert.deepEqual(tables, ["other_app", "utm_keep"]);
  const fns = (await db.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where nspname='public' order by 1`)).rows.map((r) => r.proname);
  assert.deepEqual(fns, ["ut_claim_recalc_other"]);
  await db.close();
});
