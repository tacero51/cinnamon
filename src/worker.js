// シナモン/ミッフィー スイーツ日記 - Cloudflare Worker
// 静的アセットを配信しつつ、/api/* と /photos/* を動的に処理する。
// 写真は必ずWebPへ再エンコードしてからR2へ保存するため、原本のEXIFは保存しない。

const ENTRIES_KEY = 'data/entries.json';
const PHOTO_MIGRATION_MANIFEST_KEY = 'data/photo-sanitization-manifest.json';
const PHOTO_MIGRATION_LOCK_KEY = 'data/photo-sanitization.lock';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB（Images bindingの20MB上限より小さく保つ）
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const ALLOWED_WHERE_VALUES = new Set(['', 'おうち', 'おみせ', 'カフェ', 'おでかけ', 'そのほか']);
const SECURE_PHOTO_PREFIX = 'photos/secure/';
const PRIVATE_CACHE_CONTROL = 'private, no-store';
const SESSION_COOKIE_NAME = '__Host-cinnamon_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const MIGRATION_LOCK_DURATION_MS = 15 * 60 * 1000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const DEFAULT_ENTRIES = {
  entries: [
    {
      id: 'sample-1',
      date: '2026-05-15',
      emoji: '🍰',
      name: 'ショートケーキ',
      where: 'おうち',
      rating: 5,
      comment: 'いちごがあまくて、クリームがふわふわでとっても美味しかった！',
    },
    {
      id: 'sample-2',
      date: '2026-05-12',
      emoji: '🍫',
      name: 'チョコレートマフィン',
      where: 'カフェ',
      rating: 4,
      comment: '中にチョコチップがたくさん入ってて嬉しかった。',
    },
    {
      id: 'sample-3',
      date: '2026-05-08',
      emoji: '🍡',
      name: 'みたらしだんご',
      where: 'おうち',
      rating: 5,
      comment: 'あまじょっぱくて、もちもちでさいこう！',
    },
  ],
};

export default {
  async fetch(request, env) {
    // ログイン情報やCookieを平文HTTPへ送らせない。認証より先にHTTPSへ移す。
    const initialUrl = new URL(request.url);
    if (initialUrl.protocol === 'http:') return redirectToHttps(initialUrl);

    const url = initialUrl;
    if (!authenticationIsConfigured(env)) return authenticationUnavailable();

    // /login は、Password AutoFill が使える通常のHTMLフォームを返す。
    // この画面自身は未認証で到達可能だが、設定不足時は上で必ず閉じる。
    if (url.pathname === '/login') return await handleLogin(request, env, url);
    if (url.pathname === '/logout') return await handleLogout(request, url);

    // 署名済みセッションを、静的アセット・API・写真を含むすべてのルートより先に評価する。
    const authentication = await authenticateRequest(request, env);
    if (!authentication) return authenticationRequired(request, url);

    try {
      if (isStateChangingApiRequest(request, url) && !requestHasSameOrigin(request, url)) {
        return privateTextResponse('forbidden', 403);
      }
      // 既存写真を安全なWebPへ移行する一回限りの管理用エンドポイント。
      // ログイン済みセッションに加え、短命のPHOTO_MIGRATION_TOKENが必要。トークン削除後は404になる。
      if (url.pathname === '/api/admin/sanitize-existing-photos') {
        if (request.method !== 'POST') return methodNotAllowed();
        return await sanitizeExistingPhotos(request, env);
      }

      if (url.pathname === '/api/admin/finalize-photo-sanitization') {
        if (request.method !== 'POST') return methodNotAllowed();
        return await finalizeExistingPhotoSanitization(request, env);
      }

      // API routes
      if (url.pathname === '/api/entries') {
        if (request.method === 'GET') return await getEntries(env);
        if (request.method === 'POST') return await postEntry(request, env);
        return methodNotAllowed();
      }

      if (url.pathname.startsWith('/api/entries/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/entries/'.length));
        if (!id) return errorResponse(400, 'entry id required');
        if (request.method === 'PUT') return await putEntry(request, env, id);
        if (request.method === 'DELETE') return await deleteEntry(env, id);
        return methodNotAllowed();
      }

      // GPSを外部サービスへ送信していた逆ジオコーディングは、プライバシー保護のため廃止した。
      // 未定義のAPIパスを静的サイトのSPAフォールバックへ渡さない。
      if (url.pathname.startsWith('/api/')) return privateTextResponse('not found', 404);

      // Photo serving
      if (url.pathname.startsWith('/photos/')) {
        const key = url.pathname.slice(1); // remove leading /
        return await servePhoto(env, key);
      }

      // Static assets (HTML/CSS/JS)
      return privateResponse(await env.ASSETS.fetch(request));
    } catch (issue) {
      return responseForIssue(issue);
    }
  },
};

