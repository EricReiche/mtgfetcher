const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scryfallCardToRow,
  parseWizardsArtCards,
  parseWizardsGalleryCards,
  kebabCase,
  quoteSheetTab,
  wizardsCardToRow,
  extractWizardsContentfulToken,
  checkboxKey,
  enrichWizardsArtCardPrices,
  buildImageGalleryFormulas,
  resolveConfig,
  cardmarketFeedKey,
  getCachedCardmarketFeed,
  readCheckboxMap,
  writeTab,
  buildSetSearchQuery,
  hexColor,
} = require('../mtg-to-sheets.js');

test('converts a Scryfall JSON card to the legacy sheet columns', () => {
  const row = scryfallCardToRow({
    multiverse_ids: [123], mtgo_id: 456, set: 'hob', collector_number: '285',
    lang: 'en', rarity: 'rare', name: "Bilbo's Gambit", mana_cost: '{1}{W}', cmc: 2,
    type_line: 'Sorcery', artist: 'Example Artist',
    prices: { usd: '3.50', usd_foil: '5.00', eur: '2.99', tix: '0.03' },
    image_uris: { normal: 'https://cards.example/bilbo.jpg' },
    scryfall_uri: 'https://scryfall.example/card/hob/285', id: 'card-id',
  });

  assert.deepEqual(row, {
    multiverse_id: '123', mtgo_id: '456', set: 'hob', collector_number: '285',
    lang: 'en', rarity: 'rare', name: "Bilbo's Gambit", mana_cost: '{1}{W}',
    cmc: '2', type_line: 'Sorcery', artist: 'Example Artist',
    usd_price: '3.50', usd_foil_price: '5.00', eur_price: '2.99', tix_price: '0.03',
    image_uri: 'https://cards.example/bilbo.jpg',
    scryfall_uri: 'https://scryfall.example/card/hob/285', scryfall_id: 'card-id',
    foil_available: false,
  });
});

test('records regular foil availability from Scryfall finishes', () => {
  assert.equal(scryfallCardToRow({ finishes: ['nonfoil', 'foil'] }).foil_available, true);
  assert.equal(scryfallCardToRow({ finishes: ['etched'] }).foil_available, false);
  assert.equal(scryfallCardToRow({ foil: true }).foil_available, true);
});

test('uses the front-face image for a double-faced Scryfall card', () => {
  const row = scryfallCardToRow({
    set: 'hob', collector_number: '289',
    card_faces: [{ image_uris: { normal: 'https://cards.example/front.jpg' } }],
  });
  assert.equal(row.image_uri, 'https://cards.example/front.jpg');
});

test('parses standalone Art Cards and can exclude Scene Art Cards from a Wizards gallery list', () => {
  const body = [
    'Fíli and Kíli, Joyous Scene Art Card 1/12 [scene-id]',
    'Troop of Ponies Art Card 1/54 [art-id]',
    'Not a card entry',
  ].join('\n');

  assert.deepEqual(parseWizardsArtCards(body, { includeSceneCards: false }), [{
    name: 'Troop of Ponies Art Card 1/54', collector_number: '1/54', entryId: 'art-id', kind: 'art',
  }]);
  assert.deepEqual(parseWizardsArtCards(body, { includeSceneCards: true }).map(card => card.kind), ['scene', 'art']);
});

test('filters a Wizards gallery into an independent Scene Card tab', () => {
  const body = [
    'Regular Art Card 1/54 [regular-entry]',
    'Scene Card Scene Art Card 1/12 [scene-entry]',
  ].join('\n');

  assert.deepEqual(parseWizardsArtCards(body, { kind: 'scene' }), [{
    name: 'Scene Card Scene Art Card 1/12', collector_number: '1/12', entryId: 'scene-entry', kind: 'scene',
  }]);
});

test('quotes sheet tab names in formulas, including embedded apostrophes', () => {
  assert.equal(quoteSheetTab('HOB Art Cards'), "'HOB Art Cards'");
  assert.equal(quoteSheetTab("Urza's Art"), "'Urza''s Art'");
});

test('maps an official Wizards Art Card to the same columns as a Scryfall card', () => {
  const row = wizardsCardToRow({
    code: 'HOB-ART', collector_number: '6/54', entryId: 'entry-id',
    fallbackName: 'An Unexpected Party Art Card 6/54',
    details: { name: 'An Unexpected Party Art Card 6/54', rarity: 'Art Card', artist: 'Matt Stewart', face: 'https://media.wizards.example/art.webp' },
  });

  assert.deepEqual(Object.keys(row), [
    'multiverse_id', 'mtgo_id', 'set', 'collector_number', 'lang', 'rarity',
    'name', 'mana_cost', 'cmc', 'type_line', 'artist', 'usd_price',
    'usd_foil_price', 'eur_price', 'tix_price', 'image_uri', 'scryfall_uri',
    'scryfall_id', 'foil_available',
  ]);
  assert.equal(row.set, 'HOB-ART');
  assert.equal(row.collector_number, '6/54');
  assert.equal(row.image_uri, 'https://media.wizards.example/art.webp');
  assert.equal(row.scryfall_id, 'wizards:entry-id');
});

