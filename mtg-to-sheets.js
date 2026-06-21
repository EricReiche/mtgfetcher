#!/usr/bin/env node
/**
 * mtg-to-sheets.js
 * Downloads Scryfall card CSVs (with pagination) and writes them to Google Sheets.
 * One tab per set code. Adds a checkbox column and an image formula column.
 *
 * ── SETUP ──────────────────────────────────────────────────────────────────
 *   npm install googleapis csv-parse
 *
 *   Google Cloud Console  →  https://console.cloud.google.com
 *   a. Create a project → APIs & Services → Enable "Google Sheets API"
 *   b. Credentials → Create OAuth client ID → Desktop app → Download JSON
 *   c. Save the downloaded file as  credentials.json  next to this script
 *
 * ── CONFIG ─────────────────────────────────────────────────────────────────
 *   Three ways to configure (highest priority first):
 *
 *   1. CLI flags:
 *        --spreadsheet-id  <id>
 *        --sets            msh,tmsh,msc          (codes only, tab = uppercased code)
 *        --sets            msh:MSH,tmsh:Tokens   (code:TabName pairs)
 *        --config          path/to/config.json   (load a different config file)
 *        --credentials     path/to/creds.json
 *        --image-col       image_uris            (override auto-detected image column)
 *        --preserve-checks                       keep existing checkboxes (matched by set+collector_number)
 *
 *   2. Config file  (mtg-config.json by default, override with --config):
 *        {
 *          "spreadsheetId": "1BxiM...",
 *          "sets": [
 *            { "code": "msh",  "tab": "MSH"  },
 *            { "code": "tmsh", "tab": "TMSH" }
 *          ],
 *          "credentialsPath": "credentials.json",
 *          "imageCol": null
 *        }
 *
 *   3. Hardcoded defaults inside this file (see DEFAULTS below).
 *
 * ── RUN ────────────────────────────────────────────────────────────────────
 *   node mtg-to-sheets.js
 *   node mtg-to-sheets.js --spreadsheet-id 1BxiM... --sets msh,tmsh,msc
 *   node mtg-to-sheets.js --config my-sets.json
 * ───────────────────────────────────────────────────────────────────────────
 */

const { google } = require('googleapis');
const { parse }  = require('csv-parse/sync');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const readline   = require('readline');

// ── DEFAULTS (lowest priority — overridden by config file and CLI) ──────────

const DEFAULTS = {
  spreadsheetId:   null,               // required — set here or via config/CLI
  credentialsPath: 'credentials.json',
  tokenPath:       'token.json',
  configFile:      'mtg-config.json',
  imageCol:        null,               // null = auto-detect
  preserveChecks:  true,              // keep checkboxes on re-run by default
  formulaSep:      ';',               // formula argument separator — ';' for German/EU, ',' for US locale
  sets: [
    { code: 'msh',  tab: 'MSH'  },
    { code: 'tmsh', tab: 'TMSH' },
    { code: 'amsh', tab: 'AMSH' },
    { code: 'msc',  tab: 'MSC'  },
    { code: 'tmsc', tab: 'TMSC' },
    { code: 'fmsc', tab: 'FMSC' },
  ],
};

// ── CLI PARSING ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--spreadsheet-id':  result.spreadsheetId   = next; i++; break;
      case '--config':          result.configFile       = next; i++; break;
      case '--credentials':     result.credentialsPath  = next; i++; break;
      case '--image-col':       result.imageCol         = next; i++; break;
      case '--preserve-checks': result.preserveChecks   = true;  break;
      case '--formula-sep':     result.formulaSep        = next; i++; break;
      case '--sets':
        // accepts:  "msh,tmsh,msc"  or  "msh:MSH,tmsh:Tokens"
        result.sets = next.split(',').map(entry => {
          const [code, tab] = entry.split(':');
          return { code: code.trim().toLowerCase(), tab: (tab ?? code).trim().toUpperCase() };
        });
        i++;
        break;
      case '--help': case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return result;
}

