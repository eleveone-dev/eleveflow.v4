# Eleve Flow Managed Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 16 July 2026 Eleve Flow snapshot to a new managed Supabase project and publish the app at `eleveflow.eleveone.com.br` from the VPS.

**Architecture:** The managed Supabase project provides Postgres, Auth, Storage, Realtime and Edge Functions. The VPS runs only the containerized TanStack application and Caddy reverse proxy. A migration tool validates and imports the approved CSV snapshot in dependency order without writing customer data or secrets to Git.

**Tech Stack:** TypeScript, Node.js, TanStack Start/Vite, Supabase CLI and Edge Functions, PostgreSQL, Docker Compose, Caddy, GitHub Actions-free SSH deployment.

**Spec:** `docs/superpowers/specs/2026-09-28-eleveflow-migration-design.md`

## Global Constraints

- Use only the `eleve.flow2.rar` CSV snapshot dated 16 July 2026 as migration data.
- Do not commit `.env`, `account_secrets.csv`, customer exports, service-role keys, API keys or SSH credentials.
- Preserve source UUIDs and import parent records before dependent records.
- Use new third-party secrets in production; do not activate legacy account credentials until individually validated.
- Publish only after automated checks, a recoverable database export and functional smoke tests pass.

## Review Focus

- Quoted CSV values with newlines must be parsed without altering message bodies; covered in Task 1.
- A missing parent UUID must stop import before writes; covered in Task 2.
- Legacy `account_secrets` must never enter Git or normal command output; covered in Task 2.
- Auth redirect and CORS must use the production domain, not a Lovable URL; covered in Task 3.
- A failed deploy must leave the previously working container running; covered in Task 5.

---

## File Structure

- `scripts/migration/validate-snapshot.mjs` — read-only CSV schema, count and relation validator.
- `scripts/migration/import-snapshot.mjs` — authenticated, transactional data importer with explicit table order.
- `scripts/migration/README.md` — operator instructions and required environment variables.
- `supabase/config.toml` — project configuration updated for the managed Supabase instance.
- `Dockerfile` — reproducible production application image.
- `deploy/docker-compose.yml` — app and Caddy production services.
- `deploy/Caddyfile` — HTTPS routing for `eleveflow.eleveone.com.br`.
- `.env.production.example` — non-secret production variable names only.
- `docs/operations/deployment.md` — deployment, rollback and backup runbook.

### Task 1: Sanitize the repository and validate the snapshot

**Files:**
- Create: `scripts/migration/validate-snapshot.mjs`
- Create: `scripts/migration/README.md`
- Modify: `.gitignore`
- Test: `tests/unit/validate-snapshot.test.ts`

**Interfaces:**
- Consumes: `MIGRATION_DIR` path containing approved CSV files.
- Produces: `validateSnapshot(directory: string): Promise<SnapshotReport>` where `SnapshotReport` contains per-table record counts, headers and validation errors.

- [ ] **Step 1: Write failing tests for BOM-free parsing, quoted newlines and required headers**
- [ ] **Step 2: Run `npm test -- tests/unit/validate-snapshot.test.ts` and confirm failure**
- [ ] **Step 3: Implement `validateSnapshot` with a streaming CSV parser and a required-table manifest**
- [ ] **Step 4: Add Git ignores for all environment files, CSV snapshot exports and database dump formats**
- [ ] **Step 5: Run the validator against `migracao/` and confirm it reports table counts without record contents**
- [ ] **Step 6: Run the unit test and confirm pass**
- [ ] **Step 7: Commit the code and documentation with `feat: add migration snapshot validation`**

### Task 2: Create the safe, ordered data importer

**Files:**
- Create: `scripts/migration/import-snapshot.mjs`
- Modify: `scripts/migration/README.md`
- Test: `tests/unit/import-snapshot.test.ts`

**Interfaces:**
- Consumes: `SnapshotReport`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `MIGRATION_DIR`.
- Produces: `importSnapshot(options): Promise<ImportReport>` with counts per table and a non-zero exit for validation or write errors.

- [ ] **Step 1: Write failing tests for parent-first order and rejection of orphaned foreign keys**
- [ ] **Step 2: Run `npm test -- tests/unit/import-snapshot.test.ts` and confirm failure**
- [ ] **Step 3: Implement the explicit order `accounts`, `pipeline_stages`, `flows`, `flow_blocks`, `leads`, `flow_executions`, `messages`, `send_queue`, `personal_tasks`, `logs`, `global_settings`, `extraction_history`, `objections`**
- [ ] **Step 4: Exclude `account_secrets.csv` by default; require a separate explicit operator flag and do not print its values**
- [ ] **Step 5: Run importer tests with a fake Supabase client and confirm no writes occur after an orphan error**
- [ ] **Step 6: Commit with `feat: add ordered snapshot importer`**

### Task 3: Provision and configure managed Supabase

**Files:**
- Modify: `supabase/config.toml`
- Modify: `.env.example`
- Modify: `src/routes/reset-password.tsx`
- Test: `tests/unit/production-config.test.ts`