test('extracts a Contentful token from either current Wizards bundle spelling', () => {
  assert.equal(extractWizardsContentfulToken('CTF_ACCESS_TOKEN:\\"token-one"'), 'token-one');
  assert.equal(extractWizardsContentfulToken('accessToken:"token-two"'), 'token-two');
  assert.equal(extractWizardsContentfulToken('unrelated bundle'), null);
});

test('uses case-independent checkbox keys across CSV and JSON Scryfall set codes', () => {
  assert.equal(checkboxKey('HOB', '60'), 'hob:60');
  assert.equal(checkboxKey('hob', 60), 'hob:60');
  assert.equal(checkboxKey(' HOB ', ' 60 '), 'hob:60');
});

test('adds an exact collector-number filter to the Scryfall set query', () => {
  assert.equal(buildSetSearchQuery('sld', ['734', '1293', '399s', '2026-1']),
    'set:sld (cn:"734" or cn:"1293" or cn:"399s" or cn:"2026-1")');
  assert.equal(buildSetSearchQuery('ltr'), 'set:ltr');
});

test('converts a configured Dashboard hex color to the Sheets color format', () => {
  assert.deepEqual(hexColor('#2E7D32'), { red: 46 / 255, green: 125 / 255, blue: 50 / 255 });
  assert.throws(() => hexColor('green'), /6-digit hex/);
});

test('preserves a checked box from the legacy unlabeled/Karte layout', async () => {
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [
    ['', 'Karte', 'multiverse_id', 'set', 'collector_number'],
    [true, '', '123', 'LTR', '451'],
  ] } }) } } };
  const map = await readCheckboxMap(sheets, 'sheet-id', 'LTR');
  assert.deepEqual(map.get('ltr:451'), { collected: true, foiled: false });
});

test('parses ordinary Wizards gallery cards and normalizes product URL values', () => {
  assert.deepEqual(parseWizardsGalleryCards('The One Ring [ring-id]\nNot a card'), [
    { name: 'The One Ring', entryId: 'ring-id' },
  ]);
  assert.equal(kebabCase('LTR | CIG Product | Regional Championship'), 'ltr-cig-product-regional-championship');
});

test('migrates legacy sheets by preserving Collected and defaulting Foiled to false', async () => {
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [
    ['Collected', 'Image', 'set', 'collector_number'],
    [true, '=IMAGE(...)', 'HOB', '60'],
  ] } }) } } };

  assert.deepEqual(
    await readCheckboxMap(sheets, 'sheet-id', 'HOB'),
    new Map([['hob:60', { collected: true, foiled: false }]]),
  );
});

test('preserves Collected and Foiled independently on current sheets', async () => {
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [
    ['Collected', 'Foiled', 'Image', 'set', 'collector_number'],
    [false, true, '=IMAGE(...)', 'hob', '61'],
    [true, false, '=IMAGE(...)', 'hob', '62'],
  ] } }) } } };

  assert.deepEqual(
    await readCheckboxMap(sheets, 'sheet-id', 'HOB'),
    new Map([
      ['hob:61', { collected: false, foiled: true }],
      ['hob:62', { collected: true, foiled: false }],
    ]),
  );
});

test('writes Foiled second while preserving legacy Collected and user-edited lang values', async () => {
  const updates = [];
  const batches = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'HOB', sheetId: 7 } }] } }),
    values: {
      get: async () => ({ data: { values: [
        ['Collected', 'Image', 'set', 'collector_number', 'lang', 'image_uri'],
        [true, '=IMAGE(F2)', 'HOB', '60', 'custom-lang', 'https://cards.example/60.jpg'],
      ] } }),
      clear: async () => {},
      update: async request => { updates.push(request); },
    },
    batchUpdate: async request => { batches.push(request); },
  } };

  const headers = ['set', 'collector_number', 'lang', 'image_uri'];
  const rows = [{
    set: 'hob', collector_number: '60', lang: 'en', image_uri: 'https://cards.example/60.jpg',
  }];
  await writeTab(sheets, 'sheet-id', 'HOB', headers, [...rows], null, true);
  await writeTab(sheets, 'sheet-id', 'HOB', headers, [...rows], null, false);

  assert.deepEqual(updates[0].requestBody.values, [
    ['Collected', 'Foiled', 'Image', 'set', 'collector_number', 'lang', 'image_uri'],
    [true, false, '', 'hob', 60, 'custom-lang', 'https://cards.example/60.jpg'],
  ]);
  assert.equal(updates[1].range, "'HOB'!C2");
  assert.deepEqual(updates[1].requestBody.values, [['=IMAGE(G2)']]);

  assert.deepEqual(updates[2].requestBody.values, [
    ['Collected', 'Foiled', 'Image', 'set', 'collector_number', 'lang', 'image_uri'],
    [false, false, '', 'hob', 60, 'custom-lang', 'https://cards.example/60.jpg'],
  ]);

  const validation = batches[0].requestBody.requests.find(request => request.setDataValidation);
  assert.equal(validation.setDataValidation.range.startColumnIndex, 0);
  assert.equal(validation.setDataValidation.range.endColumnIndex, 2);
});

