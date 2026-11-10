# LedgerBridge: SharePoint Setup & Test Guide

> **Zero-cost budget?** SharePoint Online requires a Microsoft 365 tenant, which is not free for individuals. Use **[FREE_ONEDRIVE_SETUP.md](FREE_ONEDRIVE_SETUP.md)** instead (personal OneDrive, KES 0). Only the test plan in Part 5 below is shared by both.

Goal: let the LedgerBridge server read and write **one ledger workbook folder** in **one SharePoint site**, with no human sign-in and the smallest possible permission.

**Time:** ~30–45 min. **You need:** a Microsoft 365 work/school tenant with SharePoint Online, and an account that can (a) create sites, (b) register Entra apps and (c) grant admin consent (Global Administrator, or Application Administrator + SharePoint admin). A personal Microsoft account / personal OneDrive will **not** work.

> No tenant? Skip to **Part 5** and test everything in `GRAPH_MODE=mock` first. The Microsoft 365 Developer Program sandbox may be available to you for a free test tenant (eligibility has changed over time, so check on Microsoft's site).

---

## Part 1: SharePoint site and folder

1. Open **SharePoint admin center → Sites → Active sites → Create** (or from the SharePoint start page → *Create site*).
2. Choose **Team site**, name it e.g. `Sales Operations`. Note its URL: `https://<tenant>.sharepoint.com/sites/SalesOperations`.
3. Open the site → **Documents** library → **New → Folder** → name it `Ledgers`.
   (The app also tries to create it on first upload, but creating it yourself removes a variable.)
4. Confirm **versioning** is on: Library settings → *Versioning settings* → Create a version each time a file is edited = **Yes**. This is your safety net: any bad write can be rolled back from *Version history*.
5. Share the `Ledgers` folder with the people who should **read** the ledger. They never need to edit it.

---

## Part 2: Register the app in Entra ID

1. Go to **https://entra.microsoft.com → Entra ID → App registrations → New registration**.
2. Name: `LedgerBridge Sync`. Supported account types: **Single tenant**. Redirect URI: leave empty. **Register**.
3. On the Overview page, copy:
   - **Application (client) ID** → `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → `AZURE_TENANT_ID`
4. **Certificates & secrets → Client secrets → New client secret.** Pick an expiry (e.g. 12 months) and **copy the *Value* immediately** (not the *Secret ID*). It is shown only once. → `AZURE_CLIENT_SECRET`.
   Put a calendar reminder for the expiry date: when it lapses, every sync fails with a 401.

---

## Part 3: Give the app least-privilege access (`Sites.Selected`)

`Sites.Selected` grants **nothing by default**. You add the permission, then explicitly grant it for the single site. This is much safer than `Sites.ReadWrite.All`.

1. **API permissions → Add a permission → Microsoft Graph → *Application permissions*** (not Delegated) → search `Sites.Selected` → **Add permissions**.
2. Click **Grant admin consent for <tenant>** and confirm. The status column should show a green tick.
3. You can remove the default `User.Read` delegated permission. It isn't needed.

### 3a. Find the Site ID
Open **Graph Explorer** (https://developer.microsoft.com/graph/graph-explorer), sign in as an admin, and run:

```
GET https://graph.microsoft.com/v1.0/sites/<tenant>.sharepoint.com:/sites/SalesOperations
```

Copy the whole `id` value. It has three comma-separated parts:
`<tenant>.sharepoint.com,<siteCollectionGuid>,<webGuid>` → `SP_SITE_ID` (use the full string).

### 3b. Grant the app **write** access to that site only
In Graph Explorer, run (you may be asked to consent to `Sites.FullControl.All` for Graph Explorer itself; this is for your admin session, not the app):

```
POST https://graph.microsoft.com/v1.0/sites/<SP_SITE_ID>/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [
    { "application": { "id": "<AZURE_CLIENT_ID>", "displayName": "LedgerBridge Sync" } }
  ]
}
```

Expect `201 Created`. Use `write` (read + write files). Do **not** use `fullcontrol`.

*Alternative (PnP PowerShell):* `Grant-PnPAzureADAppSitePermission -AppId <client-id> -DisplayName "LedgerBridge Sync" -Site https://<tenant>.sharepoint.com/sites/SalesOperations -Permissions Write`

### 3c. Find the Drive ID (the Documents library)
```
GET https://graph.microsoft.com/v1.0/sites/<SP_SITE_ID>/drives
```
Pick the entry named **Documents** and copy its `id` (starts with `b!`) → `SP_DRIVE_ID`.

---

## Part 4: Configure LedgerBridge

Edit `server/.env`:

```env
GRAPH_MODE=live
AZURE_TENANT_ID=<directory id>
AZURE_CLIENT_ID=<application id>
AZURE_CLIENT_SECRET=<secret VALUE>
SP_SITE_ID=<tenant>.sharepoint.com,<guid>,<guid>
SP_DRIVE_ID=b!<long id>
SP_FOLDER_PATH=Ledgers
LEDGER_FILE_PREFIX=Sales_Ledger
LEDGER_ROLLOVER=monthly
LEDGER_CURRENCY=KES
MONGODB_URI=<your connection string>
```

