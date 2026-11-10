# LedgerBridge: Free Setup with Google Sheets (KES 0, no Microsoft account)

Use this when you can't get a Microsoft 365 tenant or Entra access. The server appends each sale to a **Google Sheet** using a free **service account** (a robot identity with its own key). One tab per month (`Sales_Ledger_2026-11`), styled header, hidden *Record ID* column for duplicate protection. You can download it as an Excel file any time (**File → Download → Microsoft Excel (.xlsx)**).

Time: ~15 min. You need only your Google (gmail) account.

| Piece | Cost |
|---|---|
| Google Sheets + Drive (personal account) | free |
| Google Cloud project + Sheets API + service account | free (no billing account needed) |
| MongoDB Atlas M0 / local MongoDB | free |

---

## Step 1: Create the sheet
1. Open https://sheets.new and name it `LedgerBridge Ledger`.
2. Copy the **spreadsheet ID** from the address bar: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` → `GOOGLE_SHEET_ID`.

## Step 2: Google Cloud project + API
1. Go to https://console.cloud.google.com (sign in with the same Google account; accept the terms).
2. Top bar → project picker → **New project** → name `ledgerbridge` → **Create** → make sure it is selected.
3. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.

## Step 3: Service account and key
1. **IAM & Admin → Service Accounts → Create service account** → name `ledgerbridge-sync` → **Create and continue** → skip the optional role steps → **Done**.
2. Open the new service account → **Keys → Add key → Create new key → JSON → Create**. A `.json` file downloads. **Treat it like a password.**
3. Copy the service account's email (`ledgerbridge-sync@<project>.iam.gserviceaccount.com`; it is also the `client_email` field in the JSON).

## Step 4: Share the sheet with the service account
In the Google Sheet: **Share** → paste the service-account email → role **Editor** → untick *Notify people* → **Share**.
(Without this you get `404 / Spreadsheet not found`.)

## Step 5: Configure `server/.env`
Encode the key file as one line:
- **PowerShell:** `[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\key.json"))`
- **Mac/Linux:** `base64 -w0 key.json`

```env
GRAPH_MODE=sheets
GOOGLE_SHEET_ID=<spreadsheet id from step 1>
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<the long base64 line>
LEDGER_CURRENCY=KES
LEDGER_ROLLOVER=monthly
MONGODB_URI=<your MongoDB URI>
```
Afterwards, **delete the downloaded JSON file** (or store it somewhere private). Never commit `.env`.

## Step 6: Run and test
```bash
npm run dev:server    # and in another terminal: npm run dev:client
```
Submit a sale: within ~5 s a tab named `Sales_Ledger_<YYYY-MM>` appears in the sheet with your row. The server log shows `sheets.tab_created`.

Then follow **Part 5 (Test plan)** in `docs/SHAREPOINT_SETUP.md`. Tests 1–8 and 10 apply unchanged. Test 7 ("auto-init") means *delete the month's tab* and submit; test 9 (file open in Excel) doesn't apply, because Google Sheets handles simultaneous editing.

## Step 7: Share with your team
**Share** the sheet with teammates as **Viewer**. To get an Excel copy: **File → Download → Microsoft Excel (.xlsx)**.

---

## Operating rules
| Do | Don't |
|---|---|
| Read, filter, chart, copy to other sheets (`IMPORTRANGE`) | Delete or edit the hidden **Record ID** column (F). It prevents duplicates on retries |
| Download as .xlsx for reports | Rename a month's tab (the app would create a new one and old rows stay behind) |
| Add your own tabs (pivots, summaries) | Hand-edit rows in the live tab (copy data out instead) |

## Limits & notes
- Free Google Sheets API quotas are far above what this needs (the worker sends one batch per few seconds).
- A single spreadsheet holds up to 10 million cells, and monthly tabs keep each tab small.
- Not tried against a real Google account yet, so report anything unexpected (error text + server log lines).

## Troubleshooting
| Message | Fix |
|---|---|
| `Spreadsheet not found. Check GOOGLE_SHEET_ID and share the sheet…` | Wrong ID, or step 4 not done |
| `Permission denied … enable the Google Sheets API` | Enable it (step 2.3) in the **same project** the key belongs to; make sure the service account is an **Editor** on the sheet |
| `Google auth failed: invalid_grant` | Key deleted/disabled or clock wrong; create a new key (step 3.2) and re-encode |
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64-encoded JSON` | Encode the whole `.json` file as a single line without spaces/newlines |
| Records stuck `failed` | Fix the cause, then `POST /api/sales/retry-failed` with `x-api-key: <ADMIN_API_KEY>` |