test('marks only configured exact keys as collected during a bulk import', async () => {
  const updates = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'LTC', sheetId: 1 } }] } }),
    values: { get: async () => ({ data: { values: [] } }), clear: async () => {}, update: async req => updates.push(req) },
    batchUpdate: async () => ({ data: { replies: [] } }),
  } };
  await writeTab(sheets, 'sheet-id', 'LTC', ['set', 'collector_number'], [
    { set: 'ltc', collector_number: '1' }, { set: 'ltc', collector_number: '2' },
  ], null, true, new Set(['ltc:2']));
  assert.deepEqual(updates[0].requestBody.values.slice(1).map(row => row[0]), [false, true]);
});

test('captures a blank user-edited lang value for preservation', async () => {
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [
    ['Collected', 'Foiled', 'set', 'collector_number', 'lang'],
    [false, false, 'hob', '60', ''],
  ] } }) } } };

  assert.deepEqual(
    await readCheckboxMap(sheets, 'sheet-id', 'HOB'),
    new Map([['hob:60', { collected: false, foiled: false, lang: '' }]]),
  );
});

test('fills Art Card EUR price from the Cardmarket trend guide using the base variant', () => {
  const rows = [{ name: 'Art Series: Troop of Ponies Art Card 1/54', collector_number: '1/54', eur_price: '' }];
  const products = [
    { idProduct: 901097, idExpansion: 6664, name: 'Art Series: Troop of Ponies' },
    { idProduct: 901098, idExpansion: 6664, name: 'Art Series: Troop of Ponies' },
  ];
  const guides = [
    { idProduct: 901097, trend: 2.5 },
    { idProduct: 901098, trend: 9.5 },
  ];

  const { rows: enriched, stats } = enrichWizardsArtCardPrices(rows, products, guides, { expansionId: 6664 });
  assert.equal(enriched[0].eur_price, '2.5');
  assert.deepEqual(stats, { priced: 1, unavailable: 0, unmatched: 0, overridden: 0 });
});

test('uses an explicit Cardmarket product override and leaves unavailable guide values blank', () => {
  const rows = [{ name: 'Art Series: Plains Art Card 41/54', collector_number: '41/54', eur_price: '' }];
  const products = [
    { idProduct: 901212, idExpansion: 6664, name: 'Art Series: Plains' },
    { idProduct: 901213, idExpansion: 6664, name: 'Art Series: Plains' },
  ];
  const guides = [{ idProduct: 901213, trend: null }];

  const { rows: enriched, stats } = enrichWizardsArtCardPrices(rows, products, guides, {
    expansionId: 6664,
    productIds: { '41/54': 901213 },
  });
  assert.equal(enriched[0].eur_price, '');
  assert.deepEqual(stats, { priced: 0, unavailable: 1, unmatched: 0, overridden: 1 });
});

test('matches a Cardmarket Scene product name to a Wizards Scene Art Card', () => {
  const rows = [{ name: 'Gandalf, Party Guest Scene Art Card 2/12', collector_number: '2/12', eur_price: '' }];
  const products = [{ idProduct: 901242, idExpansion: 6664, name: 'Art Series: Gandalf, Party Guest Scene' }];
  const guides = [{ idProduct: 901242, trend: 1.5 }];

  const { rows: enriched, stats } = enrichWizardsArtCardPrices(rows, products, guides, { expansionId: 6664 });
  assert.equal(enriched[0].eur_price, '1.5');
  assert.deepEqual(stats, { priced: 1, unavailable: 0, unmatched: 0, overridden: 0 });
});

test('downloads a Cardmarket feed only once for matching configurations', async () => {
  const cache = new Map();
  let loads = 0;
  const load = async () => ({ products: [], priceGuides: [], load: ++loads });
  const first = await getCachedCardmarketFeed(cache, {}, load);
  const second = await getCachedCardmarketFeed(cache, { expansionId: 6664, priceField: 'trend' }, load);
  assert.equal(loads, 1);
  assert.equal(first, second);
});

