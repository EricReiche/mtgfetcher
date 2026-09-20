# Contributor guide

## Project overview

This repository is a Node.js 18+ command-line importer. `mtg-to-sheets.js`
fetches Magic: The Gathering card data from Scryfall and writes one or more
Google Sheets tabs, optionally including Wizards art/promo cards, image
galleries, and a Dashboard. There is no build step or package version field.

## Important files

- `mtg-to-sheets.js` — application code and exported helpers.
- `test/auth.test.js` — OAuth authorization and token recovery tests.
- `test/importers.test.js` — import, sheet-writing, configuration, and
  dashboard tests.
- `config.example.json` — safe configuration reference.
- `README.md` — user-facing setup and configuration documentation.

## Development workflow

1. Install dependencies with `npm install`.
2. Run the full test suite with `npm test` before handing off a change.
3. Keep unit tests offline: mock Google Sheets and HTTP behavior rather than
   calling real services.
4. Export a helper from `mtg-to-sheets.js` when it needs direct unit coverage.

## Data and API safety

- Never read, print, commit, or modify `credentials.json` or `token.json`.
  Treat both as secrets. Use temporary fixtures in tests.
- Do not run imports against a user's real spreadsheet merely to validate code.
- Preserve user-edited `Collected`, `Foiled`, and `lang` values when changing
  tab-writing behavior. Keys are normalized `set:collector_number` values.
- Sheets writes are deliberately retried on write-quota errors. Keep new write
  operations inside the existing retry wrapper; do not replace it with
  unbounded retries.
- Sheet reads/writes may be prototype methods on the Google API client. Do not
  spread-copy that client object; use prototype-preserving delegation when
  wrapping it.
- Keep values that must avoid locale parsing as `RAW`; only write formulas with
  `USER_ENTERED`.

## Conventions

- Use CommonJS and the existing plain JavaScript style.
- Keep changes focused; avoid unrelated formatting churn in the large main
  script.
- Update `README.md` when CLI flags, configuration, observable output, or user
  workflow changes.

## Releases

- Patch releases use annotated tags such as `v1.3.3` and GitHub releases.
- Check the latest tag before choosing the next version, push `main` and the
  tag, and give the release concise user-facing notes.