function printHelp() {
  console.log(`
Usage: node mtg-to-sheets.js [options]

Options:
  --spreadsheet-id <id>      Google Sheets document ID (from URL)
  --sets <codes>             Comma-separated set codes, optionally with tab names
                             e.g.  msh,tmsh,msc
                                   msh:MSH,tmsh:Tokens,msc:Commander
  --config <path>            Path to JSON config file  (default: mtg-config.json)
  --credentials <path>       Path to OAuth credentials file  (default: credentials.json)
  --image-col <name>         Scryfall CSV column for the image URL  (default: auto-detect)
  --preserve-checks          Preserve existing checkboxes, matched by set + collector_number
  -h, --help                 Show this help

Config file format (mtg-config.json):
  {
    "spreadsheetId": "1BxiM...",
    "credentialsPath": "credentials.json",
    "imageCol": null,
    "sets": [
      { "code": "msh",  "tab": "MSH"  },
      { "code": "tmsh", "tab": "TMSH" }
    ]
  }
`);
}

// ── CONFIG RESOLUTION ────────────────────────────────────────────────────────
// Priority: CLI > config file > DEFAULTS

function loadConfig() {
  const cli = parseArgs(process.argv.slice(2));

  // Determine which config file to load
  const configFile = cli.configFile ?? DEFAULTS.configFile;
  let fileConf = {};
  if (fs.existsSync(configFile)) {
    try {
      fileConf = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      console.log(`Loaded config from ${configFile}`);
    } catch (e) {
      console.warn(`Warning: could not parse ${configFile}: ${e.message}`);
    }
  }

  // Merge: CLI wins over file, file wins over defaults
  const cfg = {
    spreadsheetId:   cli.spreadsheetId   ?? fileConf.spreadsheetId   ?? DEFAULTS.spreadsheetId,
    credentialsPath: cli.credentialsPath  ?? fileConf.credentialsPath ?? DEFAULTS.credentialsPath,
    tokenPath:       fileConf.tokenPath   ?? DEFAULTS.tokenPath,
    imageCol:        cli.imageCol         ?? fileConf.imageCol         ?? DEFAULTS.imageCol,
    sets:            cli.sets             ?? fileConf.sets             ?? DEFAULTS.sets,
    preserveChecks:  cli.preserveChecks   ?? fileConf.preserveChecks   ?? DEFAULTS.preserveChecks,
    formulaSep:      cli.formulaSep       ?? fileConf.formulaSep       ?? DEFAULTS.formulaSep,
  };

  if (!cfg.spreadsheetId) {
    console.error(
      'Error: no spreadsheetId configured.\n' +
      'Pass --spreadsheet-id <id>, add it to mtg-config.json, or set DEFAULTS.spreadsheetId in the script.'
    );
    process.exit(1);
  }

  return cfg;
}

// ── AUTH ─────────────────────────────────────────────────────────────────────

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

