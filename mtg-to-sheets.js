#!/usr/bin/env node
/**
 * mtg-to-sheets.js
 * Downloads Scryfall card JSON (with pagination) and writes it to Google Sheets.
 * One tab per set code. Adds collected/foiled checkbox columns and an image formula column.
 *
 * ── SETUP ──────────────────────────────────────────────────────────────────
 *   npm install googleapis
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
  wizardsArtCards: [],                // optional official Wizards art-card gallery imports
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

function resolveConfig(cli, fileConf) {
  return {
    spreadsheetId:   cli.spreadsheetId   ?? fileConf.spreadsheetId   ?? DEFAULTS.spreadsheetId,
    credentialsPath: cli.credentialsPath  ?? fileConf.credentialsPath ?? DEFAULTS.credentialsPath,
    tokenPath:       fileConf.tokenPath   ?? DEFAULTS.tokenPath,
    imageCol:        cli.imageCol         ?? fileConf.imageCol         ?? DEFAULTS.imageCol,
    sets:            cli.sets             ?? fileConf.sets             ?? DEFAULTS.sets,
    preserveChecks:  cli.preserveChecks   ?? fileConf.preserveChecks   ?? DEFAULTS.preserveChecks,
    formulaSep:      cli.formulaSep       ?? fileConf.formulaSep       ?? DEFAULTS.formulaSep,
    wizardsArtCards: fileConf.wizardsArtCards ?? DEFAULTS.wizardsArtCards,
    sceneImageGallery: fileConf.sceneImageGallery ?? null,
  };
}

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
  const cfg = resolveConfig(cli, fileConf);

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

function isInvalidGrantError(err) {
  return err?.response?.data?.error === 'invalid_grant' || err?.code === 'invalid_grant';
}

function extractAuthCode(input) {
  const trimmed = String(input ?? '').trim();
  const normalized = trimmed.replace(/\\&/g, '&');
  const markdownUrl = normalized.match(/^\[[^\]]*\]\((https?:\/\/.+)\)$/)?.[1];
  const candidate = markdownUrl ?? normalized;

  try {
    const url = new URL(candidate);
    return url.searchParams.get('code') ?? trimmed;
  } catch {
    return trimmed;
  }
}

async function authorizeInteractively(oAuth2, tokenPath) {
  // prompt: 'consent' guarantees Google returns a fresh refresh token after a
  // previously cached token was revoked or expired.
  const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  console.log('\nOpen this URL in your browser to authorise the app:\n');
  console.log(authUrl + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise(res => rl.question('Paste the auth code or callback URL here: ', res));
  rl.close();

  const { tokens } = await oAuth2.getToken(extractAuthCode(input));
  oAuth2.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`Token cached in ${tokenPath}\n`);
  return oAuth2;
}

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
    try {
      // Force a refresh even when a cached access token still has time left.
      // This surfaces a revoked refresh token before Scryfall fetching or any
      // Sheet write can begin.
      await oAuth2.refreshAccessToken();
      return oAuth2;
    } catch (err) {
      if (!isInvalidGrantError(err)) throw err;
      console.warn(`Cached OAuth token in ${tokenPath} was rejected (invalid_grant); requesting a new authorization.`);
      fs.unlinkSync(tokenPath);
    }
  }

  return authorizeInteractively(oAuth2, tokenPath);
}

// ── SCRYFALL FETCH ────────────────────────────────────────────────────────────

// These are the columns returned by Scryfall's CSV export. Retaining them keeps
// existing sheets and dashboard formulas stable while JSON avoids the CSV/JSON
// mismatch in Scryfall's pagination links.
const SCRYFALL_HEADERS = [
  'multiverse_id', 'mtgo_id', 'set', 'collector_number', 'lang', 'rarity',
  'name', 'mana_cost', 'cmc', 'type_line', 'artist', 'usd_price',
  'usd_foil_price', 'eur_price', 'tix_price', 'image_uri', 'scryfall_uri',
  'scryfall_id',
];

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function scryfallCardToRow(card) {
  const frontFace = card.card_faces?.[0];
  const imageUri = card.image_uris?.normal ?? frontFace?.image_uris?.normal ?? '';
  return {
    multiverse_id:   stringValue(card.multiverse_ids?.[0]),
    mtgo_id:         stringValue(card.mtgo_id),
    set:             stringValue(card.set),
    collector_number:stringValue(card.collector_number),
    lang:            stringValue(card.lang),
    rarity:          stringValue(card.rarity),
    name:            stringValue(card.name),
    mana_cost:       stringValue(card.mana_cost),
    cmc:             stringValue(card.cmc),
    type_line:       stringValue(card.type_line),
    artist:          stringValue(card.artist),
    usd_price:       stringValue(card.prices?.usd),
    usd_foil_price:  stringValue(card.prices?.usd_foil),
    eur_price:       stringValue(card.prices?.eur),
    tix_price:       stringValue(card.prices?.tix),
    image_uri:       imageUri,
    scryfall_uri:    stringValue(card.scryfall_uri),
    scryfall_id:     stringValue(card.id),
  };
}

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
  let url = `https://api.scryfall.com/cards/search?q=set:${code}&unique=prints&include_extras=true&format=json&page=1`;
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

    if (status !== 200) {
      const detail = body.trimStart().startsWith('{') ? JSON.parse(body).details : `HTTP ${status}`;
      console.log(` no data (${detail})`);
      return { headers: [], rows: [] };
    }

    const response = JSON.parse(body);
    const records = response.data ?? [];
    if (records.length === 0) { console.log(' empty'); break; }
    allRows.push(...records.map(scryfallCardToRow));

    console.log(` ${records.length} cards`);
    // JSON is requested explicitly, and Scryfall returns JSON next-page links.
    url = response.has_more ? response.next_page : null;
    page++;
    if (url) await sleep(PAGE_DELAY_MS);
  }

  return { headers: SCRYFALL_HEADERS, rows: allRows };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── OFFICIAL WIZARDS ART-CARD FETCH ──────────────────────────────────────────

// Keep the official-gallery rows column-compatible with Scryfall rows. If
// Scryfall adds Art Cards later, its rows can replace this source without
// changing the sheet layout or breaking checkbox preservation.
const WIZARDS_ART_HEADERS = SCRYFALL_HEADERS;

const CARDMARKET_PRODUCT_CATALOGUE_URL =
  'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_1.json';
const CARDMARKET_PRICE_GUIDE_URL =
  'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
const CARDMARKET_PRICE_FIELDS = new Set(['avg', 'low', 'trend', 'avg1', 'avg7', 'avg30']);

function cardmarketFeedKey(config = {}) {
  return JSON.stringify([
    config.productCatalogueUrl ?? CARDMARKET_PRODUCT_CATALOGUE_URL,
    config.priceGuideUrl ?? CARDMARKET_PRICE_GUIDE_URL,
  ]);
}

async function getCachedCardmarketFeed(cache, config, load = fetchCardmarketArtPrices) {
  const key = cardmarketFeedKey(config);
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => load(config)));
  return cache.get(key);
}

/** Parse Wizards' server-rendered card list; its bracketed value is a Contentful entry ID. */
function parseWizardsArtCards(cardListBody, { includeSceneCards = false, kind = null } = {}) {
  if (kind !== null && kind !== 'art' && kind !== 'scene')
    throw new Error('Wizards Art Card kind must be "art" or "scene"');
  return cardListBody.split('\n').flatMap(line => {
    const match = line.match(/^(.*?) (Scene )?Art Card (\d+)\/(\d+) \[([^\]]+)]$/);
    if (!match) return [];
    const [, name, scene, number, total, entryId] = match;
    const cardKind = scene ? 'scene' : 'art';
    if (kind ? cardKind !== kind : scene && !includeSceneCards) return [];
    return [{
      name: `${name} ${scene ?? ''}Art Card ${number}/${total}`,
      collector_number: `${number}/${total}`,
      entryId,
      kind: cardKind,
    }];
  });
}