**Interfaces:**
- Consumes: the newly created project reference and new public anon key supplied through local environment only.
- Produces: a linked Supabase CLI project, deployed migrations/functions, and production URL settings for `https://eleveflow.eleveone.com.br`.

- [ ] **Step 1: Create a new Supabase project in the `adm.eleveone@gmail.com` account and save its values only in local deployment environment files**
- [ ] **Step 2: Configure Auth site URL, allowed redirect URL, email settings, storage buckets and CORS for the production domain**
- [ ] **Step 3: Apply all `supabase/migrations` in chronological filename order and deploy every function in `supabase/functions`**
- [ ] **Step 4: Replace Lovable URLs in reset-password metadata/configuration with the production domain**
- [ ] **Step 5: Write and run a test asserting generated production URLs contain no `lovable.app` host**
- [ ] **Step 6: Execute a schema-only backup and record its checksum in the private deployment log**
- [ ] **Step 7: Commit non-secret configuration and URL changes with `chore: configure managed Supabase production target`**

### Task 4: Import and reconcile the approved snapshot

**Files:**
- Modify: `scripts/migration/README.md`
- Create: `docs/operations/data-migration.md`
- Test: `tests/unit/import-snapshot.test.ts`

**Interfaces:**
- Consumes: deployed schema, validated CSV snapshot and admin-created users mapped to source UUIDs.
- Produces: `ImportReport` and a private pre/post-import database backup.

- [ ] **Step 1: Create or restore the source user UUIDs in Auth before importing records that reference them**
- [ ] **Step 2: Run `validate-snapshot` and stop if headers, UUID relations or required tables are invalid**
- [ ] **Step 3: Run `import-snapshot` in dry-run mode; compare its report to the validator report**
- [ ] **Step 4: Create an on-demand backup of the empty target database**
- [ ] **Step 5: Run the actual import and save only aggregate counts in the private deployment log**
- [ ] **Step 6: Import storage objects only when a matching source export is available; otherwise record the deliberate omission**
- [ ] **Step 7: Run post-import count and referential-integrity checks; roll back from backup on failure**

### Task 5: Package and publish the application on the VPS

**Files:**
- Create: `Dockerfile`
- Create: `deploy/docker-compose.yml`
- Create: `deploy/Caddyfile`
- Create: `.env.production.example`
- Create: `docs/operations/deployment.md`
- Modify: `package.json`
- Test: `tests/unit/production-config.test.ts`

**Interfaces:**
- Consumes: production public Supabase URL/key and server-only runtime variables from `/opt/eleveflow/.env` on the VPS.
- Produces: `docker compose -f deploy/docker-compose.yml up -d` deployment serving HTTPS at the configured domain.

- [ ] **Step 1: Add a production Docker build and a `docker:verify` script that builds without development-only runtime assumptions**
- [ ] **Step 2: Write a failing config test for missing public Supabase URL/key and pass it after validation is added**
- [ ] **Step 3: Configure Caddy to route only `eleveflow.eleveone.com.br`, enforce HTTPS and forward requests to the app container**
- [ ] **Step 4: Create the VPS deployment directory, private environment file and Docker Compose service without putting secrets in Git**
- [ ] **Step 5: Build and start the replacement container only after its image build succeeds; retain the last image for rollback**
- [ ] **Step 6: Confirm `https://eleveflow.eleveone.com.br` returns a valid certificate and the application response**
- [ ] **Step 7: Commit deployment files with `feat: add VPS production deployment`**

### Task 6: Publish the sanitized source and verify operations

**Files:**
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/data-migration.md`

**Interfaces:**
- Consumes: sanitized working tree and successful VPS deployment.
- Produces: pushed `eleveone-dev/eleveflow.v4` repository and an operational acceptance record.

- [ ] **Step 1: Scan the tracked file set for environment files, CSV exports, database backups and known secret markers; stop on any finding**
- [ ] **Step 2: Initialize/link the remote GitHub repository, commit only sanitized source and push the deployment branch**
- [ ] **Step 3: Configure daily encrypted database backups on the VPS and document restore verification**
- [ ] **Step 4: Run smoke tests for login, a lead list, a flow read, storage access, an Edge Function health call and HTTPS redirect**
- [ ] **Step 5: Record the live URL, Git commit and backup location in the private deployment log**
- [ ] **Step 6: Commit documentation updates with `docs: add migration operations runbooks`**

## Self-Review

- **Spec coverage:** Tasks 1–2 protect/import snapshot data; Tasks 3–4 create and populate managed Supabase; Tasks 5–6 publish, protect and verify the VPS/GitHub/domain path.
- **Step scan:** Each deployment operation has a bounded action and check; credentials are explicitly local-only.
- **Type consistency:** `SnapshotReport` is produced by Task 1 and consumed by Task 2; `ImportReport` is produced by Task 2 and consumed by Task 4.
- **Review focus:** Each listed risk is bound to a validation or deployment task.
- **Proportion:** The plan records operational decisions without prescribing application implementation details.
