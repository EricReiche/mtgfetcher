# MTG Collection Tracker

Downloads Magic: The Gathering card data from [Scryfall](https://scryfall.com) and writes it to a Google Sheet — one tab per set, with checkboxes to mark cards you own, card images, and a dashboard showing what you're still missing.


![alt text](https://raw.githubusercontent.com/EricReiche/mtgfetcher/refs/heads/main/example-dashboard.jpg "Google Sheets dashboard example")

![alt text](https://raw.githubusercontent.com/EricReiche/mtgfetcher/refs/heads/main/example-subset.jpg "Subset example")

---

## Requirements

- [Node.js](https://nodejs.org) 18 or later
- A Google account
- A Google Sheet (blank is fine)

---

## First-time setup

### 1. Install dependencies

```bash
npm install googleapis csv-parse
```

### 2. Get Google API credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. **APIs & Services → Enable APIs → search for "Google Sheets API" → Enable**
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
5. Download the JSON file and save it as **`credentials.json`** next to the script

### 3. Create a Google Sheet

Create a blank spreadsheet and copy the ID from the URL:

```
https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
```

### 4. Configure

Edit **`mtg-config.json`** (see [Configuration](#configuration) below) and paste your spreadsheet ID.

### 5. Run

```bash
node mtg-to-sheets.js
```

On the first run the script will print a Google auth URL. Open it in your browser, approve access, and paste the code back into the terminal. The token is cached in `token.json` for all future runs.

---

## What the script does

For each configured set it:

1. Fetches all paginated pages from the Scryfall `/cards/search` API
2. Sorts cards by collector number
3. Applies any configured collector number range filter
4. Preserves existing checkboxes (matched by set code + collector number)
5. Writes a tab to the spreadsheet with:
   - **Column A** — checkbox (tick when you own it)
   - **Column B** — card image (`=IMAGE(...)` formula)
   - **Columns C+** — all Scryfall CSV columns (name, rarity, prices, etc.)

After all set tabs are written, it creates/updates a **Dashboard** tab (always the first tab) showing:
- Overall "Verbleibend" (remaining) count
- Per-set missing/total counts
- Side-by-side lists of unchecked cards per set (name + collector number)

---

## Configuration

### `mtg-config.json`

Place this file next to the script. All fields are optional except `spreadsheetId`.

```json
{
  "spreadsheetId": "1BxiMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "credentialsPath": "credentials.json",
  "formulaSep": ";",
  "sets": [
    { "code": "msh",  "tab": "MSH"  },
    { "code": "tmsh", "tab": "TMSH" },
    { "code": "amsh", "tab": "AMSH" },
    { "code": "msc",  "tab": "MSC"  },
    { "code": "tmsc", "tab": "TMSC" },
    { "code": "fmsc", "tab": "FMSC" },
    { "code": "spg",  "tab": "SPG", "collectorRange": [103, 110] }
  ]
}
```

### Config fields

| Field | Default | Description |
|---|---|---|
| `spreadsheetId` | *(required)* | ID from the Google Sheets URL |
| `credentialsPath` | `credentials.json` | Path to your OAuth client secret file |
| `sets` | Marvel Super Heroes sets | Array of set entries (see below) |
| `preserveChecks` | `true` | Keep existing checkboxes when re-running |
| `formulaSep` | `;` | Formula argument separator — `;` for German/EU locale, `,` for US |
| `imageCol` | auto-detect | Scryfall CSV column name containing the card image URL |

### Set entries

| Field | Required | Description |
|---|---|---|
| `code` | ✓ | Scryfall set code (lowercase), e.g. `"msh"` |
| `tab` | ✓ | Tab name in the spreadsheet, e.g. `"MSH"` |
| `collectorRange` | — | `[min, max]` — only include cards with collector numbers in this range |

**Example — Special Guests, only cards 103–110:**
```json
{ "code": "spg", "tab": "SPG", "collectorRange": [103, 110] }
```

---

## CLI flags

All config values can be overridden on the command line. CLI flags take priority over `mtg-config.json`.

```
--spreadsheet-id <id>      Google Sheets document ID
--sets <codes>             Comma-separated set codes
                           e.g.  msh,tmsh,msc
                                 msh:MSH,tmsh:Tokens
--config <path>            Use a different config file (default: mtg-config.json)
--credentials <path>       OAuth credentials file (default: credentials.json)
--image-col <name>         Scryfall CSV column for the image URL
--preserve-checks          Keep existing checkboxes on re-run
--formula-sep <char>       Formula argument separator (default: ;)
-h, --help                 Show help
```

**Examples:**

```bash
# Use a different spreadsheet for a different set group
node mtg-to-sheets.js --config strixhaven.json

# Quick one-off run without a config file
node mtg-to-sheets.js --spreadsheet-id 1BxiM... --sets msh,tmsh,msc

# US locale account
node mtg-to-sheets.js --formula-sep ,
```

---

## Re-running / updating

Just run the script again. By default (`preserveChecks: true`) it will:
- Re-download fresh card data from Scryfall
- Keep all checkboxes you've ticked, matched by **set code + collector number**
- Reset any card not matched (e.g. newly added promos will start unchecked)

To reset all checkboxes (e.g. starting a new collection), set `preserveChecks: false` in the config or run with `--preserve-checks` omitted and the config option set to false.

---

## Sheet layout

### Set tabs (e.g. MSH, TMSH, …)

| Col | Content |
|---|---|
| A | Checkbox — tick when you own the card |
| B | Card image (`=IMAGE(url)`) |
| C+ | All Scryfall CSV columns: name, set, collector_number, rarity, prices (usd, eur, tix), artist, etc. |

- Rows are sorted by collector number
- Price columns are formatted as numbers (locale-safe)
- Header row is frozen and bold
- Row height: 300 px · Image column: 215 px

### Dashboard tab

Always the first tab. Rebuilt on every run.

- **Row 1** — Title + overall "Verbleibend: X/Y" remaining count
- **Row 3** — Per-set header: `MSH: 12/453`, `TMSH: 3/27`, …
- **Row 4+** — Side-by-side lists of unchecked cards (name + collector number), one pair of columns per set

---

## Rate limits

The Scryfall `/cards/search` endpoint is limited to **2 requests per second**. The script waits 550 ms between pages. If a `429 Too Many Requests` response is received, it backs off for 30 seconds and retries up to 3 times before skipping the set.

---

## Files

| File | Purpose |
|---|---|
| `mtg-to-sheets.js` | Main script |
| `mtg-config.json` | Your configuration |
| `credentials.json` | Google OAuth client secret (download from Google Cloud Console) |
| `token.json` | Cached auth token (auto-created on first run) |