// ===== Authentication =====

async function authenticateRequest(request, env) {
  if (!authenticationIsConfigured(env)) return false;
  return validSessionFromRequest(request, env);
}

function authenticationIsConfigured(env) {
  // セッション署名鍵も必須にし、Cookie認証だけが無署名状態で動く事故を防ぐ。
  return Boolean(env.LOGIN_USERNAME && env.LOGIN_PASSWORD && env.SESSION_SIGNING_KEY);
}

async function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let i = 0; i < leftBytes.length; i += 1) difference |= leftBytes[i] ^ rightBytes[i];
  return difference === 0;
}

function authenticationRequired(request, url) {
  // APIや写真にWWW-Authenticateを付けると、画像の読み込みなどでiOSのネイティブ
  // Basic promptが再表示されるため、ここではフォームへ飛ばさず通常の401にする。
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/photos/') || !isHtmlNavigation(request, url)) {
    return privateTextResponse('authentication required', 401);
  }
  return redirectToLogin(url);
}

function isHtmlNavigation(request, url) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  if (url.pathname === '/' || url.pathname.endsWith('/')) return true;
  const lastSegment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  // CSS/JS/画像など拡張子を持つ静的assetは、Acceptを偽装されてもログイン画面へ
  // リダイレクトせず401にする。SPAの画面パスと明示的なHTMLだけをナビゲーションとみなす。
  return !lastSegment.includes('.') || lastSegment.endsWith('.html');
}

function isStateChangingApiRequest(request, url) {
  return url.pathname.startsWith('/api/') && ['POST', 'PUT', 'DELETE'].includes(request.method);
}

function requestHasSameOrigin(request, url) {
  return request.headers.get('origin') === url.origin;
}

function authenticationUnavailable() {
  return new Response('authentication is not configured', {
    status: 503,
    headers: privateHeaders(),
  });
}

function redirectToHttps(url) {
  const secureUrl = new URL(url);
  secureUrl.protocol = 'https:';
  return new Response(null, {
    status: 308,
    headers: privateHeaders({ location: secureUrl.toString() }),
  });
}

function redirectToLogin(url) {
  const loginUrl = new URL('/login', url.origin);
  const next = safeNextPath(`${url.pathname}${url.search}`);
  if (next !== '/') loginUrl.searchParams.set('next', next);
  return new Response(null, {
    status: 302,
    headers: privateHeaders({ location: loginUrl.toString() }),
  });
}

async function handleLogin(request, env, url) {
  const next = safeNextPath(url.searchParams.get('next'));
  if (request.method === 'GET') {
    // 既存セッション中にログイン画面を開いた場合も、同じ安全な行き先へ戻す。
    if (await validSessionFromRequest(request, env)) return redirectAfterLogin(url, next);
    return loginForm(next);
  }
  if (request.method !== 'POST') return methodNotAllowed();
  if (!requestHasSameOrigin(request, url)) return privateTextResponse('forbidden', 403);

  let form;
  try {
    form = await request.formData();
  } catch {
    return loginForm(next, '入力を読み取れませんでした。もう一度ためしてね。', 400);
  }

  const username = String(form.get('username') || '');
  const password = String(form.get('password') || '');
  const requestedNext = safeNextPath(String(form.get('next') || next));
  const valid = await constantTimeEqual(`${username}\u0000${password}`, `${env.LOGIN_USERNAME}\u0000${env.LOGIN_PASSWORD}`);
  if (!valid) return loginForm(next, 'ユーザー名かパスワードがちがいます。', 401);

  const value = await createSessionValue(env);
  const response = redirectAfterLogin(url, requestedNext);
  response.headers.append('set-cookie', sessionCookie(value));
  return response;
}

async function handleLogout(request, url) {
  if (request.method !== 'POST') return methodNotAllowed();
  if (!requestHasSameOrigin(request, url)) return privateTextResponse('forbidden', 403);
  const response = new Response(null, {
    status: 303,
    headers: privateHeaders({ location: new URL('/login', url.origin).toString() }),
  });
  response.headers.append('set-cookie', expiredSessionCookie());
  return response;
}

function redirectAfterLogin(url, next) {
  return new Response(null, {
    status: 303,
    headers: privateHeaders({ location: new URL(next, url.origin).toString() }),
  });
}

