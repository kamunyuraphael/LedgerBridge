# LedgerBridge

*Every sale, recorded once, ledgered everywhere.*

An automated **MERN → SharePoint Excel ledger engine**. A single-page React form posts a sale; the Express API stores it in MongoDB (source of truth) and a background worker appends it to a shared Excel workbook in SharePoint through Microsoft Graph, entirely in memory, with no local files and no paid middleware.

```
React/TS/Axios ──202 Accepted──▶ Express/TS ──▶ MongoDB (outbox, source of truth)
                                      │                     ▲ status: pending → processing → synced | failed
                                      ▼                     │
                               Sync worker (batches) ───────┘
                                      │ download → ArrayBuffer → ExcelJS append → Buffer
                                      ▼
                    @azure/msal-node (client credentials) ──▶ Microsoft Graph ──▶ SharePoint library
```

## Storage modes (set `GRAPH_MODE` in `server/.env`)

| Mode | Where the ledger lives | Cost | Guide |
|---|---|---|---|
| `mock` | in-memory fake (local dev) | free | none needed |
| `onedrive` | personal OneDrive folder, shared by link | **free** | [docs/FREE_ONEDRIVE_SETUP.md](docs/FREE_ONEDRIVE_SETUP.md) |
| `live` | SharePoint Online document library | needs a Microsoft 365 tenant | [docs/SHAREPOINT_SETUP.md](docs/SHAREPOINT_SETUP.md) |
| `sheets` | Google Sheet (one tab per month; downloadable as .xlsx) | **free**, no Microsoft account | [docs/GOOGLE_SHEETS_SETUP.md](docs/GOOGLE_SHEETS_SETUP.md) |

(`GRAPH_MODE` is the storage-mode switch; the name is kept for compatibility.)

## Quick start (local, no Azure needed)

```bash
npm run install:all
cp server/.env.example server/.env      # GRAPH_MODE=mock by default
# start MongoDB locally or point MONGODB_URI at Atlas
npm run dev:server                      # http://localhost:4000
npm run dev:client                      # http://localhost:5173 (proxies /api)
```

In mock mode the "SharePoint" is an in-memory fake. List files at `GET /api/dev/mock-ledger`, download one with `?file=Ledgers/Sales_Ledger_2026-11.xlsx`.

Other scripts: `npm run typecheck`, `npm run build`, `npm test` (offline suite, no MongoDB/Azure needed), `npm run check:schema`.

## Preparing a GitHub push

- Keep local credentials in `server/.env` and never commit downloaded service-account JSON keys. The root `.gitignore` excludes environment files, private keys, and service-account credential files; `server/.env.example` is safe to commit.
- If a credential was ever pushed to a remote, revoke or rotate it in its provider even after removing it from Git.
- GitHub Actions runs type checks, builds both apps, runs the offline test suite, and checks that the client/server sale schemas match on pushes and pull requests.

## How requirements are met

| Requirement | Implementation |
|---|---|
| UI | Tailwind v4 port of the Figma design: split hero/form layout, status indicator wired to `/api/health`, recent-transactions list with live sync badges; currency shown as KES (`VITE_CURRENCY` / `LEDGER_CURRENCY`) |
| Live input filters | `client/src/App.tsx` (`filters`): storeCode uppercased, sku trimmed, units digits only, revenue max 2 dp |
| Server re-validation | Zod schema in `server/src/schemas/sale.ts` (mirrored in `client/src/schemas/sale.ts`; `npm run check:schema` guards drift) |
| Timestamp | Stamped **server-side** (ISO-8601); the client's own time is kept as `clientSubmittedAt` |
| "Atomic" Mongo → SharePoint | Outbox pattern: Mongo write first, then worker sync; Mongo is always the source of truth |
| < 200 ms feedback | `POST /api/sales` returns `202` right after the Mongo insert; UI shows ack time and a live status badge |
| Concurrency safety | One in-process tick at a time, atomic Mongo claims across instances, eTag `If-Match` uploads, create-only (`conflictBehavior=fail`) init, conflict → re-read and retry |
| In-memory files | Graph download as `ArrayBuffer`, ExcelJS load/append, `writeBuffer()`, upload; nothing on disk |
| Auto-initialisation | Styled workbook created **only on a genuine 404** (a 403/5xx never overwrites the ledger) |
| Silent auth | SharePoint: `acquireTokenByClientCredential` (MSAL caches/renews). Free OneDrive: one-time device sign-in, then silent refresh-token renewal (encrypted in MongoDB) |
| Fault tolerance | Exponential backoff + jitter, `Retry-After` honoured, structured logs, `failed` state + admin retry |
| Idempotency | `recordId` UUID (client-generated, reused on retry) also written to a hidden sheet column; duplicates are skipped |
| Secrets | `.env` only, validated at boot; client bundle contains no secrets |
| Strict TS | `strict` + `noUncheckedIndexedAccess` in both tiers |
| Zero cost | No Zapier/Make/add-ins; open-source libraries, MongoDB Atlas M0, and a free destination: Google Sheets (`GRAPH_MODE=sheets`) or personal OneDrive (`onedrive`); SharePoint mode only if you already have a tenant |

## Azure / SharePoint setup (for `GRAPH_MODE=live`)

> Full step-by-step guide with test plan and troubleshooting: **[docs/SHAREPOINT_SETUP.md](docs/SHAREPOINT_SETUP.md)**. The summary below is the short version.

1. **Entra ID → App registrations → New registration** (single tenant). Copy *Tenant ID* and *Client ID*.
2. **Certificates & secrets → New client secret** → `AZURE_CLIENT_SECRET` (use a certificate in production).
3. **API permissions → Microsoft Graph → Application permissions → `Sites.Selected`** → *Grant admin consent*.
4. Grant the app access to **only your site** (as a Graph admin):
   `POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions` with body
   `{ "roles": ["write"], "grantedToIdentities": [{ "application": { "id": "<client-id>", "displayName": "LedgerBridge" } }] }`
5. Find IDs: `GET /sites/{hostname}:/sites/{site-name}` → `SP_SITE_ID`; `GET /sites/{site-id}/drives` → `SP_DRIVE_ID` (the *Documents* library).
6. Set `GRAPH_MODE=live`, `SP_FOLDER_PATH=Ledgers` (create the `Ledgers` folder in the library yourself).

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/sales` | `202` queued · `200` idempotent replay · `422` field issues · `429` rate-limited |
| GET | `/api/sales?limit=10` | recent records with sync status |
| GET | `/api/sales/:recordId` | single record status |
| POST | `/api/sales/:recordId/retry` | admin (`x-api-key`) re-queue of a `failed` record |
| POST | `/api/sales/retry-failed` | admin (`x-api-key`) re-queue **all** failed records |
| GET | `/api/health` | DB state and Graph mode |

## Known limits

- The submit endpoint has **no user authentication** (a key in a browser bundle would be public). It is protected by rate limiting, CORS and validation. Add Entra ID sign-in before exposing it beyond a trusted network.
- ExcelJS loads the whole workbook into RAM; monthly rollover keeps files small. Files over 4 MB use a Graph upload session (implemented, untested against a live tenant).
- Free hosting tiers that sleep delay syncs until the next wake; queued records are never lost.