function wizardsCardToRow({ code, collector_number, entryId, fallbackName, details }) {
  return {
    multiverse_id: '',
    mtgo_id: '',
    set: code,
    collector_number,
    lang: 'en',
    rarity: details.rarity ?? 'Art Card',
    name: details.name ?? fallbackName,
    mana_cost: '',
    cmc: '',
    type_line: 'Art Card',
    artist: details.artist ?? '',
    usd_price: '',
    usd_foil_price: '',
    eur_price: '',
    tix_price: '',
    image_uri: details.face,
    scryfall_uri: '',
    scryfall_id: `wizards:${entryId}`,
  };
}

function extractWizardsCardList(html) {
  const match = html.match(/cardList:\{body:("(?:\\.|[^"\\])*")/);
  if (!match) throw new Error('Wizards gallery page did not contain a card list');
  return JSON.parse(match[1]);
}

function extractWizardsContentfulToken(bundle) {
  const match = bundle.match(/(?:CTF_ACCESS_TOKEN|accessToken):\\?"([^"\\]+)/);
  return match?.[1] ?? null;
}

function normalizeCardmarketArtName(name) {
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^Art Series:\s*/i, '')
    .replace(/\s+(?:Scene\s+)?Art Card \d+\/\d+$/i, '')
    .replace(/\s+Scene$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function enrichWizardsArtCardPrices(rows, products, priceGuides, {
  expansionId,
  priceField = 'trend',
  productIds = {},
} = {}) {
  if (!Number.isInteger(expansionId))
    throw new Error('Cardmarket pricing requires an integer "expansionId"');
  if (!CARDMARKET_PRICE_FIELDS.has(priceField))
    throw new Error(`Unsupported Cardmarket priceField "${priceField}"`);

  const productsById = new Map(products.map(product => [product.idProduct, product]));
  const guidesById = new Map(priceGuides.map(guide => [guide.idProduct, guide]));
  const productIdsByName = new Map();

  for (const product of products) {
    if (product.idExpansion !== expansionId || !product.name.startsWith('Art Series:')) continue;
    const normalizedName = normalizeCardmarketArtName(product.name);
    productIdsByName.set(normalizedName, [...(productIdsByName.get(normalizedName) ?? []), product.idProduct]);
  }

  const stats = { priced: 0, unavailable: 0, unmatched: 0, overridden: 0 };
  const enriched = rows.map(row => {
    const overrideId = productIds[String(row.collector_number)];
    const candidateIds = productIdsByName.get(normalizeCardmarketArtName(row.name)) ?? [];
    const productId = overrideId ?? candidateIds.sort((a, b) => a - b)[0];

    if (overrideId !== undefined) {
      const product = productsById.get(overrideId);
      if (!product || product.idExpansion !== expansionId)
        throw new Error(`Cardmarket override ${overrideId} for #${row.collector_number} is not in expansion ${expansionId}`);
      stats.overridden++;
    }
    if (!productId) {
      stats.unmatched++;
      return row;
    }

    const price = guidesById.get(productId)?.[priceField];
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      stats.unavailable++;
      return row;
    }
    stats.priced++;
    return { ...row, eur_price: String(price) };
  });

  return { rows: enriched, stats };
}

