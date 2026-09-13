# SafetySpell Core API — Rescue ID V1

This is an independent NestJS + PostgreSQL service. It can serve the demo-gated React/PWA locally through an explicitly configured browser origin; it is not deployed or connected to a production frontend. The service implements the public-only consent boundary recorded in `D:\project-wiki\10-systems\safetyspell\decisions\adr-0001-public-only-rescue-id-consent-boundary.md`.

## Safety boundary

- A ward never authenticates. A user must have an active `ward_guardians` authorisation record to read or change that ward.
- V1 has only `private` and `public` release. The PostgreSQL enum reserves `verified_emergency_responder`, but database constraints and APIs reject it.
- `GET /v1/public/scan/:tagCode` receives only the filtered projection. It cannot return an unfiltered ward/profile, address, report, medication history, raw contact target, or internal identifier.
- A public value requires: active tag, active ward, approved catalog entry, catalog `public_eligible`, catalog `max_level=public`, and explicit ward public visibility.
- Guardians cannot store arbitrary JSON in a catalog field. Catalog type and validation policy are enforced before persistence. Bounded public free text is permitted only after server-side sanitisation; links and markup are neutralised before storage.
- Public-capable catalog fields are owner/policy-cleared. Every value is `guardian_reported`; there is no `clinical_reviewer`, clinical-verification, or guidance-publication path.
- There are no live actions, calls, SMS/WhatsApp, alerts, location sharing, responder routes, NFC security claims, orders, inventory, or pricing in the current V1 baseline.
- This implementation does **not** claim DPDP compliance. The privacy-notice endpoint is a versioned placeholder; legal notice and review remain required.

## Run locally

1. Create a PostgreSQL database and copy `.env.example` to `.env` with a real `DATABASE_URL` and a 32+ character JWT secret.
2. Install dependencies: `npm install`.
3. Build: `npm run build`.
4. Apply schema: `npm run db:migrate`.
5. Run: `npm start` (or `npm run start:dev`). API routes begin with `/v1`.
6. Run the unit suite: `npm test -- --testPathIgnorePatterns=integration-db.spec.ts`.
7. Run the full suite only with `INTEGRATION_DATABASE_URL` set to a disposable database: `npm test`.

## Local frontend bridge (prototype only)

The React frontend can use the real local API for `age_band`, `primary_language`, `blood_group`, and `allergy`. Values remain private until an authorised guardian explicitly releases a public-capable field; there is no reviewer route.

1. In `backend/.env`, set `FRONTEND_ORIGIN=http://localhost:5173` (or an explicit comma-separated local origin list).
2. In the repository root, copy `.env.example` to `.env.local`; keep `VITE_CORE_API_URL=http://localhost:3001` for local development.
3. Start this API with `npm run start:dev` from `backend/`, then start the frontend from the repository root with `npm run dev`.

Browser CORS is restricted to `FRONTEND_ORIGIN`; it does not use a wildcard. The frontend keeps its visible `DEMO / PROTOTYPE — not for real emergencies` gate and does not expose calls, messages, alerts, location, NFC, photos, names, clinical fields, or action handles.

## PostgreSQL-backed integration test setup

Use an isolated database only. The following PowerShell setup was verified against a local PostgreSQL 16 service; it does not modify any existing application database.

```powershell
$pgBin = 'C:\Program Files\PostgreSQL\16\bin'
& "$pgBin\createdb.exe" -h 127.0.0.1 -U postgres safetyspell_integration
$env:DATABASE_URL = 'postgres://postgres@127.0.0.1:5432/safetyspell_integration'
$env:INTEGRATION_DATABASE_URL = $env:DATABASE_URL
$env:AUTH_JWT_SECRET = 'replace-with-a-test-only-secret-of-32-or-more-characters'
$env:SCAN_LOG_IP_HMAC_SECRET = 'replace-with-a-different-test-only-secret-of-32-or-more-characters'
npm run build
npm run db:migrate
npm run test:integration
npm test
```

`test:integration` truncates only tables inside `safetyspell_integration` between tests. It proves migration-created constraints/triggers, public projection gates, transactional withdrawal, real HTTP/JWT authorisation, and scan throttling. Do not point it at a shared or production database. When finished, remove only this known disposable database if desired:

```powershell
& "$pgBin\dropdb.exe" -h 127.0.0.1 -U postgres safetyspell_integration
```

The public scan endpoint is rate-limited (30 requests/IP/minute). Scan logs use a separate keyed HMAC secret for optional IP pseudonymisation; they never retain raw IPs. If that secret is absent, the IP-derived log field is omitted rather than falling back to a reversible hash or raw IP.

## Important endpoint groups

- `POST /v1/auth/login`
- `GET /v1/public/scan/:tagCode` — no login
- `GET /v1/app/wards`, `GET /v1/app/wards/:wardId`, field writes and visibility controls — guardian auth plus active authorisation
- `POST /v1/app/wards/:wardId/public-release/withdraw` — atomic withdrawal with append-only audit entries
- `GET /v1/privacy-notices/current` — published notice retrieval only; no compliance assertion

## Migration notes

The migration includes a database trigger that rejects update/delete operations on `consent_audit`. Scan logs contain only tag reference, policy version, shown field keys, time, and an optional keyed-HMAC IP pseudonym; they do not contain values, contacts, raw IPs, or location.
