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
npm install googleapis
```

### 2. Get Google API credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. **APIs & Services → Enable APIs → search for "Google Sheets API" → Enable**
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
5. Download the JSON file and save it as **`credentials.json`** next to the script

`credentials.json` identifies this local application to Google. It contains the
OAuth client ID and client secret, but **does not grant the script access to any
spreadsheet by itself**. Keep it private and out of Git; it is already intended
to be listed in `.gitignore`.

### 3. Create a Google Sheet

Create a blank spreadsheet and copy the ID from the URL:

```
https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
```

### 4. Configure

Edit **`mtg-config.json`** (see [Configuration](#configuration) below) and paste your spreadsheet ID.

### 5. Authorise Google Sheets access

```bash
node mtg-to-sheets.js
```

The first run performs the OAuth authorization flow:

1. The script reads `credentials.json` and prints a Google authorization URL.
2. Open that URL in a browser, sign in to the Google account that owns or can
   edit the target spreadsheet, and approve the requested **Google Sheets**
   permission.
3. Google displays an authorization code. Copy that code into the terminal when
   the script prompts for it.
4. The script exchanges the one-time code for OAuth tokens and writes them to
   **`token.json`** next to the script.

`token.json` is the file that authorizes future non-interactive runs. It can
contain a refresh token, so treat it like a password: never commit, upload, or
share it. Later runs refresh the short-lived access token automatically without
asking you to approve access again.

If access is revoked, the refresh token expires, or the script reports
`invalid_grant`, delete `token.json` and run the script again to repeat this
flow. See [OAuth token expired or revoked (`invalid_grant`)](#oauth-token-expired-or-revoked-invalid_grant)
for the Google Cloud production-setting note.

---

## What the script does

For each configured set it:

1. Fetches all paginated pages from the Scryfall `/cards/search` API
2. Sorts cards by collector number
3. Applies any configured collector number filter (`collectorRange` or `collectorList`)
4. Preserves existing Collected and Foiled checkboxes (matched by set code + collector number)
5. Writes a tab to the spreadsheet with:
   - **Column A** — Collected checkbox (tick when you own it)
   - **Column B** — Foiled checkbox (tick when your copy is foil)
   - **Column C** — card image (`=IMAGE(...)` formula)
   - **Columns D+** — all Scryfall CSV columns (name, rarity, prices, etc.)

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
  "spreadsheetId": "186xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "credentialsPath": "credentials.json",
  "imageCol": null,
  "sets": [
    { "code": "hob", "tab": "HOB" },
    { "code": "thob", "tab": "THOB" },
    { "code": "hoc", "tab": "HOC" },
    { "code": "pw26", "tab": "PW26", "collectorRange": [14, 16] }
  ],
  "sceneImageGallery": {
    "sourceTab": "HOB Scene Cards",
    "tab": "HOB Scenes",
    "columns": 3
  },
  "wizardsArtCards": [
    {
      "url": "https://magic.wizards.com/en/products/the-hobbit/card-image-gallery?cigquery=Art%20Card",
      "tab": "HOB Art Cards",
      "code": "HOB-ART",
      "kind": "art",
      "cardmarket": {
        "expansionId": 6664,
        "priceField": "trend",
        "productIds": {
          "27/54": 901174,
          "45/54": 901221
        }
      }
    },
    {
      "url": "https://magic.wizards.com/en/products/the-hobbit/card-image-gallery?cigquery=Art%20Card",
      "tab": "HOB Scene Cards",
      "code": "HOB-SCENE",
      "kind": "scene",
      "cardmarket": {
        "expansionId": 6664,
        "priceField": "trend"
      }
    }
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
| `imageCol` | auto-detect | Scryfall data column containing the card image URL |
| `wizardsArtCards` | `[]` | Optional official Wizards gallery imports (see below) |

### Set entries

| Field | Required | Description |
|---|---|---|
| `code` | ✓ | Scryfall set code (lowercase), e.g. `"msh"` |
| `tab` | ✓ | Tab name in the spreadsheet, e.g. `"MSH"` |
| `collectorRange` | — | `[min, max]` — only include cards with collector numbers in this numeric range |
| `collectorList` | — | `["id1", "id2", …]` — explicit list of collector IDs (supports non-numeric IDs) |

Both filters are optional. If both are set on the same entry, `collectorRange` is applied first, then `collectorList`.

**Example — Special Guests, only cards 103–110 (numeric range):**
```json
{ "code": "spg", "tab": "SPG", "collectorRange": [103, 110] }
```

**Example — MagicFest promos with non-numeric IDs:**
```json
{ "code": "pmei", "tab": "PMEI", "collectorList": ["2026-4", "2026-6", "2026-13", "2026-14", "2026-15", "2026-16"] }
```

You can find the set code and collector number for any card in its Scryfall URL:
```
https://scryfall.com/card/pmei/2026-16/captain-america-living-legend
                               ^^^^  ^^^^^^
                               code  collector number