function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || containsEncodedPathSeparator(value) || value.includes('\\')) return '/';
  try {
    const candidate = new URL(value, 'https://cinnamon.invalid');
    // URLの解釈で外部originになる入力はすべて捨てる。/loginへの循環も避ける。
    if (candidate.origin !== 'https://cinnamon.invalid' || candidate.pathname === '/login') return '/';
    return `${candidate.pathname}${candidate.search}`;
  } catch {
    return '/';
  }
}

function containsEncodedPathSeparator(value) {
  let candidate = value;
  // 二重エンコードされた/%252fのような入力も、将来どこかでdecodeされた時に
  // 外部URL扱いへ変化しないよう、少数回のdecode後まで拒否する。
  for (let depth = 0; depth < 4; depth += 1) {
    if (/%(?:2f|5c)/i.test(candidate)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return /%(?:2f|5c)/i.test(candidate) || candidate.includes('\\');
}

function loginForm(next, error = '', status = 200) {
  const safeNext = safeNextPath(next);
  const errorMarkup = error ? `<p role="alert">${escapeHtml(error)}</p>` : '';
  return new Response(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>シナモンにログイン</title></head>
<body><main><h1>シナモンにログイン</h1>${errorMarkup}
<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(safeNext)}">
<label>ユーザー名 <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
<label>パスワード <input type="password" name="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" required></label>
<button type="submit">ログイン</button></form></main></body></html>`, {
    status,
    headers: privateHeaders({ 'content-type': 'text/html; charset=utf-8' }),
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

async function createSessionValue(env, now = Date.now()) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, iat: now, exp: now + SESSION_MAX_AGE_MS })));
  const signature = await signSessionPayload(payload, env);
  return `${payload}.${signature}`;
}

async function validSessionFromRequest(request, env, now = Date.now()) {
  const value = cookieValue(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  const expectedSignature = await signSessionPayload(parts[0], env);
  if (!(await constantTimeEqual(parts[1], expectedSignature))) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    return payload?.v === 1
      && Number.isSafeInteger(payload.iat)
      && Number.isSafeInteger(payload.exp)
      && payload.iat <= now
      && payload.exp > now
      && payload.exp > payload.iat
      && payload.exp - payload.iat <= SESSION_MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function signSessionPayload(payload, env) {
  // 現在のID/PWも署名コンテキストに含める。パスワードを変えると既発行Cookieは即座に無効になる。
  const material = `${env.SESSION_SIGNING_KEY}\u0000${env.LOGIN_USERNAME}\u0000${env.LOGIN_PASSWORD}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

function cookieValue(header, name) {
  if (!header) return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      if (found !== null) return null;
      found = part.slice(separator + 1).trim();
    }
  }
  return found;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sessionCookie(value) {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Strict`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

// ===== Entries =====

async function getEntries(env) {
  const data = await readEntries(env);
  return json(data);
}

async function postEntry(request, env) {
  if (await writesAreBlocked(env)) return migrationInProgressResponse();

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return errorResponse(400, 'Content-Type must be multipart/form-data');
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'invalid form data');
  }

  let fields;
  try {
    fields = entryFieldsFromForm(form);
  } catch (issue) {
    return responseForIssue(issue);
  }

  const entry = {
    id: `${Date.now()}-${randomId(4)}`,
    date: validDateOrToday(form.get('date')),
    emoji: fields.emoji,
    name: fields.name,
    where: fields.where || undefined,
    rating: fields.rating || undefined,
    comment: fields.comment || undefined,
    created_at: new Date().toISOString(),
  };

  let storedPhotoKey = null;
  let entriesWritten = false;
  try {
    const photo = form.get('photo');
    if (isUploadedPhoto(photo)) {
      validatePhoto(photo);
      storedPhotoKey = newSecurePhotoKey();
      entry.photo = await sanitizeAndStorePhoto(env, photo.stream(), storedPhotoKey);
    }

    const data = await readEntries(env);
    data.entries.unshift(entry); // 最新を先頭に
    if (await writesAreBlocked(env)) throw new RequestIssue(503, 'photo maintenance is in progress; try again shortly');
    await writeEntries(env, data);
    entriesWritten = true;
    return json({ ok: true, entry });
  } catch (issue) {
    if (!entriesWritten && storedPhotoKey) await deletePhotoSafely(env, storedPhotoKey);
    return responseForIssue(issue);
  }
}

async function putEntry(request, env, id) {
  if (await writesAreBlocked(env)) return migrationInProgressResponse();

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return errorResponse(400, 'Content-Type must be multipart/form-data');
  }

  const data = await readEntries(env);
  const idx = data.entries.findIndex((entry) => entry.id === id);
  if (idx < 0) return errorResponse(404, 'entry not found');
  const existing = data.entries[idx];

  let form;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'invalid form data');
  }

  let fields;
  try {
    fields = entryFieldsFromForm(form);
  } catch (issue) {
    return responseForIssue(issue);
  }

  const photo = form.get('photo');
  const removePhoto = form.get('remove_photo') === '1';
  const oldPhotoKey = photoKeyFromUrl(existing.photo);
  let storedPhotoKey = null;
  let photoUrl = existing.photo;
  let entriesWritten = false;

  try {
    if (isUploadedPhoto(photo)) {
      validatePhoto(photo);
      storedPhotoKey = newSecurePhotoKey();
      photoUrl = await sanitizeAndStorePhoto(env, photo.stream(), storedPhotoKey);
    } else if (removePhoto) {
      photoUrl = undefined;
    }

    data.entries[idx] = {
      ...existing,
      date: validDateOrExisting(form.get('date'), existing.date),
      name: fields.name,
      emoji: fields.emoji,
      where: fields.where || undefined,
      rating: fields.rating || undefined,
      comment: fields.comment || undefined,
      photo: photoUrl || undefined,
      updated_at: new Date().toISOString(),
    };

    if (await writesAreBlocked(env)) throw new RequestIssue(503, 'photo maintenance is in progress; try again shortly');
    await writeEntries(env, data);
    entriesWritten = true;

    // 新しいentries.jsonが保存されてから、他の記録が参照していない旧写真だけを削除する。
    if (oldPhotoKey && oldPhotoKey !== storedPhotoKey && (storedPhotoKey || removePhoto)) {
      await deletePhotoIfUnreferenced(env, data.entries, oldPhotoKey);
    }

    return json({ ok: true, entry: data.entries[idx] });
  } catch (issue) {
    if (!entriesWritten && storedPhotoKey) await deletePhotoSafely(env, storedPhotoKey);
    return responseForIssue(issue);
  }
}

async function deleteEntry(env, id) {
  if (await writesAreBlocked(env)) return migrationInProgressResponse();

  const data = await readEntries(env);
  const idx = data.entries.findIndex((entry) => entry.id === id);
  if (idx < 0) return errorResponse(404, 'entry not found');
  const entry = data.entries[idx];
  const photoKey = photoKeyFromUrl(entry.photo);

  data.entries.splice(idx, 1);
  try {
    if (await writesAreBlocked(env)) return migrationInProgressResponse();
    await writeEntries(env, data);
  } catch (issue) {
    return responseForIssue(issue);
  }

  // 記録の削除が保存できた後に、他の記録が参照していない写真だけを削除する。
  // 失敗しても孤立ファイルになるだけで記録は失わない。
  if (photoKey) await deletePhotoIfUnreferenced(env, data.entries, photoKey);
  return json({ ok: true });
}

function entryFieldsFromForm(form) {
  const name = (form.get('name') || '').toString().trim();
  if (name.length > 50) throw new RequestIssue(400, 'name too long (max 50)');

  const comment = (form.get('comment') || '').toString().trim();
  if (comment.length > 300) throw new RequestIssue(400, 'comment too long (max 300)');

  const where = (form.get('where') || '').toString().trim();
  if (!ALLOWED_WHERE_VALUES.has(where)) throw new RequestIssue(400, 'where is not allowed');

  const ratingRaw = (form.get('rating') || '0').toString();
  const rating = Math.max(0, Math.min(5, parseInt(ratingRaw, 10) || 0));

  const emoji = (form.get('emoji') || '🍰').toString().slice(0, 4);
  return { name, comment, where, rating, emoji };
}

function validDateOrToday(value) {
  const date = (value || '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
}

function validDateOrExisting(value, existing) {
  const date = (value || '').toString().trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : existing;
}

async function readEntries(env) {
  const obj = await env.PHOTOS.get(ENTRIES_KEY);
  if (!obj) {
    // 初回: デフォルトを書き込んで返す
    const initialEntries = cloneDefaultEntries();
    await writeEntries(env, initialEntries);
    return initialEntries;
  }
  try {
    const data = JSON.parse(await obj.text());
    if (!Array.isArray(data.entries)) throw new Error('entries array is missing');
    return data;
  } catch {
    // 壊れた正本をサンプルデータで上書きしない。親がR2バックアップから復旧できるよう止める。
    throw new RequestIssue(500, 'entries data could not be read safely');
  }
}

function cloneDefaultEntries() {
  return JSON.parse(JSON.stringify(DEFAULT_ENTRIES));
}

async function writeEntries(env, data) {
  await env.PHOTOS.put(ENTRIES_KEY, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

// ===== Photo storage =====

function isUploadedPhoto(photo) {
  return photo && typeof photo !== 'string' && photo.size > 0;
}

function validatePhoto(photo) {
  if (photo.size > MAX_PHOTO_BYTES) {
    throw new RequestIssue(413, `photo too large (max ${MAX_PHOTO_BYTES} bytes)`);
  }
  if (!ALLOWED_PHOTO_TYPES.includes(photo.type)) {
    throw new RequestIssue(415, 'photo must be JPEG, PNG, WebP, or HEIC');
  }
}

function newSecurePhotoKey() {
  return `${SECURE_PHOTO_PREFIX}${Date.now()}-${randomId(12)}.webp`;
}

async function sanitizeAndStorePhoto(env, sourceStream, key) {
  if (!env.IMAGES || typeof env.IMAGES.input !== 'function') {
    throw new RequestIssue(503, 'photo processing is unavailable');
  }

  let transformed;
  try {
    const output = await env.IMAGES
      .input(sourceStream)
      .output({ format: 'image/webp', quality: 85, anim: false });
    transformed = await output.response();
  } catch (error) {
    // 画像本体や記録内容は出さず、Cloudflare側の障害調査に必要な短い診断だけをログへ残す。
    const message = error instanceof Error ? error.message : 'unknown transformation error';
    console.warn('cinnamon image transformation threw', message.slice(0, 200));
    throw new RequestIssue(422, 'photo could not be processed safely');
  }

  const contentType = transformed.headers.get('content-type') || '';
  if (!transformed.ok || !transformed.body || !contentType.startsWith('image/webp')) {
    const details = transformed.ok
      ? ''
      : (await transformed.text()).replace(/[\r\n]+/g, ' ').slice(0, 200);
    console.warn('cinnamon image transformation returned an invalid response', {
      status: transformed.status,
      contentType,
      cfResized: transformed.headers.get('cf-resized') || undefined,
      details,
    });
    throw new RequestIssue(422, 'photo could not be processed safely');
  }

  try {
    await env.PHOTOS.put(key, transformed.body, {
      httpMetadata: { contentType: 'image/webp' },
    });
  } catch {
    throw new RequestIssue(500, 'photo could not be saved');
  }

  if (!(await verifyStoredWebP(env, key))) {
    await deletePhotoSafely(env, key);
    throw new RequestIssue(500, 'photo could not be verified');
  }

  return `/${key}`;
}

async function verifyStoredWebP(env, key) {
  if (!env.IMAGES || typeof env.IMAGES.info !== 'function') return false;
  try {
    const stored = await env.PHOTOS.head(key);
    if (!stored || stored.httpMetadata?.contentType !== 'image/webp') return false;

    const object = await env.PHOTOS.get(key);
    if (!object?.body) return false;
    const info = await env.IMAGES.info(object.body);
    const format = String(info?.format || '').toLowerCase().replace(/^image\//, '');
    return format === 'webp'
      && Number.isFinite(info?.width) && info.width > 0
      && Number.isFinite(info?.height) && info.height > 0;
  } catch {
    return false;
  }
}

async function servePhoto(env, key) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return privateTextResponse('not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  applyPrivateSecurityHeaders(headers);
  return new Response(obj.body, { headers });
}

function photoKeyFromUrl(photoUrl) {
  if (typeof photoUrl !== 'string' || !photoUrl.startsWith('/photos/')) return null;
  const key = photoUrl.slice(1);
  return key.startsWith('photos/') ? key : null;
}

function isSanitizedPhotoKey(key) {
  return typeof key === 'string' && key.startsWith(SECURE_PHOTO_PREFIX) && key.endsWith('.webp');
}

async function deletePhotoSafely(env, key) {
  try {
    await env.PHOTOS.delete(key);
  } catch {
    // 参照先を先に安全に切り替えた後の削除失敗は、データ消失より安全な孤立ファイルとして扱う。
  }
}

async function deletePhotoIfUnreferenced(env, entries, key) {
  const stillReferenced = entries.some((entry) => photoKeyFromUrl(entry.photo) === key);
  if (!stillReferenced) await deletePhotoSafely(env, key);
}

// ===== Existing-photo migration =====

async function sanitizeExistingPhotos(request, env) {
  if (!(await migrationRequestIsAuthorized(request, env))) return privateTextResponse('not found', 404);
  if (!(await acquirePhotoMigrationLock(env))) return errorResponse(409, 'photo migration is already in progress');

  try {
    const existingManifest = await readMigrationManifest(env);
    if (existingManifest) assertMigrationManifest(existingManifest);

    if (existingManifest?.status === 'complete') {
      return json({ ok: true, already_complete: true, migrated: existingManifest.items.length });
    }
    if (existingManifest?.status === 'entries_switched') {
      return migrationReadyToFinalize(existingManifest);
    }
    if (existingManifest?.status === 'prepared') {
      return await resumePreparedPhotoMigration(env, existingManifest);
    }

    const data = await readEntriesForMigration(env);
    assertUniqueEntryIds(data.entries);
    const itemsByOldKey = new Map();

    for (const entry of data.entries) {
      const oldKey = photoKeyFromUrl(entry.photo);
      if (!oldKey || isSanitizedPhotoKey(oldKey)) continue;

      let item = itemsByOldKey.get(oldKey);
      if (!item) {
        const newKey = await migratedPhotoKey(oldKey);
        if (!(await verifyStoredWebP(env, newKey))) {
          const source = await env.PHOTOS.get(oldKey);
          if (!source) throw new RequestIssue(404, 'an existing photo could not be found');
          await sanitizeAndStorePhoto(env, source.body, newKey);
        }
        if (!(await verifyStoredWebP(env, newKey))) {
          throw new RequestIssue(500, 'a sanitized photo could not be verified');
        }
        item = { old_key: oldKey, new_key: newKey, entry_ids: [] };
        itemsByOldKey.set(oldKey, item);
      }
      item.entry_ids.push(entry.id);
    }

    const items = [...itemsByOldKey.values()];
    const backupKey = `data/backups/entries-before-photo-sanitization-${safeTimestamp()}.json`;
    await env.PHOTOS.put(backupKey, JSON.stringify(data, null, 2), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    const manifest = {
      version: 2,
      status: items.length === 0 ? 'entries_switched' : 'prepared',
      created_at: new Date().toISOString(),
      backup_key: backupKey,
      items,
    };
    if (manifest.status === 'entries_switched') manifest.entries_switched_at = new Date().toISOString();
    await writeMigrationManifest(env, manifest);

    if (manifest.status === 'entries_switched') return migrationReadyToFinalize(manifest);
    return await resumePreparedPhotoMigration(env, manifest);
  } catch (issue) {
    return responseForIssue(issue);
  } finally {
    await deletePhotoSafely(env, PHOTO_MIGRATION_LOCK_KEY);
  }
}

async function resumePreparedPhotoMigration(env, manifest) {
  await assertPreparedTargetsAreSafe(env, manifest);
  const data = await readEntriesForMigration(env);
  const entryState = migrationEntryState(data, manifest);

  if (entryState === 'legacy') {
    await assertLegacySourcesExist(env, manifest);
    const photoByOldKey = new Map(manifest.items.map((item) => [item.old_key, `/${item.new_key}`]));
    const migratedData = {
      ...data,
      entries: data.entries.map((entry) => {
        const oldKey = photoKeyFromUrl(entry.photo);
        return oldKey && photoByOldKey.has(oldKey)
          ? { ...entry, photo: photoByOldKey.get(oldKey) }
          : entry;
      }),
    };
    await writeEntries(env, migratedData);

    const reloadedData = await readEntriesForMigration(env);
    if (migrationEntryState(reloadedData, manifest) !== 'entries_switched') {
      throw new RequestIssue(500, 'entries could not be switched safely');
    }
  } else if (entryState !== 'entries_switched') {
    throw new RequestIssue(500, 'photo migration has an invalid entry state');
  }

  // entries.jsonを再読込して確認してから状態を更新する。ここで失敗してもpreparedが残り、
  // 次回はentries_switched状態を検出して安全に再開できる。
  manifest.status = 'entries_switched';
  manifest.entries_switched_at = manifest.entries_switched_at || new Date().toISOString();
  await writeMigrationManifest(env, manifest);
  return migrationReadyToFinalize(manifest);
}

async function finalizeExistingPhotoSanitization(request, env) {
  if (!(await migrationRequestIsAuthorized(request, env))) return privateTextResponse('not found', 404);
  if (!(await acquirePhotoMigrationLock(env))) return errorResponse(409, 'photo migration is already in progress');

  try {
    const manifest = await readMigrationManifest(env);
    if (!manifest) return errorResponse(409, 'photo migration has not been prepared');
    assertMigrationManifest(manifest);
    if (manifest.status === 'complete') {
      return json({ ok: true, already_complete: true, migrated: manifest.items.length });
    }
    if (manifest.status !== 'entries_switched') {
      return errorResponse(409, 'photo migration is not ready to finalize');
    }

    await assertPreparedTargetsAreSafe(env, manifest);
    const data = await readEntriesForMigration(env);
    if (migrationEntryState(data, manifest) !== 'entries_switched') {
      throw new RequestIssue(500, 'entries are not safely switched to sanitized photos');
    }
    assertNoLegacyPhotoReferences(data.entries);

    const cleanup = await deleteAllLegacyPhotoObjects(env);
    manifest.delete_failures = cleanup.remaining_legacy_keys;
    manifest.deleted_legacy_photos = cleanup.deleted_legacy_photos;
    if (cleanup.remaining_legacy_keys.length > 0) {
      await writeMigrationManifest(env, manifest);
      return json({
        ok: false,
        migrated: manifest.items.length,
        deleted_legacy_photos: cleanup.deleted_legacy_photos,
        delete_failures: cleanup.remaining_legacy_keys.length,
      }, 500);
    }

    manifest.status = 'complete';
    manifest.completed_at = new Date().toISOString();
    await writeMigrationManifest(env, manifest);
    return json({
      ok: true,
      migrated: manifest.items.length,
      deleted_legacy_photos: cleanup.deleted_legacy_photos,
      delete_failures: 0,
    });
  } catch (issue) {
    return responseForIssue(issue);
  } finally {
    await deletePhotoSafely(env, PHOTO_MIGRATION_LOCK_KEY);
  }
}

function migrationReadyToFinalize(manifest) {
  return json({
    ok: true,
    phase: 'ready_to_finalize',
    migrated: manifest.items.length,
    message: 'sanitized photos are ready; verify them before finalizing legacy-photo deletion',
  });
}

async function readEntriesForMigration(env) {
  const obj = await env.PHOTOS.get(ENTRIES_KEY);
  if (!obj) throw new RequestIssue(500, 'entries data is missing; photo migration stopped');
  try {
    const data = JSON.parse(await obj.text());
    if (!Array.isArray(data.entries)) throw new Error('entries array is missing');
    return data;
  } catch {
    throw new RequestIssue(500, 'entries data could not be read safely; photo migration stopped');
  }
}

function assertMigrationManifest(manifest) {
  if (manifest.version !== 2 || !['prepared', 'entries_switched', 'complete'].includes(manifest.status)
    || !Array.isArray(manifest.items)) {
    throw new RequestIssue(500, 'photo migration manifest is invalid');
  }
  for (const item of manifest.items) {
    if (!item || typeof item.old_key !== 'string' || typeof item.new_key !== 'string'
      || !item.old_key.startsWith('photos/') || !isSanitizedPhotoKey(item.new_key)
      || !Array.isArray(item.entry_ids) || item.entry_ids.length === 0
      || item.entry_ids.some((id) => typeof id !== 'string' || !id)) {
      throw new RequestIssue(500, 'photo migration manifest is invalid');
    }
  }
}

function assertUniqueEntryIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || !entry.id || ids.has(entry.id)) {
      throw new RequestIssue(500, 'entries have invalid or duplicate ids; photo migration stopped');
    }
    ids.add(entry.id);
  }
}

function migrationEntryState(data, manifest) {
  assertUniqueEntryIds(data.entries);
  const entriesById = new Map(data.entries.map((entry) => [entry.id, entry]));
  let legacyCount = 0;
  let switchedCount = 0;

  for (const item of manifest.items) {
    for (const entryId of item.entry_ids) {
      const entry = entriesById.get(entryId);
      const photoKey = photoKeyFromUrl(entry?.photo);
      if (photoKey === item.old_key) legacyCount += 1;
      else if (photoKey === item.new_key) switchedCount += 1;
      else throw new RequestIssue(500, 'entries changed during photo migration; cleanup stopped');
    }
  }

  if (legacyCount > 0 && switchedCount === 0) return 'legacy';
  if (switchedCount > 0 && legacyCount === 0) return 'entries_switched';
  if (legacyCount === 0 && switchedCount === 0 && manifest.items.length === 0) return 'entries_switched';
  throw new RequestIssue(500, 'entries are only partially switched; cleanup stopped');
}

async function assertPreparedTargetsAreSafe(env, manifest) {
  for (const item of manifest.items) {
    if (!(await verifyStoredWebP(env, item.new_key))) {
      throw new RequestIssue(500, 'a sanitized photo could not be verified');
    }
  }
}

async function assertLegacySourcesExist(env, manifest) {
  for (const item of manifest.items) {
    if (!(await env.PHOTOS.head(item.old_key))) {
      throw new RequestIssue(500, 'an original photo is missing; photo migration stopped');
    }
  }
}

function assertNoLegacyPhotoReferences(entries) {
  const legacyReference = entries.some((entry) => {
    const key = photoKeyFromUrl(entry.photo);
    return key && !isSanitizedPhotoKey(key);
  });
  if (legacyReference) throw new RequestIssue(500, 'legacy photos are still referenced; cleanup stopped');
}

async function deleteAllLegacyPhotoObjects(env) {
  const legacyKeys = (await listPhotoKeys(env)).filter((key) => !isSanitizedPhotoKey(key));
  let deletedLegacyPhotos = 0;
  for (const key of legacyKeys) {
    try {
      await env.PHOTOS.delete(key);
      deletedLegacyPhotos += 1;
    } catch {
      // 再実行時に同じprefixを再走査して安全に後片付けする。
    }
  }
  const remainingLegacyKeys = (await listPhotoKeys(env)).filter((key) => !isSanitizedPhotoKey(key));
  return { deleted_legacy_photos: deletedLegacyPhotos, remaining_legacy_keys: remainingLegacyKeys };
}

async function listPhotoKeys(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: 'photos/', cursor });
    for (const object of page.objects || []) keys.push(object.key);
    if (!page.truncated) return keys;
    if (!page.cursor) throw new RequestIssue(500, 'photo listing could not be completed safely');
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

async function migrationRequestIsAuthorized(request, env) {
  const expectedToken = env.PHOTO_MIGRATION_TOKEN;
  if (!expectedToken) return false;
  const suppliedToken = request.headers.get('x-photo-migration-token');
  if (!suppliedToken) return false;
  return constantTimeEqual(suppliedToken, expectedToken);
}

async function readMigrationManifest(env) {
  const obj = await env.PHOTOS.get(PHOTO_MIGRATION_MANIFEST_KEY);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    throw new RequestIssue(500, 'photo migration manifest could not be read safely');
  }
}

async function writeMigrationManifest(env, manifest) {
  await env.PHOTOS.put(PHOTO_MIGRATION_MANIFEST_KEY, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

async function migratedPhotoKey(oldKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldKey)));
  const suffix = Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${SECURE_PHOTO_PREFIX}migrated-${suffix}.webp`;
}

async function photoMigrationIsActive(env) {
  const lock = await env.PHOTOS.get(PHOTO_MIGRATION_LOCK_KEY);
  if (!lock) return false;
  try {
    const data = JSON.parse(await lock.text());
    if (Date.parse(data.expires_at) > Date.now()) return true;
  } catch {
    return true;
  }
  await deletePhotoSafely(env, PHOTO_MIGRATION_LOCK_KEY);
  return false;
}

async function writesAreBlocked(env) {
  // 移行トークンをセットしている間は、準備・検証・削除まで通常の記録更新を止める。
  // これにより、entries.jsonを切り替える間に通常更新が競合することを防ぐ。
  return Boolean(env.PHOTO_MIGRATION_TOKEN) || photoMigrationIsActive(env);
}

async function acquirePhotoMigrationLock(env) {
  if (await photoMigrationIsActive(env)) return false;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MIGRATION_LOCK_DURATION_MS);
  await env.PHOTOS.put(PHOTO_MIGRATION_LOCK_KEY, JSON.stringify({
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return true;
}

function migrationInProgressResponse() {
  return errorResponse(503, 'photo maintenance is in progress; try again shortly');
}

// ===== Helpers =====

class RequestIssue extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: privateHeaders({
      'content-type': 'application/json; charset=utf-8',
    }),
  });
}

function errorResponse(status, message) {
  return json({ ok: false, error: message }, status);
}

function responseForIssue(issue) {
  if (issue instanceof RequestIssue) return errorResponse(issue.status, issue.message);
  return errorResponse(500, 'an unexpected error occurred');
}

function methodNotAllowed() {
  return privateTextResponse('method not allowed', 405);
}

function privateTextResponse(text, status) {
  return new Response(text, {
    status,
    headers: privateHeaders(),
  });
}

function privateResponse(response) {
  const headers = new Headers(response.headers);
  applyPrivateSecurityHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function privateHeaders(initialHeaders = {}) {
  const headers = new Headers(initialHeaders);
  applyPrivateSecurityHeaders(headers);
  return headers;
}

function applyPrivateSecurityHeaders(headers) {
  headers.set('cache-control', PRIVATE_CACHE_CONTROL);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
  headers.set('permissions-policy', 'geolocation=(), camera=(), microphone=()');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('strict-transport-security', 'max-age=31536000');
  headers.set('x-frame-options', 'DENY');
}

function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i += 1) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[.:]/g, '-');
}