async function fetchCardmarketArtPrices(config) {
  const [catalogue, guide] = await Promise.all([
    httpGet(config.productCatalogueUrl ?? CARDMARKET_PRODUCT_CATALOGUE_URL),
    httpGet(config.priceGuideUrl ?? CARDMARKET_PRICE_GUIDE_URL),
  ]);
  if (catalogue.status !== 200) throw new Error(`Could not load Cardmarket product catalogue (HTTP ${catalogue.status})`);
  if (guide.status !== 200) throw new Error(`Could not load Cardmarket price guide (HTTP ${guide.status})`);

  const products = JSON.parse(catalogue.body).products;
  const priceGuides = JSON.parse(guide.body).priceGuides;
  if (!Array.isArray(products) || !Array.isArray(priceGuides))
    throw new Error('Cardmarket downloads did not contain products and priceGuides arrays');
  return { products, priceGuides };
}

async function getWizardsContentfulToken(galleryHtml) {
  // Nuxt chunk names are content-hashed and change on every Wizards deployment.
  // Search every page-referenced Nuxt bundle instead of pinning a chunk number.
  const scriptUrls = [...galleryHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
    .map(match => match[1])
    .filter(src => src.startsWith('/_nuxt/'));

  for (const scriptUrl of scriptUrls) {
    const { body, status } = await httpGet(new URL(scriptUrl, 'https://magic.wizards.com').toString());
    if (status !== 200) continue;
    const token = extractWizardsContentfulToken(body);
    if (token) return token;
  }

  throw new Error('Wizards gallery page did not expose a Contentful delivery token in its Nuxt bundles');
}

async function fetchWizardsArtCards({
  url, tab, code = 'WIZARDS-ART', includeSceneCards = false, kind = null, cardmarket = null,
}, cardmarketData = null) {
  if (!url || !tab) throw new Error('Each wizardsArtCards entry needs both "url" and "tab"');
  const gallery = await httpGet(url);
  if (gallery.status !== 200) throw new Error(`Could not load Wizards gallery (HTTP ${gallery.status})`);

  const cards = parseWizardsArtCards(extractWizardsCardList(gallery.body), { includeSceneCards, kind });
  if (!cards.length) throw new Error('Wizards gallery did not contain any matching Art Cards');
  const token = await getWizardsContentfulToken(gallery.body);
  const entries = new Map();

  // The official gallery itself uses this public Contentful delivery endpoint.
  for (let start = 0; start < cards.length; start += 100) {
    const ids = cards.slice(start, start + 100).map(card => card.entryId).join(',');
    const endpoint = new URL('https://cdn.contentful.com/spaces/s5n2t79q9icq/environments/master/entries');
    endpoint.search = new URLSearchParams({
      access_token: token, content_type: 'magicCard', 'sys.id[in]': ids, locale: 'en', limit: '100',
    }).toString();
    const response = await httpGet(endpoint.toString());
    if (response.status !== 200) throw new Error(`Could not load Wizards Art Card details (HTTP ${response.status})`);
    for (const entry of JSON.parse(response.body).items ?? []) entries.set(entry.sys.id, entry.fields);
  }

  let rows = cards.map(card => {
    const details = entries.get(card.entryId);
    if (!details?.face) throw new Error(`Wizards Art Card ${card.collector_number} did not include an image`);
    return wizardsCardToRow({
      code, collector_number: card.collector_number, entryId: card.entryId,
      fallbackName: card.name, details,
    });
  });

  if (cardmarket) {
    const { products, priceGuides } = cardmarketData ?? await fetchCardmarketArtPrices(cardmarket);
    const enriched = enrichWizardsArtCardPrices(rows, products, priceGuides, cardmarket);
    rows = enriched.rows;
    const { priced, unavailable, unmatched, overridden } = enriched.stats;
    console.log(`  Cardmarket: ${priced} EUR prices, ${unavailable} unavailable, ${unmatched} unmatched, ${overridden} override(s)`);
  }

  return { headers: WIZARDS_ART_HEADERS, rows };
}

// ── SHEETS HELPERS ────────────────────────────────────────────────────────────

function colLetter(idx) {
  let s = '';
  for (let n = idx + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(64 + ((n - 1) % 26 + 1)) + s;
  return s;
}

function quoteSheetTab(tabName) {
  return `'${String(tabName).replaceAll("'", "''")}'`;
}

function buildImageGalleryFormulas(sourceTab, imageColumn, imageCount, columns = 3) {
  if (!Number.isInteger(imageCount) || imageCount < 0) throw new Error('Image gallery imageCount must be a non-negative integer');
  if (!Number.isInteger(columns) || columns < 1) throw new Error('Image gallery columns must be a positive integer');
  const rows = [];
  for (let index = 0; index < imageCount; index++) {
    const rowIndex = Math.floor(index / columns);
    if (!rows[rowIndex]) rows[rowIndex] = Array(columns).fill('');
    rows[rowIndex][index % columns] = `=IMAGE(${quoteSheetTab(sourceTab)}!${imageColumn}${index + 2})`;
  }
  return rows;
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

// Scryfall's CSV export uses uppercase set codes (e.g. HOB), while its JSON
// API uses lowercase (hob). Normalize both sides so a source-format change
// cannot clear previously collected cards.
function checkboxKey(setCode, collectorNumber) {
  return `${String(setCode ?? '').trim().toLowerCase()}:${String(collectorNumber ?? '').trim()}`;
}

/**
 * Read the existing sheet and return a Map of "set:collector_number" → checkbox state.
 * Columns are matched by header name, not position, so reordering is safe.
 * Sheets created before the Foiled column existed migrate with foiled=false.
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
  const collectedCol = colIdx('Collected');
  const foiledCol    = colIdx('Foiled');
  const setCol   = colIdx('set');
  const numCol   = colIdx('collector_number');

  if (setCol === -1 || numCol === -1) {
    console.warn('  Warning: could not find "set" or "collector_number" columns — checkboxes not preserved');
    return new Map();
  }

  const map = new Map();
  for (const row of dataRows) {
    const collected = collectedCol >= 0 && String(row[collectedCol] ?? '').toUpperCase() === 'TRUE';
    const foiled = foiledCol >= 0 && String(row[foiledCol] ?? '').toUpperCase() === 'TRUE';
    const key = checkboxKey(row[setCol], row[numCol]);
    if (collected || foiled) map.set(key, { collected, foiled });
  }
  return map;
}

// ── WRITE ONE TAB ─────────────────────────────────────────────────────────────

async function writeTab(sheets, spreadsheetId, tabName, csvHeaders, rows, imageColOverride, preserveChecks) {
  // Snapshot existing checkboxes before we clear anything
  const checkMap = preserveChecks
    ? await readCheckboxMap(sheets, spreadsheetId, tabName)
    : new Map();
  if (preserveChecks) console.log(`  Preserved checkbox state for ${checkMap.size} card(s)`);

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

  // Column layout:  A=Collected  B=Foiled  C=Image  D..=CSV columns
  const imgCsvIdx   = findImageColIdx(csvHeaders, imageColOverride);
  const imgSheetIdx = imgCsvIdx >= 0 ? 3 + imgCsvIdx : -1;
  const imgColLet   = imgSheetIdx >= 0 ? colLetter(imgSheetIdx) : null;

  const headerRow = ['Collected', 'Foiled', 'Image', ...csvHeaders];

  // Strip image formula from data rows — we write it separately with USER_ENTERED
  // so formulas evaluate. Everything else goes RAW to bypass locale-dependent
  // number parsing (German "." = thousands sep would corrupt "46.14" → 46140).
  const dataRows = rows.map(row => {
    const key = checkboxKey(row['set'], row['collector_number']);
    const state = checkMap.get(key) ?? { collected: false, foiled: false };
    return [state.collected, state.foiled, '', ...csvHeaders.map(h => coerceValue(row[h] ?? ''))];
  });

  // Pass 1: data + checkboxes as RAW (numbers stay numbers, no locale mangling)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headerRow, ...dataRows] },
  });

  // Pass 2: image formulas in col C as USER_ENTERED so they are evaluated
  if (imgColLet) {
    const formulaValues = rows.map((_, i) => [`=IMAGE(${imgColLet}${i + 2})`]);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!C2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: formulaValues },
    });
  }

  // Formatting
  const numRows  = rows.length;
  const numCols  = headerRow.length;

  const priceColIndices = csvHeaders
    .map((h, i) => /price|usd|eur|tix/i.test(h) ? 3 + i : -1)
    .filter(i => i >= 0);

  const dataRange    = { sheetId, startRowIndex: 1, endRowIndex: numRows + 1 };
  const checkColRange = { ...dataRange, startColumnIndex: 0, endColumnIndex: 2 };

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
    // Checkbox validation on cols A:B
    {
      setDataValidation: {
        range: checkColRange,
        rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true },
      },
    },
    // Checkbox cell type on cols A:B (renders the actual checkbox widgets)
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
    // Cols A:B (Collected/Foiled): narrow — just fit checkboxes
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 },
        properties: { pixelSize: 90 },
        fields: 'pixelSize',
      },
    },
    // Col C (Image): wide enough for a card image
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
        properties: { pixelSize: 215 },
        fields: 'pixelSize',
      },
    },
    // Auto-resize all other columns (D onwards)
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: numCols },
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

// ── IMAGE GALLERY TAB ─────────────────────────────────────────────────────────

async function createImageGallery(sheets, spreadsheetId, {
  sourceTab, tab, columns = 3, columnWidth = 250, rowHeight = 350,
}, sourceHeaders, sourceRowCount) {
  if (!sourceTab || !tab) throw new Error('sceneImageGallery needs both "sourceTab" and "tab"');
  const imageIndex = findImageColIdx(sourceHeaders, null);
  if (imageIndex < 0) throw new Error(`Could not find an image URL column for gallery source "${sourceTab}"`);
  const imageColumn = colLetter(3 + imageIndex); // source tabs prepend Collected + Foiled + Image
  const formulas = buildImageGalleryFormulas(sourceTab, imageColumn, sourceRowCount, columns);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(sheet => sheet.properties.title === tab);
  let sheetId;
  if (existing) {
    sheetId = existing.properties.sheetId;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: quoteSheetTab(tab) });
  } else {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    sheetId = res.data.replies[0].addSheet.properties.sheetId;
  }

  if (formulas.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetTab(tab)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: formulas },
    });
  }

  const requests = [
    { updateSheetProperties: {
      properties: { sheetId, gridProperties: { hideGridlines: true } },
      fields: 'gridProperties.hideGridlines',
    }},
    { updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: formulas.length },
      properties: { pixelSize: rowHeight }, fields: 'pixelSize',
    }},
  ];
  for (let index = 0; index < columns; index++) {
    requests.push({ updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
      properties: { pixelSize: columnWidth }, fields: 'pixelSize',
    }});
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log(`  ✓ ${sourceRowCount} images → gallery "${tab}" (${columns} per row)`);
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

  // Column letters as they appear in each set tab (offset by 3 for Collected + Foiled + Image)
  const nameCol = colLetter(3 + nameIdx);
  const numCol  = colLetter(3 + numIdx);
  const lastCol = colLetter(3 + csvHeaders.length - 1);

  const S = sep; // formula argument separator (';' for German/EU, ',' for US)

  // Inside the QUERY string, column separator is always "," (QUERY language syntax).
  // Only the outer Sheets function argument separator (S) is locale-dependent.
  const sheetRef = tab => quoteSheetTab(tab);
  const missingQuery  = tab => `=QUERY(${sheetRef(tab)}!A2:${lastCol}${S}"SELECT ${nameCol},${numCol} WHERE A = FALSE"${S}0)`;
  const countMissing  = tab => `COUNTIF(${sheetRef(tab)}!A2:A${S}FALSE)`;
  const countTotal    = tab => `COUNTA(${sheetRef(tab)}!D2:D)`;

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
  const tabImports  = new Map(); // tab → current headers/row count for optional galleries
  let   sharedHeaders = null; // CSV headers (same for all Scryfall tabs)

  for (const { code, tab, collectorRange, collectorList } of cfg.sets) {
    console.log(`[${tab}] Fetching set:${code}…`);
    let { headers, rows } = await fetchSet(code);

    if (rows.length === 0) {
      console.log(`  Skipping "${tab}" — no cards returned.\n`);
      continue;
    }

    // Filter by numeric range  e.g. collectorRange: [103, 110]
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

    // Filter by explicit ID list  e.g. collectorList: ["2026-4", "2026-6", "2026-13"]
    // IDs are matched as strings, so works for numeric and non-numeric collector numbers.
    if (collectorList) {
      const allowed = new Set(collectorList.map(String));
      const before = rows.length;
      rows = rows.filter(r => allowed.has(String(r.collector_number)));
      console.log(`  Filtered to ${allowed.size} listed IDs: ${rows.length}/${before} matched`);
      if (rows.length === 0) {
        console.log(`  Skipping "${tab}" — none of the listed collector IDs found.\n`);
        continue;
      }
    }

    console.log(`  ${rows.length} total cards. Writing…`);
    await writeTab(sheets, cfg.spreadsheetId, tab, headers, rows, cfg.imageCol, cfg.preserveChecks);
    doneSets.push({ code, tab });
    tabImports.set(tab, { headers, rowCount: rows.length });
    if (!sharedHeaders) sharedHeaders = headers;
    console.log('');
  }

  const cardmarketFeeds = new Map(); // feed-URL pair → parsed public Cardmarket data
  for (const artConfig of cfg.wizardsArtCards) {
    let cardmarketData = null;
    if (artConfig.cardmarket) {
      const feedKey = cardmarketFeedKey(artConfig.cardmarket);
      const reused = cardmarketFeeds.has(feedKey);
      cardmarketData = await getCachedCardmarketFeed(cardmarketFeeds, artConfig.cardmarket);
      console.log(reused
        ? '  Reusing downloaded Cardmarket EUR price guide…'
        : '  Downloaded Cardmarket EUR price guide…');
    }
    console.log(`[${artConfig.tab}] Fetching official Wizards Art Cards…`);
    const { headers, rows } = await fetchWizardsArtCards(artConfig, cardmarketData);
    console.log(`  ${rows.length} total Art Cards. Writing…`);
    await writeTab(sheets, cfg.spreadsheetId, artConfig.tab, headers, rows, cfg.imageCol, cfg.preserveChecks);
    doneSets.push({ code: artConfig.code ?? 'WIZARDS-ART', tab: artConfig.tab });
    tabImports.set(artConfig.tab, { headers, rowCount: rows.length });
    if (!sharedHeaders) sharedHeaders = headers;
    console.log('');
  }

  if (cfg.sceneImageGallery) {
    const { sourceTab } = cfg.sceneImageGallery;
    const source = tabImports.get(sourceTab);
    if (!source) throw new Error(`sceneImageGallery sourceTab "${sourceTab}" was not imported in this run`);
    console.log(`[${cfg.sceneImageGallery.tab}] Building image gallery from "${sourceTab}"…`);
    await createImageGallery(sheets, cfg.spreadsheetId, cfg.sceneImageGallery, source.headers, source.rowCount);
    console.log('');
  }

  if (doneSets.length > 0 && sharedHeaders) {
    await createDashboard(sheets, cfg.spreadsheetId, doneSets, sharedHeaders, cfg.formulaSep);
  }

  console.log('\nDone!');
}

if (require.main === module) {
  main().catch(err => { console.error(err.message ?? err); process.exit(1); });
}

module.exports = {
  authorize, isInvalidGrantError, extractAuthCode, resolveConfig, scryfallCardToRow, parseWizardsArtCards,
  wizardsCardToRow, quoteSheetTab, buildImageGalleryFormulas, extractWizardsContentfulToken, checkboxKey, readCheckboxMap, writeTab,
  enrichWizardsArtCardPrices, cardmarketFeedKey, getCachedCardmarketFeed, fetchSet, fetchWizardsArtCards,
};