```

### Wizards Art Card entries

`wizardsArtCards` imports the standalone Art Cards that Scryfall and MTGJSON do
not model as game-card printings. The importer reads the official Wizards Card
Image Gallery and its public image data; no API key is required.

| Field | Required | Description |
|---|---|---|
| `url` | ✓ | Official Wizards Card Image Gallery URL |
| `tab` | ✓ | Target sheet-tab name |
| `code` | — | Stable source code used to preserve checkboxes; default: `WIZARDS-ART` |
| `kind` | — | `art` for regular Art Cards only, or `scene` for Scene Art Cards only |
| `includeSceneCards` | — | Legacy combined-tab option; includes both types when `kind` is omitted |

To split The Hobbit cards into independent tabs, create **two entries** using
the same Gallery URL. Use distinct codes: both groups have card numbers such
as `1/54` and `1/12`, and distinct codes guarantee independent checkbox keys.

```json
"wizardsArtCards": [
  {
    "url": "https://magic.wizards.com/en/products/the-hobbit/card-image-gallery?cigquery=Art%20Card",
    "tab": "HOB Art Cards",
    "code": "HOB-ART",
    "kind": "art",
    "cardmarket": { "expansionId": 6664, "priceField": "trend" }
  },
  {
    "url": "https://magic.wizards.com/en/products/the-hobbit/card-image-gallery?cigquery=Art%20Card",
    "tab": "HOB Scene Cards",
    "code": "HOB-SCENE",
    "kind": "scene",
    "cardmarket": { "expansionId": 6664, "priceField": "trend" }
  }
]
```

This produces 54 regular Art Cards and 12 Scene Art Cards. The legacy
`includeSceneCards: true` configuration remains supported for a combined
66-card tab.

#### Optional Scene image gallery

`sceneImageGallery` creates an image-only gallery tab from a tab imported in
the same run. The gallery contains formulas pointing at the canonical image URL
column, so it refreshes with the source import and does not duplicate URLs.

```json
"sceneImageGallery": {
  "sourceTab": "HOB Scene Cards",
  "tab": "HOB Scenes",
  "columns": 3
}
```

The default is three images per row. It uses 250-pixel columns and 350-pixel
rows, hides gridlines, and does not participate in checkbox tracking or the
Dashboard. `columnWidth` and `rowHeight` are optional pixel-size overrides.

#### Optional Cardmarket EUR prices

Add a `cardmarket` object to a Wizards entry to fill `eur_price` from Cardmarket's public EUR price guide. This is the Cardmarket-wide EUR guide, not a Germany-only price: the downloadable guide has no country filter. No Cardmarket account or API credentials are required.

```json
"cardmarket": {
  "expansionId": 6664,
  "priceField": "trend",
  "productIds": {
    "27/54": 901174,
    "45/54": 901221
  }
}
```

| Field | Required | Description |
|---|---|---|
| `expansionId` | ✓ | Cardmarket expansion ID; The Hobbit: Extras is `6664` |
| `priceField` | — | One of `trend` (default), `avg`, `low`, `avg1`, `avg7`, or `avg30` |
| `productIds` | — | Map of collector number to an explicit Cardmarket product ID for naming/variant exceptions |
| `productCatalogueUrl` | — | Override the default public Magic Singles catalogue endpoint |
| `priceGuideUrl` | — | Override the default public Magic price-guide endpoint |

The default matching chooses the lowest product ID among matching Art Series variants (the base variant). Use `productIds` where Cardmarket uses a different title or where you prefer a specific variant. A missing `trend` is left blank rather than replaced with a low asking price.

The row uses `1/54` or `1/12` as its collector number, so re-runs preserve
checkboxes independently from normal HOB card printings. Wizards rows use the
same Scryfall-derived header order as every normal set tab; source-specific
fields that Wizards does not publish are left blank. That makes a future
Scryfall Art Card import a drop-in source replacement without changing the
sheet layout.

### Complete Hobbit configuration

The following is a complete `hob.json` example for the regular Hobbit-related
set tabs, separated official Art and Scene Card tabs, Cardmarket EUR `trend`
prices, and a three-image-wide Scene gallery. Replace the spreadsheet ID with
your own; `credentials.json` and `token.json` stay local and should not be
committed.

```json
{
  "spreadsheetId": "YOUR_SPREADSHEET_ID",
  "credentialsPath": "credentials.json",
  "imageCol": null,
  "sets": [
    { "code": "hob", "tab": "HOB" },
    { "code": "thob", "tab": "THOB" },
    { "code": "hoc", "tab": "HOC" },
    { "code": "pw26", "tab": "PW26", "collectorRange": [14, 16] }
  ],
  "wizardsArtCards": [
    {
      "url": "https://magic.wizards.com/en/products/the-hobbit/card-image-gallery?cigquery=Art%20Card",
      "tab": "HOB Art Cards",
      "code": "HOB-ART",
      "kind": "art",
      "cardmarket": {
        "expansionId": 6664,
        "priceField": "trend",
        "productIds": {
          "27/54": 901174,
          "45/54": 901221
        }
      }
    },
    {
      "url": "https://magic.wizards.com/en/products/the-hobbit/card-image-gallery?cigquery=Art%20Card",
      "tab": "HOB Scene Cards",
      "code": "HOB-SCENE",
      "kind": "scene",
      "cardmarket": {
        "expansionId": 6664,
        "priceField": "trend"
      }
    }
  ],
  "sceneImageGallery": {
    "sourceTab": "HOB Scene Cards",
    "tab": "HOB Scenes",
    "columns": 3
  }
}
```

Run it with:

```powershell
node .\mtg-to-sheets.js --config hob.json
```

Expected output includes `54` regular Art Cards, `12` Scene Art Cards, then:

```text
[HOB Scenes] Building image gallery from "HOB Scene Cards"…
  ✓ 12 images → gallery "HOB Scenes" (3 per row)
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
--image-col <name>         Scryfall data column for the image URL
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
- Keep all Collected and Foiled checkboxes you've ticked, matched by **set code + collector number**
- Keep any user-edited `lang` values, even when `preserveChecks` is disabled
- Reset any card not matched (e.g. newly added promos will start unchecked)