async function authorize(credentialsPath, tokenPath) {
  if (!fs.existsSync(credentialsPath)) {
    console.error(`OAuth credentials file not found: ${credentialsPath}`);
    console.error('Download it from Google Cloud Console → Credentials → your OAuth client.');
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const { client_secret, client_id, redirect_uris } = creds.installed ?? creds.web;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(tokenPath)) {
    oAuth2.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
    return oAuth2;
  }

  const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\nOpen this URL in your browser to authorise the app:\n');
  console.log(authUrl + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(res => rl.question('Paste the auth code here: ', res));
  rl.close();

  const { tokens } = await oAuth2.getToken(code.trim());
  oAuth2.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token cached in ${tokenPath}\n`);
  return oAuth2;
}

// ── SCRYFALL FETCH ────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    // Parse URL explicitly so headers are always sent (https.get(string, opts)
    // doesn't reliably merge headers in all Node versions).
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers: {
        'User-Agent': 'mtg-sheet-importer/1.0',
        'Accept':     'text/csv,application/json',
      },
    };
    https.get(opts, res => {
      const meta = {
        hasMore:  res.headers['x-scryfall-has-more'] === 'true',
        nextPage: res.headers['x-scryfall-next-page'] ?? null,
        status:   res.statusCode,
      };
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), ...meta }));
    }).on('error', reject);
  });
}

// /cards/search is rate-limited to 2 req/sec → wait at least 500ms between pages.
// On a 429 we back off for 30s then retry (up to MAX_RETRIES times).
const PAGE_DELAY_MS  = 550;  // slightly over 500ms to be safe
const RETRY_DELAY_MS = 30_000;
const MAX_RETRIES    = 3;

async function fetchSet(code) {
  let url = `https://api.scryfall.com/cards/search?q=set:${code}&unique=prints&include_extras=true&format=csv&page=1`;
  let headers = null;
  let allRows = [];
  let page = 1;

  while (url) {
    process.stdout.write(`  page ${page}...`);

    let result;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      result = await httpGet(url);

      if (result.status === 429) {
        console.log(` rate-limited — waiting ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})…`);
        await sleep(RETRY_DELAY_MS);
        process.stdout.write(`  page ${page} (retry ${attempt})...`);
        continue;
      }
      break; // success or non-429 error
    }

    const { body, hasMore, nextPage, status } = result;

    if (status === 429) {
      console.log(' still rate-limited after retries — aborting set');
      return { headers: [], rows: [] };
    }

    if (status !== 200 || body.trimStart().startsWith('{')) {
      const detail = body.trimStart().startsWith('{')
        ? JSON.parse(body).details
        : `HTTP ${status}`;
      console.log(` no data (${detail})`);
      return { headers: [], rows: [] };
    }

    const records = parse(body, { columns: true, skip_empty_lines: true });
    if (records.length === 0) { console.log(' empty'); break; }

    if (!headers) headers = Object.keys(records[0]);
    allRows.push(...records);

    console.log(` ${records.length} cards`);
    url = hasMore ? nextPage : null;
    page++;
    if (url) await sleep(PAGE_DELAY_MS);
  }

  return { headers: headers ?? [], rows: allRows };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SHEETS HELPERS ────────────────────────────────────────────────────────────

function colLetter(idx) {
  let s = '';
  for (let n = idx + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(64 + ((n - 1) % 26 + 1)) + s;
  return s;
}

function findImageColIdx(headers, imageColOverride) {
  if (imageColOverride) {
    const i = headers.indexOf(imageColOverride);
    if (i === -1) console.warn(`Warning: imageCol "${imageColOverride}" not found in headers — image column skipped`);
    return i;
  }
  for (const c of ['image_uris', 'image_uri', 'image_url']) {
    const i = headers.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}

// ── VALUE COERCION ────────────────────────────────────────────────────────────

// Convert US-format numeric strings to JS numbers before sending to Sheets API.
// This bypasses locale-dependent parsing (USER_ENTERED) so "46.14" is always
// stored as the number 46.14, not 46140 on a German-locale account.
const US_NUMBER_RE = /^-?\d{1,3}(?:\.\d+)?$/;   // matches "0.2", "46.143", "-1.5" etc.
                                                   // avoids e.g. "1,234.56" or "abc"
function coerceValue(v) {
  if (typeof v !== 'string' || v === '') return v;
  if (US_NUMBER_RE.test(v.trim())) {
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return v;
}

// ── CHECKBOX PRESERVATION ─────────────────────────────────────────────────────

/**
 * Read the existing sheet and return a Map of "set:collector_number" → true/false.
 * Columns are matched by header name, not position, so reordering is safe.
 */
async function readCheckboxMap(sheets, spreadsheetId, tabName) {
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
  } catch {
    return new Map(); // tab doesn't exist yet
  }

  const [headerRow, ...dataRows] = res.data.values ?? [];
  if (!headerRow) return new Map();

  const colIdx = name => headerRow.indexOf(name);
  const checkCol = 0;                          // col A = Collected
  const setCol   = colIdx('set');              // within the full row (A=0, B=1, C=2 = first CSV col)
  const numCol   = colIdx('collector_number');

  if (setCol === -1 || numCol === -1) {
    console.warn('  Warning: could not find "set" or "collector_number" columns — checkboxes not preserved');
    return new Map();
  }

  const map = new Map();
  for (const row of dataRows) {
    const checked = String(row[checkCol] ?? '').toUpperCase() === 'TRUE';
    const key = `${row[setCol]}:${row[numCol]}`;
    if (checked) map.set(key, true);
  }
  return map;
}

// ── WRITE ONE TAB ─────────────────────────────────────────────────────────────

async function writeTab(sheets, spreadsheetId, tabName, csvHeaders, rows, imageColOverride, preserveChecks) {
  // Snapshot existing checkboxes before we clear anything
  const checkMap = preserveChecks
    ? await readCheckboxMap(sheets, spreadsheetId, tabName)
    : new Map();
  if (preserveChecks) console.log(`  Preserved ${checkMap.size} checked card(s)`);

  // Get or create the sheet tab
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === tabName);

  let sheetId;
  if (existing) {
    sheetId = existing.properties.sheetId;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'` });
  } else {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  }

  // Sort by collector_number — numeric-aware so "10" sorts after "9", not "1"
  // Falls back to locale string compare for non-numeric suffixes like "1a", "★2"
  rows.sort((a, b) => {
    const na = parseInt(a.collector_number, 10);
    const nb = parseInt(b.collector_number, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a.collector_number).localeCompare(String(b.collector_number), undefined, { numeric: true });
  });

  // Column layout:  A=Collected  B=Image  C..=CSV columns
  const imgCsvIdx   = findImageColIdx(csvHeaders, imageColOverride);
  const imgSheetIdx = imgCsvIdx >= 0 ? 2 + imgCsvIdx : -1;
  const imgColLet   = imgSheetIdx >= 0 ? colLetter(imgSheetIdx) : null;

  const headerRow = ['Collected', 'Image', ...csvHeaders];

  // Strip image formula from data rows — we write it separately with USER_ENTERED
  // so formulas evaluate. Everything else goes RAW to bypass locale-dependent
  // number parsing (German "." = thousands sep would corrupt "46.14" → 46140).
  const dataRows = rows.map(row => {
    const key     = `${row['set']}:${row['collector_number']}`;
    const checked = checkMap.has(key); // JS boolean — RAW mode stores it as Sheets boolean
    return [checked, '', ...csvHeaders.map(h => coerceValue(row[h] ?? ''))];
  });

  // Pass 1: data + checkboxes as RAW (numbers stay numbers, no locale mangling)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow, ...dataRows] },
  });

  // Pass 2: image formulas in col B as USER_ENTERED so they are evaluated
  if (imgColLet) {
    const formulaValues = rows.map((_, i) => [`=IMAGE(${imgColLet}${i + 2})`]);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!B2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: formulaValues },
    });
  }

  // Formatting
  const numRows  = rows.length;
  const numCols  = headerRow.length;

  const priceColIndices = csvHeaders
    .map((h, i) => /price|usd|eur|tix/i.test(h) ? 2 + i : -1)
    .filter(i => i >= 0);

  const dataRange    = { sheetId, startRowIndex: 1, endRowIndex: numRows + 1 };
  const checkColRange = { ...dataRange, startColumnIndex: 0, endColumnIndex: 1 };

  const requests = [
    // Freeze header row
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Bold header
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    // Checkbox validation on col A
    {
      setDataValidation: {
        range: checkColRange,
        rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true },
      },
    },
    // Checkbox cell type on col A (renders the actual checkbox widget)
    {
      repeatCell: {
        range: checkColRange,
        cell: { userEnteredFormat: { hyperlinkDisplayType: 'PLAIN_TEXT' } },
        fields: 'userEnteredFormat',
      },
    },
    // Row height for data rows
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: numRows + 1 },
        properties: { pixelSize: 300 },
        fields: 'pixelSize',
      },
    },
    // Col A (Collected): narrow — just fits a checkbox
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 90 },
        fields: 'pixelSize',
      },
    },
    // Col B (Image): wide enough for a card image
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 215 },
        fields: 'pixelSize',
      },
    },
    // Auto-resize all other columns (C onwards)
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: numCols },
      },
    },
  ];

  for (const ci of priceColIndices) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: numRows + 1, startColumnIndex: ci, endColumnIndex: ci + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  const imgNote = imgColLet ? ` (image → col ${imgColLet})` : '';
  console.log(`  ✓ ${numRows} cards → tab "${tabName}"${imgNote}`);
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
//
// Layout (2 columns per set, side by side):
//   Row 1 │ "MTG Collection Dashboard"  ···  "Verbleibend: X/Y"
//   Row 2 │ (empty)
//   Row 3 │ MSH: 12/453  │     │ TMSH: 3/27  │     │ …
//   Row 4+ │ <card name>  │ <#> │ <card name> │ <#> │ …   ← QUERY results

