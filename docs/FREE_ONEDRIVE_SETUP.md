# LedgerBridge: Free Setup (personal OneDrive, KES 0)

SharePoint Online needs a Microsoft 365 tenant, which isn't free for an individual (the free developer sandbox is limited to Visual Studio subscribers and partners, and the free school plan A1 is being retired). This guide uses a **free personal Microsoft account's OneDrive** (5 GB) instead. It is the same Microsoft Graph API and the same Excel ledger file, just hosted on OneDrive.

> **Can't get into Entra / register an app?** Use **[GOOGLE_SHEETS_SETUP.md](GOOGLE_SHEETS_SETUP.md)** instead. It needs only a Google account.

## What costs nothing

| Piece | Cost |
|---|---|
| React, Express, Mongoose, ExcelJS, MSAL (all open source) | free |
| MongoDB Atlas **M0** cluster (or a local MongoDB) | free |
| Personal Microsoft account + OneDrive 5 GB | free |
| Entra app registration (no Azure subscription / card needed) | free |
| Hosting | free while running locally; free hosting tiers exist but may sleep (queued records are never lost) |

## What differs from the SharePoint mode

| | SharePoint (`GRAPH_MODE=live`) | Free OneDrive (`GRAPH_MODE=onedrive`) |
|---|---|---|
| Where the ledger lives | company SharePoint library | your personal OneDrive folder, shared by link/invite |
| Sign-in | none (app-only) | **one-time** device sign-in, then silent refresh-token use |
| Needs | M365 tenant + admin consent | free Microsoft account only |
| Run | any number of servers | **one server instance only** (see caveats) |

Switching later is a `.env` change; the Excel files are the same format, so just copy them into the SharePoint library.

---

## Step 1: OneDrive folder
1. Sign in at https://onedrive.live.com with your Microsoft account (create a free one at outlook.com if needed).
2. Create a folder named `Ledgers`.

## Step 2: Register the app (free)
1. Go to **https://entra.microsoft.com** (or portal.azure.com), signed in with the **same personal Microsoft account**. If it offers to create a default directory, accept. It's free, and **no Azure subscription or card is required**.
2. **App registrations → New registration**
   - Name: `LedgerBridge`
   - Supported account types: **Personal Microsoft accounts only** (or *Accounts in any organizational directory and personal Microsoft accounts*). **Do not** leave the default *"this directory only"*: if you registered while signed in with a school/work account (e.g. your university one), that default blocks personal accounts and the sign-in fails with *"Selected user account does not exist in tenant 'Microsoft Services'"*.
   - Redirect URI: leave empty → **Register**
3. Copy the **Application (client) ID** → `AZURE_CLIENT_ID`.
4. **Authentication → Advanced settings → Allow public client flows = Yes → Save** (required for the device sign-in).
5. **API permissions → Add a permission → Microsoft Graph → Delegated permissions → `Files.ReadWrite`** → Add. (No admin consent needed for a personal account. `offline_access` is requested automatically.)

> If the portal blocks app registration for your account, stop here and tell me the exact message. I'll propose a fallback.

## Step 3: Configure `server/.env`
Generate an encryption key (it protects the stored refresh token in MongoDB):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
```env
GRAPH_MODE=onedrive
AZURE_CLIENT_ID=<application id from step 2>
TOKEN_ENCRYPTION_KEY=<the 64-character hex string>
SP_FOLDER_PATH=Ledgers
LEDGER_CURRENCY=KES
MONGODB_URI=<your Atlas or local MongoDB URI>
ADMIN_API_KEY=<any 16+ character secret>   # lets you re-queue failed records
```
Keep `TOKEN_ENCRYPTION_KEY` safe. If you lose it, just sign in again.

## Step 4: One-time sign-in
```bash
cd server
npm run auth:onedrive
```
It prints something like *"To sign in, open https://www.microsoft.com/link and enter code ABC123"*. Open the link, enter the code, sign in with the same Microsoft account and **Accept** the permission. The terminal then prints `Signed in as <your email>`.

## Step 5: Run and test
```bash
npm run dev:server     # and, in another terminal: npm run dev:client
```
Submit a sale. Within ~5 s, `Ledgers/Sales_Ledger_<YYYY-MM>.xlsx` appears in your OneDrive. Then follow **Part 5 (Test plan)** in `docs/SHAREPOINT_SETUP.md`: tests 5–10 apply unchanged (for test 8, "break the credentials" by running with a wrong `TOKEN_ENCRYPTION_KEY`, or simply go offline).

## Step 6: Share the ledger with your team
In OneDrive, select the **`Ledgers` folder → Share**, then add people (view only) or create a view-only link. Share the folder, not a single file, so new monthly files are included automatically. Open files in Excel for the web.

---

## Caveats (read these)
- **One server only.** Personal OneDrive's concurrency check on uploads is not confirmed. The built-in single-queue worker already prevents overlapping writes, but don't run two copies of the server against the same OneDrive.
- **Sign-in can lapse** (password change, access revoked, or a very long idle period). Symptoms: records stay *Queued*, the log says *"OneDrive is not signed in"*. Fix: `npm run auth:onedrive`, then
  `POST /api/sales/retry-failed` with header `x-api-key: <ADMIN_API_KEY>` to re-queue anything that exhausted its retries. Nothing is lost: it all stays in MongoDB.
- **Personal accounts only, 5 GB.** Monthly files stay tiny (thousands of rows are well under 1 MB).
- Not tried against a real Microsoft account yet, so please report anything unexpected (Graph error code + server log lines).
- Don't rename the `Ledger` sheet or delete the hidden *Record ID* column (see operating rules in the SharePoint guide).

## Troubleshooting
| Message | Meaning / fix |
|---|---|
| `OneDrive is not signed in` | Run `npm run auth:onedrive` |
| *"Selected user account does not exist in tenant 'Microsoft Services' and cannot access the application…"* | The app registration doesn't allow personal accounts. Entra → your app → **Manifest**: set `"signInAudience": "AzureADandPersonalMicrosoftAccount"` and, under `"api"`, `"requestedAccessTokenVersion": 2` → Save. If the save is rejected, create a new registration with the right account type and use its client ID |
| `AADSTS7000218` / "client_assertion or client_secret required" | Step 2.4 missed: set *Allow public client flows = Yes* |
| `AADSTS70002` / `unauthorized_client` | App registered for the wrong account type; recreate with *Personal Microsoft accounts only* |
| `AADSTS65001` consent required | Redo Step 4 and click **Accept** |
| 403 `accessDenied` | `Files.ReadWrite` permission missing (Step 2.5) |
| 404 on first submit | Normal: the file is created on first write |
| `Invalid environment configuration … TOKEN_ENCRYPTION_KEY` | Must be exactly 64 hex characters |
