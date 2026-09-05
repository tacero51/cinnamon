import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../src/worker.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const USERNAME = 'family';
const PASSWORD = 'correct-horse-battery-staple';
const SESSION_SIGNING_KEY = 'test-session-signing-key-that-is-long-enough';
const SESSION_COOKIE_NAME = '__Host-cinnamon_session';

function authHeader(username = USERNAME, password = PASSWORD) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function sessionValue(payload = (() => {
  const iat = Date.now();
  return { v: 1, iat, exp: iat + (30 * 24 * 60 * 60 * 1000) };
})()) {
  const encoded = toBase64Url(JSON.stringify(payload));
  const material = `${SESSION_SIGNING_KEY}\u0000${USERNAME}\u0000${PASSWORD}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), {
    name: 'HMAC', hash: 'SHA-256',
  }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded)));
  return `${encoded}.${Buffer.from(signature).toString('base64url')}`;
}

async function sessionHeaders(payload) {
  return { cookie: `${SESSION_COOKIE_NAME}=${await sessionValue(payload)}` };
}

function assetEnv() {
  return {
    LOGIN_USERNAME: USERNAME,
    LOGIN_PASSWORD: PASSWORD,
    SESSION_SIGNING_KEY,
    ASSETS: {
      fetch: async () => new Response('<!doctype html><title>Cinnamon</title>', {
        headers: { 'cache-control': 'public, max-age=31536000' },
      }),
    },
  };
}

function createR2(initialObjects = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const putAttempts = new Map();
  const plannedPutFailures = new Map();
  const objects = new Map(Object.entries(initialObjects).map(([key, value]) => [key, {
    bytes: typeof value.body === 'string' ? encoder.encode(value.body) : new Uint8Array(value.body),
    contentType: value.contentType || 'application/octet-stream',
  }]));

  async function bytesFrom(value) {
    if (typeof value === 'string') return encoder.encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(await new Response(value).arrayBuffer());
  }

  return {
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(value.bytes);
            controller.close();
          },
        }),
        async text() {
          return decoder.decode(value.bytes);
        },
        httpEtag: `etag-${key}`,
        httpMetadata: { contentType: value.contentType },
        writeHttpMetadata(headers) {
          headers.set('content-type', value.contentType);
        },
      };
    },
    async put(key, value, options = {}) {
      const attempt = (putAttempts.get(key) || 0) + 1;
      putAttempts.set(key, attempt);
      if (plannedPutFailures.get(key)?.has(attempt)) throw new Error(`planned put failure for ${key}`);
      objects.set(key, {
        bytes: await bytesFrom(value),
        contentType: options.httpMetadata?.contentType || 'application/octet-stream',
      });
    },
    async head(key) {
      const value = objects.get(key);
      return value ? { httpMetadata: { contentType: value.contentType } } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      if (cursor) return { objects: [], truncated: false };
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
    failPutOn(key, attempt) {
      if (!plannedPutFailures.has(key)) plannedPutFailures.set(key, new Set());
      plannedPutFailures.get(key).add(attempt);
    },
    has(key) {
      return objects.has(key);
    },
    keys() {
      return [...objects.keys()];
    },
    text(key) {
      const value = objects.get(key);
      return value ? decoder.decode(value.bytes) : null;
    },
    contentType(key) {
      return objects.get(key)?.contentType || null;
    },
    bytes(key) {
      return objects.get(key) ? [...objects.get(key).bytes] : null;
    },
  };
}

function imageBinding({ fail = false, invalidInfo = false } = {}) {
  return {
    input() {
      return {
        async output() {
          return {
            async response() {
              if (fail) throw new Error('transform failed');
              return new Response(new Uint8Array([0x57, 0x45, 0x42, 0x50]), {
                headers: { 'content-type': 'image/webp' },
              });
            },
          };
        },
      };
    },
    async info() {
      if (invalidInfo) return { format: 'jpeg', width: 0, height: 0 };
      return { format: 'webp', width: 1, height: 1 };
    },
  };
}

async function multipartRequest(url, form, method = 'POST') {
  return new Request(url, {
    method,
    headers: { ...(await sessionHeaders()), origin: new URL(url).origin },
    body: form,
  });
}

test('routes every static asset through the Worker before it is served', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.preview_urls, false);
});

test('fails closed when authentication secrets are absent', async () => {
  const response = await worker.fetch(new Request('https://example.test/'), { ASSETS: {} });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('requires each current form-login secret and does not accept removed Basic secrets', async () => {
  for (const missingSecret of ['LOGIN_USERNAME', 'LOGIN_PASSWORD', 'SESSION_SIGNING_KEY']) {
    const env = assetEnv();
    delete env[missingSecret];
    const response = await worker.fetch(new Request('https://example.test/'), env);
    assert.equal(response.status, 503, `${missingSecret} must be required`);
  }

  const legacyOnly = {
    BASIC_AUTH_USERNAME: USERNAME,
    BASIC_AUTH_PASSWORD: PASSWORD,
    SESSION_SIGNING_KEY,
    ASSETS: assetEnv().ASSETS,
  };
  const response = await worker.fetch(new Request('https://example.test/'), legacyOnly);
  assert.equal(response.status, 503);
});

test('redirects HTTP to HTTPS before inspecting any credentials', async () => {
  let assetFetches = 0;
  const env = assetEnv();
  env.ASSETS.fetch = async () => {
    assetFetches += 1;
    return new Response('unexpected');
  };

  const response = await worker.fetch(new Request('http://example.test/path?from=http', {
    headers: { authorization: authHeader() },
  }), env);

  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://example.test/path?from=http');
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(assetFetches, 0);
});

test('redirects unauthenticated static requests to the login form before assets are served', async () => {
  let assetFetches = 0;
  const env = assetEnv();
  env.ASSETS.fetch = async () => {
    assetFetches += 1;
    return new Response('unexpected');
  };

  const response = await worker.fetch(new Request('https://example.test/'), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://example.test/login');
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(assetFetches, 0);

  const script = await worker.fetch(new Request('https://example.test/app.js', {
    headers: { accept: 'text/html' },
  }), env);
  assert.equal(script.status, 401);
  assert.equal(script.headers.get('www-authenticate'), null);
});

test('ignores HTTP Basic credentials so the iPhone native prompt is never invoked', async () => {
  const response = await worker.fetch(new Request('https://example.test/', {
    headers: { authorization: authHeader() },
  }), assetEnv());
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('www-authenticate'), null);
});

test('renders a Password AutoFill-friendly login form and accepts only same-origin login posts', async () => {
  const formPage = await worker.fetch(new Request('https://example.test/login?next=%2Fcards%3Ftab%3Dnew'), assetEnv());
  const html = await formPage.text();
  assert.equal(formPage.status, 200);
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /autocapitalize="none"/);
  assert.match(html, /spellcheck="false"/);

  const form = new FormData();
  form.set('username', USERNAME);
  form.set('password', PASSWORD);
  form.set('next', '/cards?tab=new');
  const crossOrigin = await worker.fetch(new Request('https://example.test/login', {
    method: 'POST', headers: { origin: 'https://attacker.example' }, body: form,
  }), assetEnv());
  assert.equal(crossOrigin.status, 403);

  const sameOriginForm = new FormData();
  sameOriginForm.set('username', USERNAME);
  sameOriginForm.set('password', PASSWORD);
  sameOriginForm.set('next', '/cards?tab=new');
  const login = await worker.fetch(new Request('https://example.test/login', {
    method: 'POST', headers: { origin: 'https://example.test' }, body: sameOriginForm,
  }), assetEnv());
  const setCookie = login.headers.get('set-cookie') || '';
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), 'https://example.test/cards?tab=new');
  assert.match(setCookie, /^__Host-cinnamon_session=/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.match(setCookie, /Secure; HttpOnly; SameSite=Strict/);
});

test('validates signed sessions, rejects tampering, expiry, future issuance, overlong TTL, and duplicate cookies', async () => {
  const form = new FormData();
  form.set('username', USERNAME);
  form.set('password', PASSWORD);
  const login = await worker.fetch(new Request('https://example.test/login', {
    method: 'POST', headers: { origin: 'https://example.test' }, body: form,
  }), assetEnv());
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];

  const valid = await worker.fetch(new Request('https://example.test/', { headers: { cookie } }), assetEnv());
  assert.equal(valid.status, 200);

  const tampered = await worker.fetch(new Request('https://example.test/', { headers: { cookie: `${cookie}x` } }), assetEnv());
  assert.equal(tampered.status, 302);

  const now = Date.now();
  const invalidPayloads = [
    { v: 1, iat: now - 2000, exp: now - 1 },
    { v: 1, iat: now + 1000, exp: now + 2000 },
    { v: 1, iat: now, exp: now + (30 * 24 * 60 * 60 * 1000) + 1 },
  ];
  for (const payload of invalidPayloads) {
    const response = await worker.fetch(new Request('https://example.test/', {
      headers: await sessionHeaders(payload),
    }), assetEnv());
    assert.equal(response.status, 302);
  }

  const duplicate = await worker.fetch(new Request('https://example.test/', {
    headers: { cookie: `${cookie}; ${cookie}` },
  }), assetEnv());
  assert.equal(duplicate.status, 302);

  const passwordRotatedEnv = { ...assetEnv(), LOGIN_PASSWORD: 'new-password' };
  const passwordRotated = await worker.fetch(new Request('https://example.test/', { headers: { cookie } }), passwordRotatedEnv);
  assert.equal(passwordRotated.status, 302);
});

test('rejects unsafe login destinations and clears the exact session-cookie scope on logout', async () => {
  const unsafe = await worker.fetch(new Request('https://example.test/login?next=%2F%25252fattacker.example'), assetEnv());
  const unsafeHtml = await unsafe.text();
  assert.match(unsafeHtml, /name="next" value="\/"/);

  const loginForm = new FormData();
  loginForm.set('username', USERNAME);
  loginForm.set('password', PASSWORD);
  loginForm.set('next', '//attacker.example');
  const login = await worker.fetch(new Request('https://example.test/login', {
    method: 'POST', headers: { origin: 'https://example.test' }, body: loginForm,
  }), assetEnv());
  assert.equal(login.headers.get('location'), 'https://example.test/');

  const crossOriginLogout = await worker.fetch(new Request('https://example.test/logout', {
    method: 'POST', headers: { origin: 'https://attacker.example' },
  }), assetEnv());
  assert.equal(crossOriginLogout.status, 403);

  const logout = await worker.fetch(new Request('https://example.test/logout', {
    method: 'POST', headers: { origin: 'https://example.test' },
  }), assetEnv());
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie') || '', /^__Host-cinnamon_session=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Strict$/);
});

test('serves static assets only after a valid signed session and disables caching', async () => {
  const response = await worker.fetch(new Request('https://example.test/', {
    headers: await sessionHeaders(),
  }), assetEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(response.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('API and photos return a plain 401 without a Basic challenge when unauthenticated', async () => {
  let photoFetches = 0;
  const env = {
    ...assetEnv(),
    PHOTOS: {
      get: async () => {
        photoFetches += 1;
        return {
          body: new TextEncoder().encode('webp-bytes'),
          httpEtag: 'etag',
          writeHttpMetadata(headers) {
            headers.set('content-type', 'image/webp');
          },
        };
      },
    },
  };

  const unauthenticated = await worker.fetch(new Request('https://example.test/photos/secure/test.webp'), env);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('www-authenticate'), null);
  assert.equal(photoFetches, 0);

  const api = await worker.fetch(new Request('https://example.test/api/entries'), env);
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('www-authenticate'), null);

  const crossOriginWrite = await worker.fetch(new Request('https://example.test/api/entries', {
    method: 'POST',
    headers: { ...(await sessionHeaders()), origin: 'https://attacker.example' },
  }), env);
  assert.equal(crossOriginWrite.status, 403);

  const authenticated = await worker.fetch(new Request('https://example.test/photos/secure/test.webp', {
    headers: await sessionHeaders(),
  }), env);
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.headers.get('content-type'), 'image/webp');
  assert.equal(authenticated.headers.get('cache-control'), 'private, no-store');
});

test('does not expose the removed geocoding API route', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/geocode?lat=1&lon=1', {
    headers: await sessionHeaders(),
  }), assetEnv());
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('re-encodes a new photo to WebP before R2 storage', async () => {
  const r2 = createR2({
    'data/entries.json': { body: JSON.stringify({ entries: [] }), contentType: 'application/json' },
  });
  const form = new FormData();
  form.append('name', 'テストケーキ');
  form.append('where', 'おうち');
  form.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'original.jpg', { type: 'image/jpeg' }));

  const response = await worker.fetch(await multipartRequest('https://example.test/api/entries', form), {
    ...assetEnv(),
    PHOTOS: r2,
    IMAGES: imageBinding(),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.match(result.entry.photo, /^\/photos\/secure\/.+\.webp$/);
  assert.equal(r2.keys().filter((key) => key.startsWith('photos/secure/')).length, 1);
  const storedKey = result.entry.photo.slice(1);
  assert.equal(r2.contentType(storedKey), 'image/webp');
  assert.deepEqual(r2.bytes(storedKey), [0x57, 0x45, 0x42, 0x50]);
  assert.equal(r2.keys().some((key) => key.endsWith('.jpg')), false);
});

test('does not save an original photo when re-encoding fails', async () => {
  const r2 = createR2({
    'data/entries.json': { body: JSON.stringify({ entries: [] }), contentType: 'application/json' },
  });
  const form = new FormData();
  form.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'original.jpg', { type: 'image/jpeg' }));

  const response = await worker.fetch(await multipartRequest('https://example.test/api/entries', form), {
    ...assetEnv(),
    PHOTOS: r2,
    IMAGES: imageBinding({ fail: true }),
  });

  assert.equal(response.status, 422);
  assert.equal(r2.keys().some((key) => key.startsWith('photos/')), false);
});

test('rejects an unreadable sanitized image before it can be saved', async () => {
  const r2 = createR2({
    'data/entries.json': { body: JSON.stringify({ entries: [] }), contentType: 'application/json' },
  });
  const form = new FormData();
  form.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'original.jpg', { type: 'image/jpeg' }));

  const response = await worker.fetch(await multipartRequest('https://example.test/api/entries', form), {
    ...assetEnv(),
    PHOTOS: r2,
    IMAGES: imageBinding({ invalidInfo: true }),
  });

  assert.equal(response.status, 500);
  assert.equal(r2.keys().some((key) => key.startsWith('photos/')), false);
});

test('fails closed instead of replacing malformed entries data', async () => {
  const malformed = '{not valid JSON';
  const r2 = createR2({
    'data/entries.json': { body: malformed, contentType: 'application/json' },
  });
  const response = await worker.fetch(new Request('https://example.test/api/entries', {
    headers: await sessionHeaders(),
  }), { ...assetEnv(), PHOTOS: r2 });

  assert.equal(response.status, 500);
  assert.equal(r2.text('data/entries.json'), malformed);
});

test('blocks ordinary writes for the entire photo-maintenance window', async () => {
  const r2 = createR2({
    'data/entries.json': { body: JSON.stringify({ entries: [] }), contentType: 'application/json' },
  });
  const form = new FormData();
  form.append('name', 'メンテナンス中の記録');
  const response = await worker.fetch(await multipartRequest('https://example.test/api/entries', form), {
    ...assetEnv(),
    PHOTO_MIGRATION_TOKEN: 'migration-token',
    PHOTOS: r2,
    IMAGES: imageBinding(),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(r2.text('data/entries.json')).entries, []);
});

test('keeps a shared photo when one record replaces or removes its photo', async () => {
  const sharedKey = 'photos/secure/shared.webp';
  const r2 = createR2({
    'data/entries.json': {
      body: JSON.stringify({ entries: [
        { id: 'first', name: '一つ目', photo: `/${sharedKey}` },
        { id: 'second', name: '二つ目', photo: `/${sharedKey}` },
      ] }),
      contentType: 'application/json',
    },
    [sharedKey]: { body: new Uint8Array([0x57, 0x45, 0x42, 0x50]), contentType: 'image/webp' },
  });
  const form = new FormData();
  form.append('name', '一つ目');
  form.append('remove_photo', '1');

  const response = await worker.fetch(await multipartRequest('https://example.test/api/entries/first', form, 'PUT'), {
    ...assetEnv(),
    PHOTOS: r2,
    IMAGES: imageBinding(),
  });
  const entries = JSON.parse(r2.text('data/entries.json')).entries;

  assert.equal(response.status, 200);
  assert.equal(entries.find((entry) => entry.id === 'first').photo, undefined);
  assert.equal(entries.find((entry) => entry.id === 'second').photo, `/${sharedKey}`);
  assert.equal(r2.has(sharedKey), true);
});

test('keeps a shared photo when deleting one of its records', async () => {
  const sharedKey = 'photos/secure/shared.webp';
  const r2 = createR2({
    'data/entries.json': {
      body: JSON.stringify({ entries: [
        { id: 'first', name: '一つ目', photo: `/${sharedKey}` },
        { id: 'second', name: '二つ目', photo: `/${sharedKey}` },
      ] }),
      contentType: 'application/json',
    },
    [sharedKey]: { body: new Uint8Array([0x57, 0x45, 0x42, 0x50]), contentType: 'image/webp' },
  });

  const response = await worker.fetch(new Request('https://example.test/api/entries/first', {
    method: 'DELETE',
    headers: { ...(await sessionHeaders()), origin: 'https://example.test' },
  }), { ...assetEnv(), PHOTOS: r2, IMAGES: imageBinding() });
  const entries = JSON.parse(r2.text('data/entries.json')).entries;

  assert.equal(response.status, 200);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'second');
  assert.equal(r2.has(sharedKey), true);
});

test('prepares, verifies, then separately finalizes legacy-photo removal including orphan originals', async () => {
  const originalEntry = {
    id: 'legacy-entry',
    date: '2026-08-01',
    name: '昔のスイーツ',
    photo: '/photos/legacy.jpg',
  };
  const r2 = createR2({
    'data/entries.json': { body: JSON.stringify({ entries: [originalEntry] }), contentType: 'application/json' },
    'photos/legacy.jpg': { body: new Uint8Array([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' },
    'photos/orphan.jpg': { body: new Uint8Array([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' },
    'photos/secure/orphan.jpg': { body: new Uint8Array([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' },
  });
  const env = {
    ...assetEnv(),
    PHOTO_MIGRATION_TOKEN: 'migration-token',
    PHOTOS: r2,
    IMAGES: imageBinding(),
  };
  const prepare = await worker.fetch(new Request('https://example.test/api/admin/sanitize-existing-photos', {
    method: 'POST',
    headers: {
      ...(await sessionHeaders()),
      origin: 'https://example.test',
      'x-photo-migration-token': 'migration-token',
    },
  }), env);
  const prepared = await prepare.json();
  const entries = JSON.parse(r2.text('data/entries.json'));
  const newPhotoKey = entries.entries[0].photo.slice(1);

  assert.equal(prepare.status, 200);
  assert.equal(prepared.phase, 'ready_to_finalize');
  assert.equal(r2.has('photos/legacy.jpg'), true);
  assert.match(newPhotoKey, /^photos\/secure\/migrated-.+\.webp$/);
  assert.equal(r2.contentType(newPhotoKey), 'image/webp');
  assert.equal(JSON.parse(r2.text('data/photo-sanitization-manifest.json')).status, 'entries_switched');
  assert.equal(r2.keys().some((key) => key.startsWith('data/backups/entries-before-photo-sanitization-')), true);

  const finalize = await worker.fetch(new Request('https://example.test/api/admin/finalize-photo-sanitization', {
    method: 'POST',
    headers: {
      ...(await sessionHeaders()),
      origin: 'https://example.test',
      'x-photo-migration-token': 'migration-token',
    },
  }), env);
  const finalized = await finalize.json();

  assert.equal(finalize.status, 200);
  assert.equal(finalized.deleted_legacy_photos, 3);
  assert.equal(r2.has('photos/legacy.jpg'), false);
  assert.equal(r2.has('photos/orphan.jpg'), false);
  assert.equal(r2.has('photos/secure/orphan.jpg'), false);
  assert.equal(JSON.parse(r2.text('data/photo-sanitization-manifest.json')).status, 'complete');
});

test('recovers a prepared manifest after the entries switch succeeds but its status update fails', async () => {
  const originalEntry = { id: 'legacy-entry', photo: '/photos/legacy.jpg' };
  const r2 = createR2({
    'data/entries.json': { body: JSON.stringify({ entries: [originalEntry] }), contentType: 'application/json' },
    'photos/legacy.jpg': { body: new Uint8Array([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' },
  });
  const env = {
    ...assetEnv(),
    PHOTO_MIGRATION_TOKEN: 'migration-token',
    PHOTOS: r2,
    IMAGES: imageBinding(),
  };
  r2.failPutOn('data/photo-sanitization-manifest.json', 2);
  const request = new Request('https://example.test/api/admin/sanitize-existing-photos', {
    method: 'POST',
    headers: {
      ...(await sessionHeaders()),
      origin: 'https://example.test',
      'x-photo-migration-token': 'migration-token',
    },
  });

  const interrupted = await worker.fetch(request, env);
  assert.equal(interrupted.status, 500);
  assert.equal(JSON.parse(r2.text('data/photo-sanitization-manifest.json')).status, 'prepared');
  assert.match(JSON.parse(r2.text('data/entries.json')).entries[0].photo, /^\/photos\/secure\//);
  assert.equal(r2.has('photos/legacy.jpg'), true);

  const recovered = await worker.fetch(request, env);
  const result = await recovered.json();
  assert.equal(recovered.status, 200);
  assert.equal(result.phase, 'ready_to_finalize');
  assert.equal(JSON.parse(r2.text('data/photo-sanitization-manifest.json')).status, 'entries_switched');
  assert.equal(r2.has('photos/legacy.jpg'), true);
});
