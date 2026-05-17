// シナモン/ミッフィー スイーツ日記 - Cloudflare Worker
// 静的アセットを配信しつつ、/api/* と /photos/* を動的に処理する

const ENTRIES_KEY = 'data/entries.json';
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];

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
      where: 'おばあちゃんち',
      rating: 5,
      comment: 'あまじょっぱくて、もちもちでさいこう！',
    },
  ],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes
    if (url.pathname === '/api/entries') {
      if (request.method === 'GET') return getEntries(env);
      if (request.method === 'POST') return postEntry(request, env);
      return methodNotAllowed();
    }

    if (url.pathname.startsWith('/api/entries/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/entries/'.length));
      if (!id) return error(400, 'entry id required');
      if (request.method === 'PUT') return putEntry(request, env, id);
      if (request.method === 'DELETE') return deleteEntry(env, id);
      return methodNotAllowed();
    }

    // 逆ジオコーディング: GPS座標 → 市区町村レベルの地名
    if (url.pathname === '/api/geocode') {
      if (request.method !== 'GET') return methodNotAllowed();
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if (isNaN(lat) || isNaN(lon)) return error(400, 'lat and lon required');
      return geocodeReverse(lat, lon);
    }

    // Photo serving
    if (url.pathname.startsWith('/photos/')) {
      const key = url.pathname.slice(1); // remove leading /
      return servePhoto(env, key);
    }

    // Static assets (HTML/CSS/JS)
    return env.ASSETS.fetch(request);
  },
};

// ===== Entries =====

async function getEntries(env) {
  const data = await readEntries(env);
  return json(data);
}

async function postEntry(request, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return error(400, 'Content-Type must be multipart/form-data');
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return error(400, 'invalid form data');
  }

  const name = (form.get('name') || '').toString().trim();
  if (name.length > 50) return error(400, 'name too long (max 50)');

  const comment = (form.get('comment') || '').toString().trim();
  if (comment.length > 300) return error(400, 'comment too long (max 300)');

  const where = (form.get('where') || '').toString().trim();
  if (where.length > 50) return error(400, 'where too long (max 50)');

  const ratingRaw = (form.get('rating') || '0').toString();
  const rating = Math.max(0, Math.min(5, parseInt(ratingRaw, 10) || 0));

  const emoji = (form.get('emoji') || '🍰').toString().slice(0, 4);

  // Photo (optional)
  let photoUrl = null;
  const photo = form.get('photo');
  if (photo && typeof photo !== 'string' && photo.size > 0) {
    if (photo.size > MAX_PHOTO_BYTES) {
      return error(413, `photo too large (max ${MAX_PHOTO_BYTES} bytes)`);
    }
    if (!ALLOWED_PHOTO_TYPES.includes(photo.type)) {
      return error(415, `photo type not allowed: ${photo.type}`);
    }
    const ext = photoExtension(photo.type);
    const key = `photos/${Date.now()}-${randomId(6)}.${ext}`;
    await env.PHOTOS.put(key, photo.stream(), {
      httpMetadata: { contentType: photo.type },
    });
    photoUrl = `/${key}`;
  }

  // 日付（任意。指定なければ今日。形式: YYYY-MM-DD）
  const dateRaw = (form.get('date') || '').toString().trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : new Date().toISOString().slice(0, 10);

  const entry = {
    id: `${Date.now()}-${randomId(4)}`,
    date,
    emoji,
    name,
    where: where || undefined,
    rating: rating || undefined,
    comment: comment || undefined,
    photo: photoUrl || undefined,
    created_at: new Date().toISOString(),
  };

  // Read-modify-write entries.json (concurrent writes are rare for this scale)
  const data = await readEntries(env);
  data.entries.unshift(entry); // 最新を先頭に
  await env.PHOTOS.put(ENTRIES_KEY, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return json({ ok: true, entry });
}