async function createDashboard(sheets, spreadsheetId, sets, csvHeaders, sep) {
  console.log('\nBuilding Dashboard…');

  const nameIdx = csvHeaders.indexOf('name');
  const numIdx  = csvHeaders.indexOf('collector_number');
  if (nameIdx === -1 || numIdx === -1) {
    console.warn('  Skipping dashboard — "name"/"collector_number" columns not found');
    return;
  }

  // Column letters as they appear in each set tab (offset by 2 for Collected + Image)
  const nameCol = colLetter(2 + nameIdx);
  const numCol  = colLetter(2 + numIdx);
  const lastCol = colLetter(2 + csvHeaders.length - 1);

  const S = sep; // formula argument separator (';' for German/EU, ',' for US)

  // Inside the QUERY string, column separator is always "," (QUERY language syntax).
  // Only the outer Sheets function argument separator (S) is locale-dependent.
  const missingQuery  = tab => `=QUERY(${tab}!A2:${lastCol}${S}"SELECT ${nameCol},${numCol} WHERE A = FALSE"${S}0)`;
  const countMissing  = tab => `COUNTIF(${tab}!A2:A${S}FALSE)`;
  const countTotal    = tab => `COUNTA(${tab}!C2:C)`;

  // ── Get or create Dashboard tab at index 0 ──────────────────────────────────
  const meta     = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === 'Dashboard');
  let sheetId;
  const batchReqs = [];

  if (existing) {
    sheetId = existing.properties.sheetId;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Dashboard' });
    if (existing.properties.index !== 0)
      batchReqs.push({ updateSheetProperties: {
        properties: { sheetId, index: 0 }, fields: 'index',
      }});
  } else {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Dashboard', index: 0 } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  }

  // ── Build cell values ────────────────────────────────────────────────────────
  const numSets  = sets.length;
  const totalCols = numSets * 2;

  // Row 1: title left, overall remaining right
  const totalAll   = sets.map(({tab}) => countTotal(tab)).join('+');
  const missingAll = sets.map(({tab}) => countMissing(tab)).join('+');
  const row1 = Array(totalCols).fill('');
  row1[0]              = 'MTG Collection Dashboard';
  row1[totalCols - 1]  = `="Verbleibend: "&(${missingAll})&"/"&(${totalAll})`;

  // Row 3: per-set header  "TAB: missing/total"
  const row3 = sets.flatMap(({tab}) => [
    `="${tab}: "&${countMissing(tab)}&"/"&${countTotal(tab)}`,
    '',
  ]);

  // Write rows 1–3 (row 2 left empty)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Dashboard!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row1, [], row3] },
  });

  // Write QUERY formulas side by side starting at row 4
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: sets.map(({tab}, i) => ({
        range: `Dashboard!${colLetter(i * 2)}4`,
        values: [[missingQuery(tab)]],
      })),
    },
  });

  // ── Formatting ───────────────────────────────────────────────────────────────
  const titleBg  = { red: 0.18, green: 0.09, blue: 0.38 }; // deep purple
  const headerBg = { red: 0.62, green: 0.24, blue: 0.44 }; // rose
  const white    = { red: 1, green: 1, blue: 1 };

  const fullRow  = (r0, r1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 0, endColumnIndex: totalCols });

  batchReqs.push(
    // Freeze first 3 rows
    { updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 3 } },
        fields: 'gridProperties.frozenRowCount',
    }},
    // Title row — background + large bold white text
    { repeatCell: {
        range: fullRow(0, 1),
        cell: { userEnteredFormat: {
          backgroundColor: titleBg,
          textFormat: { bold: true, fontSize: 13, foregroundColor: white },
          verticalAlignment: 'MIDDLE',
        }},
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
    }},
    // Right-align the "Verbleibend" cell
    { repeatCell: {
        range: { ...fullRow(0, 1), startColumnIndex: totalCols - 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat.horizontalAlignment',
    }},
    // Set-header row — rose background, bold white
    { repeatCell: {
        range: fullRow(2, 3),
        cell: { userEnteredFormat: {
          backgroundColor: headerBg,
          textFormat: { bold: true, foregroundColor: white },
          verticalAlignment: 'MIDDLE',
        }},
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)',
    }},
    // Title row height
    { updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 40 }, fields: 'pixelSize',
    }},
    // Set-header row height
    { updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 28 }, fields: 'pixelSize',
    }},
  );

  // Column widths: name col wide, number col narrow, per set pair
  for (let i = 0; i < numSets; i++) {
    batchReqs.push(
      { updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: i * 2,     endIndex: i * 2 + 1 },
          properties: { pixelSize: 200 }, fields: 'pixelSize',
      }},
      { updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: i * 2 + 1, endIndex: i * 2 + 2 },
          properties: { pixelSize: 70 }, fields: 'pixelSize',
      }},
    );
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: batchReqs } });
  console.log(`  ✓ Dashboard ready (${numSets} sets)`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();

  console.log(`Spreadsheet: https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit`);
  console.log(`Sets: ${cfg.sets.map(s => s.code).join(', ')}\n`);

  const auth   = await authorize(cfg.credentialsPath, cfg.tokenPath);
  const sheets = google.sheets({ version: 'v4', auth });

  const doneSets    = [];   // sets successfully written
  let   sharedHeaders = null; // CSV headers (same for all Scryfall tabs)

  for (const { code, tab, collectorRange } of cfg.sets) {
    console.log(`[${tab}] Fetching set:${code}…`);
    let { headers, rows } = await fetchSet(code);

    if (rows.length === 0) {
      console.log(`  Skipping "${tab}" — no cards returned.\n`);
      continue;
    }

    // Optional collector number range filter
    if (collectorRange) {
      const [min, max] = collectorRange;
      const before = rows.length;
      rows = rows.filter(r => {
        const n = parseInt(r.collector_number, 10);
        return !isNaN(n) && n >= min && n <= max;
      });
      console.log(`  Filtered to collector #${min}–${max}: ${rows.length}/${before} cards`);
      if (rows.length === 0) {
        console.log(`  Skipping "${tab}" — no cards in range.\n`);
        continue;
      }
    }

    console.log(`  ${rows.length} total cards. Writing…`);
    await writeTab(sheets, cfg.spreadsheetId, tab, headers, rows, cfg.imageCol, cfg.preserveChecks);
    doneSets.push({ code, tab });
    if (!sharedHeaders) sharedHeaders = headers;
    console.log('');
  }

  if (doneSets.length > 0 && sharedHeaders) {
    await createDashboard(sheets, cfg.spreadsheetId, doneSets, sharedHeaders, cfg.formulaSep);
  }

  console.log('\nDone!');
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
