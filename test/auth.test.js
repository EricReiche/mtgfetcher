const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { google } = require('googleapis');

const { authorize, isInvalidGrantError } = require('../mtg-to-sheets.js');

test('recognizes an invalid_grant returned while refreshing a Google OAuth token', () => {
  const error = {
    response: {
      data: {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      },
    },
  };

  assert.equal(isInvalidGrantError(error), true);
});

test('does not treat unrelated API errors as a stale OAuth token', () => {
  assert.equal(isInvalidGrantError(new Error('Request failed with status code 403')), false);
});

test('forces a refresh even if a cached access token is not yet expired', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtgfetcher-auth-'));
  const credentialsPath = path.join(tempDir, 'credentials.json');
  const tokenPath = path.join(tempDir, 'token.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    installed: { client_id: 'client-id', client_secret: 'client-secret', redirect_uris: ['http://localhost'] },
  }));
  fs.writeFileSync(tokenPath, JSON.stringify({
    access_token: 'still-valid-access-token', refresh_token: 'rejected-token', expiry_date: Date.now() + 60 * 60 * 1000,
  }));

  const originalOAuth2 = google.auth.OAuth2;
  const originalCreateInterface = readline.createInterface;
  t.after(() => {
    google.auth.OAuth2 = originalOAuth2;
    readline.createInterface = originalCreateInterface;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  class FakeOAuth2 {
    constructor() { this.refreshCalls = 0; }
    setCredentials(tokens) { this.credentials = tokens; }
    async getAccessToken() { return { token: 'still-valid-access-token' }; }
    async refreshAccessToken() {
      this.refreshCalls++;
      throw { response: { data: { error: 'invalid_grant' } } };
    }
    generateAuthUrl(options) {
      this.authOptions = options;
      return 'https://accounts.google.test/authorize';
    }
    async getToken() {
      return { tokens: { access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token' } };
    }
  }

  google.auth.OAuth2 = FakeOAuth2;
  readline.createInterface = () => ({ question: (_prompt, callback) => callback('fresh-code'), close: () => {} });

  const client = await authorize(credentialsPath, tokenPath);

  assert.equal(client.refreshCalls, 1);
  assert.deepEqual(client.credentials, { access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token' });
});

test('replaces a rejected cached token before the first Sheets request', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtgfetcher-auth-'));
  const credentialsPath = path.join(tempDir, 'credentials.json');
  const tokenPath = path.join(tempDir, 'token.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    installed: { client_id: 'client-id', client_secret: 'client-secret', redirect_uris: ['http://localhost'] },
  }));
  fs.writeFileSync(tokenPath, JSON.stringify({ refresh_token: 'rejected-token' }));

  const originalOAuth2 = google.auth.OAuth2;
  const originalCreateInterface = readline.createInterface;
  t.after(() => {
    google.auth.OAuth2 = originalOAuth2;
    readline.createInterface = originalCreateInterface;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  class FakeOAuth2 {
    setCredentials(tokens) { this.credentials = tokens; }
    async refreshAccessToken() {
      throw { response: { data: { error: 'invalid_grant' } } };
    }
    generateAuthUrl(options) {
      this.authOptions = options;
      return 'https://accounts.google.test/authorize';
    }
    async getToken(code) {
      assert.equal(code, 'fresh-code');
      return { tokens: { access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token' } };
    }
  }

  google.auth.OAuth2 = FakeOAuth2;
  readline.createInterface = () => ({ question: (_prompt, callback) => callback('fresh-code'), close: () => {} });

  const client = await authorize(credentialsPath, tokenPath);

  assert.deepEqual(client.credentials, { access_token: 'fresh-access-token', refresh_token: 'fresh-refresh-token' });
  assert.deepEqual(JSON.parse(fs.readFileSync(tokenPath, 'utf8')), client.credentials);
  assert.equal(client.authOptions.prompt, 'consent');
  assert.equal(client.authOptions.access_type, 'offline');
  assert.deepEqual(client.authOptions.scope, ['https://www.googleapis.com/auth/spreadsheets']);
});
