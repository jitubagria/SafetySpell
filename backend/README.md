# SafetySpell Core API — Rescue ID V1

This is an independent NestJS + PostgreSQL service. It is not connected to the React/PWA prototype. The service implements the public-only consent boundary recorded in `D:\project-wiki\10-systems\safetyspell\decisions\adr-0001-public-only-rescue-id-consent-boundary.md`.

## Safety boundary

- A ward never authenticates. A user must have an active `ward_guardians` authorisation record to read or change that ward.
- V1 has only `private` and `public` release. The PostgreSQL enum reserves `verified_emergency_responder`, but database constraints and APIs reject it.
- `GET /v1/public/scan/:tagCode` receives only the filtered projection. It cannot return an unfiltered ward/profile, address, report, medication history, raw contact target, or internal identifier.
- A public value requires: active tag, active ward, approved catalog entry, catalog `public_eligible`, catalog `max_level=public`, and explicit ward public visibility.
- Guardians cannot store arbitrary JSON in a catalog field. Catalog type and validation policy are enforced before persistence. Public-eligible fields must be controlled `enum` or `boolean` values with a non-empty `allowed_values` policy; public free text is prohibited. Private text remains bounded by a catalog-defined maximum length.
- Catalog seeds are draft/unapproved. Only an explicitly assigned `clinical_reviewer` may approve a catalog field, clinically verify a value, or publish guidance; `staff` and `company_admin` do not implicitly have that capability.
- There are no live actions, calls, SMS/WhatsApp, alerts, location sharing, responder routes, NFC security claims, orders, inventory, or pricing in V1.
- This implementation does **not** claim DPDP compliance. The privacy-notice endpoint is a versioned placeholder; legal notice and review remain required.

## Run locally

1. Create a PostgreSQL database and copy `.env.example` to `.env` with a real `DATABASE_URL` and a 32+ character JWT secret.
2. Install dependencies: `npm install`.
3. Build: `npm run build`.
4. Apply schema: `npm run db:migrate`.
5. Run: `npm start` (or `npm run start:dev`). API routes begin with `/v1`.
6. Run adversarial tests: `npm test`.

The public scan endpoint is rate-limited (30 requests/IP/minute). Scan logs use a separate keyed HMAC secret for optional IP pseudonymisation; they never retain raw IPs. If that secret is absent, the IP-derived log field is omitted rather than falling back to a reversible hash or raw IP.

## Important endpoint groups

- `POST /v1/auth/login`
- `GET /v1/public/scan/:tagCode` — no login
- `GET /v1/app/wards`, `GET /v1/app/wards/:wardId`, field writes and visibility controls — guardian auth plus active authorisation
- `POST /v1/app/wards/:wardId/public-release/withdraw` — atomic withdrawal with append-only audit entries
- Clinical-reviewer-only catalog approval, clinical verification, and guidance publication routes
- `GET /v1/privacy-notices/current` — published notice retrieval only; no compliance assertion

## Migration notes

The migration includes a database trigger that rejects update/delete operations on `consent_audit`. Scan logs contain only tag reference, policy version, shown field keys, time, and an optional keyed-HMAC IP pseudonym; they do not contain values, contacts, raw IPs, or location.
