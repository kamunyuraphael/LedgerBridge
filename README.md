# LedgerBridge

A sales recording system for small businesses that captures sales once and syncs them to a shared ledger in a reliable, auditable way.

LedgerBridge is built as a small MERN-style application: a React frontend submits sales to an Express API, MongoDB stores the source of truth, and a background worker synchronizes the sales into an Excel-backed ledger in SharePoint, OneDrive, or Google Sheets.

The project is designed for businesses that want a simple workflow without manual spreadsheet reconciliation, while keeping the transaction history safe and recoverable.

## Why LedgerBridge?

Manual sales recording often leads to:

- duplicate entries
- missed ledger updates
- spreadsheet drift
- poor auditability
- account reconciliation headaches

LedgerBridge solves this by centralizing the source of truth in MongoDB and pushing ledger updates through a controlled sync pipeline.

## Architecture overview

```text
React / TypeScript / Axios
        │
        ▼
   Express API (TypeScript)
        │
        ▼
    MongoDB (source of truth)
        │
        ├── outbox / queued writes
        │
        ▼
  Sync worker (background processing)
        │
        ├── download ledger file
        ├── append sales rows
        ├── write workbook updates
        └── upload back to storage

Supported destinations:
- SharePoint Online
- OneDrive
- Google Sheets
- Mock mode for local development
```

## Core features

- Sale submission via a user-friendly React interface
- Server-side validation with strict schemas
- MongoDB-backed source of truth
- Background ledger synchronization pipeline
- Excel-based ledger updates via Graph API or sheet integrations
- Retry handling and failure tracking
- Idempotent record processing using a unique `recordId`
- Sync status monitoring for each sale
- Support for several storage modes
- Type-safe TypeScript code across client and server

## Storage modes

LedgerBridge supports several destinations for the ledger output. Choose the mode with `GRAPH_MODE` in `server/.env`.

| Mode | Destination | Cost | Notes |
|---|---|---:|---|
| `mock` | In-memory fake ledger | Free | Best for local development |
| `onedrive` | Personal OneDrive folder | Free | Good for lightweight, personal setups |
| `live` | SharePoint Online document library | Paid Microsoft 365 requirement | Production-grade option |
| `sheets` | Google Sheet | Free | Great when no Microsoft account is required |

> The `GRAPH_MODE` setting is kept for compatibility, even though the app is conceptually using a generalized storage layer.

## Project structure

```text
LedgerBridge/
├── client/                 # React + TypeScript frontend
├── server/                 # Express + TypeScript backend
├── docs/                   # Setup and deployment docs
├── scripts/                # Helper scripts
├── .github/                # GitHub automation/workflows
├── .gitignore
├── LICENSE
├── package.json
├── README.md
└── ...
```

## Quick start

### 1) Install dependencies

```bash
npm run install:all
```

### 2) Configure environment

```bash
cp server/.env.example server/.env
```

By default, `GRAPH_MODE=mock` is used for local development. This allows you to run the app without Azure or SharePoint credentials.

### 3) Start the app

```bash
npm run dev:server
npm run dev:client
```

- API: `http://localhost:4000`
- Client: `http://localhost:5173`

If you are using mock mode, the app still works locally without external integrations.

## Local development notes

- MongoDB must be running locally or accessible via a MongoDB URI
- You can point the server to MongoDB Atlas or any compatible instance
- The project includes validation and testing scripts for local use without needing cloud services

## Available scripts

```bash
npm run install:all
npm run dev:server
npm run dev:client
npm run typecheck
npm run build
npm test
npm run check:schema
```

## API overview

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/sales` | Submit a new sale for processing |
| `GET` | `/api/sales?limit=10` | Fetch recent sales and sync status |
| `GET` | `/api/sales/:recordId` | Check the status of a specific sale |
| `POST` | `/api/sales/:recordId/retry` | Re-queue a failed record (admin) |
| `POST` | `/api/sales/retry-failed` | Retry all failed records (admin) |
| `GET` | `/api/health` | Check DB state and configured Graph mode |

### Behavior summary

- `202 Accepted` means the sale was accepted and queued
- `200` may indicate an idempotent replay
- `422` means validation failed
- `429` indicates rate limiting

## Design principles

LedgerBridge is built around a few important principles:

1. MongoDB is the source of truth
2. The ledger file is a derived reporting layer
3. Sales are processed asynchronously to avoid blocking the user
4. Duplicate writes are prevented with idempotency controls
5. Failures are visible and recoverable
6. Local development should not require cloud credentials

## Security and operational notes

The project includes safeguards such as:

- environment-variable-based configuration
- no secrets embedded into the frontend bundle
- rate limiting on public endpoints
- validation on both client and server
- retry and failure handling for sync tasks
- careful treatment of Azure/MS Graph credentials

Before pushing code to GitHub, keep local secrets in `server/.env` and never commit credential files or private keys.

## Setup guides

Detailed configuration instructions are available in the docs folder:

- `docs/FREE_ONEDRIVE_SETUP.md`
- `docs/SHAREPOINT_SETUP.md`
- `docs/GOOGLE_SHEETS_SETUP.md`

## Known limitations

- The submit endpoint is intentionally public-facing and relies on validation and rate limiting rather than user authentication.
- ExcelJS loads workbook data into memory, so very large files should be managed carefully.
- Free hosting providers that sleep can delay background sync processing, though queued records are retained.

## License

This project is licensed under the MIT License. See `LICENSE` for details.

## Contributing

Contributions are welcome. If you want to improve the app, consider:

- improving validation and error handling
- making the Excel sync logic more robust
- adding better monitoring and analytics
- extending storage modes or documentation

## Summary

LedgerBridge is a practical, business-oriented sales ledger automation platform that blends a simple frontend, a validated API, and asynchronous syncing to spreadsheet-based storage. It is designed to keep the accounting and sales process consistent while reducing manual work and the risk of inaccurate ledger data.

If you want, I can also turn this into a more polished version tailored for GitHub, including badges, a cleaner architecture diagram, and a more product-style landing-page README.
