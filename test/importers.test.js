const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scryfallCardToRow,
  parseWizardsArtCards,
  quoteSheetTab,
  wizardsCardToRow,
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
  });
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
    'scryfall_id',
  ]);
  assert.equal(row.set, 'HOB-ART');
  assert.equal(row.collector_number, '6/54');
  assert.equal(row.image_uri, 'https://media.wizards.example/art.webp');
  assert.equal(row.scryfall_id, 'wizards:entry-id');
});