test('uses one Cardmarket cache key for entries with the same feed URLs', () => {
  assert.equal(cardmarketFeedKey({}), cardmarketFeedKey({ priceField: 'avg7', expansionId: 6664 }));
  assert.notEqual(
    cardmarketFeedKey({ productCatalogueUrl: 'https://example.test/catalogue.json' }),
    cardmarketFeedKey({}),
  );
});

test('keeps sceneImageGallery from the loaded config', () => {
  const gallery = { sourceTab: 'HOB Scene Cards', tab: 'HOB Scenes', columns: 3 };
  assert.deepEqual(resolveConfig({}, { spreadsheetId: 'sheet-id', sceneImageGallery: gallery }).sceneImageGallery, gallery);
});

test('parses CLI --sets with "+" merging multiple set codes into one tab', () => {
  const { parseArgs } = require('../mtg-to-sheets.js');
  const cli = parseArgs(['--sets', 'pspl+purl:Promos,pw26:PW26']);
  assert.deepEqual(cli.sets, [
    { sets: ['pspl', 'purl'], code: 'pspl', tab: 'PROMOS' },
    { sets: ['pw26'], code: 'pw26', tab: 'PW26' },
  ]);
});

test('parses plain --sets codes with no "+" as single-code entries', () => {
  const { parseArgs } = require('../mtg-to-sheets.js');
  const cli = parseArgs(['--sets', 'msh,tmsh:Tokens']);
  assert.deepEqual(cli.sets, [
    { sets: ['msh'], code: 'msh', tab: 'MSH' },
    { sets: ['tmsh'], code: 'tmsh', tab: 'TOKENS' },
  ]);
});

test('sorts combined multi-set tabs by set code then collector number', async () => {
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'Promos', sheetId: 1 } }] } }),
    values: { get: async () => ({ data: { values: [] } }), clear: async () => {}, update: async () => {} },
    batchUpdate: async () => ({ data: { replies: [] } }),
  } };
  const headers = ['set', 'collector_number', 'name'];
  const rows = [
    { set: 'purl', collector_number: '2026-16', name: 'C' },
    { set: 'pspl', collector_number: '2026-1', name: 'A' },
    { set: 'pspl', collector_number: '2026-15', name: 'B' },
    { set: 'purl', collector_number: '2026-1', name: 'D' },
  ];
  const updates = [];
  sheets.spreadsheets.values.update = async req => { updates.push(req); };

  await writeTab(sheets, 'sheet-id', 'Promos', headers, [...rows], null, false);

  const dataRows = updates[0].requestBody.values.slice(1);
  assert.deepEqual(dataRows.map(r => [r[3], r[4]]), [
    ['pspl', '2026-1'],
    ['pspl', '2026-15'],
    ['purl', '2026-1'],
    ['purl', '2026-16'],
  ]);
});

test('merges per-source cards with independent collectorList filters into one tab', async () => {
  // Simulate the main-loop source normalization + per-source filtering.
  const entry = { tab: 'Promos', cards: [
    { set: 'PW26', collectorList: ['1', '3'] },
    { set: 'PSPL', collectorList: ['2'] },
  ]};

  const sources = entry.cards.map(card => ({
    code: String(card.set ?? card.code ?? '').toLowerCase(),
    collectorRange: card.collectorRange,
    collectorList: card.collectorList,
  }));

  const fakeRows = {
    pw26: [{ set: 'pw26', collector_number: '1' }, { set: 'pw26', collector_number: '2' }, { set: 'pw26', collector_number: '3' }],
    pspl: [{ set: 'pspl', collector_number: '1' }, { set: 'pspl', collector_number: '2' }],
  };

  let rows = [];
  for (const { code, collectorList } of sources) {
    let setRows = fakeRows[code];
    if (collectorList) {
      const allowed = new Set(collectorList.map(String));
      setRows = setRows.filter(r => allowed.has(String(r.collector_number)));
    }
    rows.push(...setRows);
  }

  assert.deepEqual(rows.map(r => [r.set, r.collector_number]), [
    ['pw26', '1'], ['pw26', '3'], ['pspl', '2'],
  ]);
});

test('lays out source image formulas three per row with safely quoted tabs', () => {
  assert.deepEqual(
    buildImageGalleryFormulas('HOB Scene Cards', 'R', 5, 3),
    [
      ["=IMAGE('HOB Scene Cards'!R2)", "=IMAGE('HOB Scene Cards'!R3)", "=IMAGE('HOB Scene Cards'!R4)"],
      ["=IMAGE('HOB Scene Cards'!R5)", "=IMAGE('HOB Scene Cards'!R6)", ''],
    ],
  );
});