Sheets created by an older version are migrated automatically: existing Collected
checks stay intact, and the new Foiled checkboxes start unchecked.

To reset all checkboxes (e.g. starting a new collection), set `preserveChecks: false` in the config or run with `--preserve-checks` omitted and the config option set to false.

### OAuth token expired or revoked (`invalid_grant`)

The script validates its cached Google token before changing any sheet. If Google rejects it, the script removes `token.json` and opens a browser authorization flow automatically; complete that flow and paste either the authorization code or the full localhost callback URL. The script extracts the code from the URL and saves the replacement token.

If this happens about every seven days, open your Google Cloud project’s **Google Auth platform → Audience** page and publish the OAuth app to **Production**. External apps in **Testing** receive refresh tokens that expire after seven days. This script requests only the Google Sheets scope, so a personal-use app normally does not need Google verification.

---

## Sheet layout

### Set tabs (e.g. MSH, TMSH, …)

| Col | Content |
|---|---|
| A | Collected checkbox — tick when you own the card |
| B | Foiled checkbox — tick when your copy is foil |
| C | Card image (`=IMAGE(url)`) |
| D+ | Scryfall card data: name, set, collector_number, rarity, prices (usd, eur, tix), artist, etc. |

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

---

## License and third-party material

The code and original documentation in this repository are licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify, and
redistribute them for noncommercial purposes, including personal collection
tracking and hobby projects. Commercial use—including operating this software
as a paid or otherwise commercial hosted service—requires separate written
permission from the copyright holder. This is source-available software, not
an OSI-approved open-source license.

See [NOTICE](NOTICE) for the required copyright notice and third-party material
notice.

`mtgfetcher` is unofficial Fan Content permitted under the [Wizards of the
Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy).
It is not approved or endorsed by Wizards of the Coast. Magic: The Gathering
and related names, marks, card data, artwork, and other intellectual property
remain the property of their respective rights holders.

The script can retrieve publicly available data and image URLs from Scryfall,
Wizards of the Coast, and Cardmarket at runtime. It does not grant any rights
to that third-party material; use remains subject to the relevant providers'
terms and policies.