- **MongoDB Atlas (free M0):** create a cluster → *Database Access* (user + password) → *Network Access* (allow your IP) → *Connect → Drivers* → copy the URI and append a database name, e.g. `.../ledgerbridge?retryWrites=true&w=majority`.
- Never commit `.env` (it is already in `.gitignore`). Never paste the secret into chat or the client app.

### Pre-flight check: prove the credentials work (before running the app)
```bash
# 1) get a token (app-only)
curl -s -X POST "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=$AZURE_CLIENT_ID" -d "client_secret=$AZURE_CLIENT_SECRET" \
  -d "scope=https://graph.microsoft.com/.default" -d "grant_type=client_credentials"
# copy access_token → TOKEN

# 2) can the app see the Ledgers folder?
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/sites/$SP_SITE_ID/drives/$SP_DRIVE_ID/root:/Ledgers"
```
Expect JSON describing the folder. (`404` here means a wrong drive id or the folder doesn't exist yet; `403` means Part 3b wasn't done or used `read`.)

---

## Part 5: Test plan (do these in order and note the result)

**A. Mock mode first (no Azure needed)**: `GRAPH_MODE=mock`, run server + client.
1. Submit a sale → badge goes *Queued → In ledger*.
2. `GET http://localhost:4000/api/dev/mock-ledger` lists the fake file; add `?file=<path>` to download and open it in Excel.
3. Submit the same form twice quickly → only one row (idempotent).
4. Enter bad data (`=1+1` as SKU, 3 decimals, units `1.5`) → rejected with messages.

**B. Live mode**: `GRAPH_MODE=live`
5. Submit a sale → within ~5 s a file `Ledgers/Sales_Ledger_<YYYY-MM>.xlsx` appears in SharePoint. Open it: styled header, frozen row, your row, timestamp in UTC.
6. Submit 5–10 sales rapidly → all appear exactly once, in order.
7. **Auto-init:** delete the ledger file from SharePoint, submit → a fresh styled file is created (the old rows are in *Recycle bin / Version history*, so restore if needed).
8. **Outage:** break the secret in `.env` (or disconnect Wi-Fi), submit → UI still says "accepted", badge stays *Queued*, server logs `sync.group_failed`. Restore → badge flips to *In ledger* without resubmitting.
9. **Open file during sync:** keep the ledger open in Excel (web or desktop) and submit → it should still sync (a brief lock is retried automatically).
10. Restart the server while a record is *Queued* → it still syncs after restart.

**What to send back as feedback:** which test numbers passed/failed, the exact server log lines (JSON lines containing `"level":"error"` or `sync.*`), the UI state/screenshots, and any Graph error code (e.g. `accessDenied`, `itemNotFound`).

---

## Operating rules (what people may and may not do to the ledger)

| Do | Don't |
|---|---|
| Read, filter, copy, chart from it; use another workbook that links to it | Rename the **`Ledger`** sheet: the worker refuses to write and marks records `failed` |
| Keep it open in Excel while the app writes | Delete/unhide-and-edit the hidden **Record ID** column: it prevents duplicates on retries |
| Restore an old version from *Version history* if needed | Sort or insert rows by hand in the live file (copy the data out instead) |

If you rename the sheet or break the file, the app **will not overwrite it**: records stay safe in MongoDB with status `failed` and the reason. After fixing the file, re-queue with `POST /api/sales/<recordId>/retry` (header `x-api-key: <ADMIN_API_KEY>`).

---

## Troubleshooting

| Symptom (server log / Graph) | Likely cause | Fix |
|---|---|---|
| `AADSTS7000215` / 401 invalid client secret | Used the Secret **ID** instead of **Value**, or it expired | Create a new secret; update `.env` |
| `AADSTS700016` application not found | Wrong tenant/client ID | Re-copy from the app Overview page |
| 403 `accessDenied` | Admin consent missing, Part 3b not done, or role was `read` | Redo 3b with `write` |
| 404 `itemNotFound` on first run | Normal: the file doesn't exist yet and will be created | None |
| 404 on every call | Wrong `SP_DRIVE_ID` / `SP_SITE_ID` | Re-run 3a and 3c |
| 429 / 503 `throttled` | Graph rate limit | Automatic backoff using `Retry-After`; nothing to do |
| 412 `preconditionFailed` in logs | Someone else changed the file mid-write | Automatic: it re-reads and retries |
| 423 locked | File checked out / locked | Automatic retry; check the file isn't *checked out* |
| Records stuck `failed` | Permanent error (see `lastError`) | Fix cause, then use the retry endpoint |

## Going to production later
- Replace the client secret with a **certificate** (Entra → Certificates & secrets → Certificates).
- Run the server on an always-on host (free tiers that sleep delay syncs; nothing is lost).
- Add user sign-in (planned) and set `ADMIN_API_KEY` (≥16 chars).