async function putEntry(request, env, id) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return error(400, 'Content-Type must be multipart/form-data');
  }

  const data = await readEntries(env);
  const idx = data.entries.findIndex((e) => e.id === id);
  if (idx < 0) return error(404, 'entry not found');
  const existing = data.entries[idx];

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return error(400, 'invalid form data');
  }

  const name = (form.get('name') || '').toString().trim();
  if (name.length > 50) return error(400, 'name too long (max 50)');

  const comment = (form.get('comment') || '').toString().trim();
  if (comment.length > 300) return error(400, 'comment too long (max 300)');

  const where = (form.get('where') || '').toString().trim();
  if (where.length > 50) return error(400, 'where too long (max 50)');

  const ratingRaw = (form.get('rating') || '0').toString();
  const rating = Math.max(0, Math.min(5, parseInt(ratingRaw, 10) || 0));

  const emoji = (form.get('emoji') || '🍰').toString().slice(0, 4);

  // Photo handling
  let photoUrl = existing.photo;
  const photo = form.get('photo');
  const removePhoto = form.get('remove_photo') === '1';

  if (photo && typeof photo !== 'string' && photo.size > 0) {
    if (photo.size > MAX_PHOTO_BYTES) return error(413, `photo too large (max ${MAX_PHOTO_BYTES} bytes)`);
    if (!ALLOWED_PHOTO_TYPES.includes(photo.type)) return error(415, `photo type not allowed: ${photo.type}`);
    // delete old photo
    if (existing.photo && existing.photo.startsWith('/photos/')) {
      try { await env.PHOTOS.delete(existing.photo.slice(1)); } catch {}
    }
    const ext = photoExtension(photo.type);
    const key = `photos/${Date.now()}-${randomId(6)}.${ext}`;
    await env.PHOTOS.put(key, photo.stream(), {
      httpMetadata: { contentType: photo.type },
    });
    photoUrl = `/${key}`;
  } else if (removePhoto) {
    if (existing.photo && existing.photo.startsWith('/photos/')) {
      try { await env.PHOTOS.delete(existing.photo.slice(1)); } catch {}
    }
    photoUrl = undefined;
  }

  data.entries[idx] = {
    ...existing,
    name,
    emoji,
    where: where || undefined,
    rating: rating || undefined,
    comment: comment || undefined,
    photo: photoUrl || undefined,
    updated_at: new Date().toISOString(),
  };

  await env.PHOTOS.put(ENTRIES_KEY, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return json({ ok: true, entry: data.entries[idx] });
}

async function geocodeReverse(lat, lon) {
  try {
    // OpenStreetMap Nominatim（無料、API key不要、ただし1req/sec推奨）
    // zoom=10 で市区町村レベル（精細すぎないように）
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1&accept-language=ja`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'cinnamon-sweet-diary/1.0' },
    });
    if (!res.ok) return json({ place: '' });
    const data = await res.json();
    const a = data.address || {};
    // プライバシー配慮: 詳細な住所は使わず、市区町村レベルのみ
    const place = a.city || a.town || a.village || a.suburb || a.county || a.state || '';
    return json({ place });
  } catch (e) {
    return json({ place: '' });
  }
}

async function deleteEntry(env, id) {
  const data = await readEntries(env);
  const idx = data.entries.findIndex((e) => e.id === id);
  if (idx < 0) return error(404, 'entry not found');
  const entry = data.entries[idx];

  // delete associated photo
  if (entry.photo && entry.photo.startsWith('/photos/')) {
    try { await env.PHOTOS.delete(entry.photo.slice(1)); } catch {}
  }

  data.entries.splice(idx, 1);
  await env.PHOTOS.put(ENTRIES_KEY, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  return json({ ok: true });
}

async function readEntries(env) {
  const obj = await env.PHOTOS.get(ENTRIES_KEY);
  if (!obj) {
    // 初回: デフォルトを書き込んで返す
    await env.PHOTOS.put(ENTRIES_KEY, JSON.stringify(DEFAULT_ENTRIES, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
    return DEFAULT_ENTRIES;
  }
  try {
    return JSON.parse(await obj.text());
  } catch (e) {
    return DEFAULT_ENTRIES;
  }
}

// ===== Photo serving =====

async function servePhoto(env, key) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

// ===== Helpers =====

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function error(status, message) {
  return json({ ok: false, error: message }, status);
}

function methodNotAllowed() {
  return new Response('method not allowed', { status: 405 });
}

function randomId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function photoExtension(mime) {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    default: return 'bin';
  }
}
