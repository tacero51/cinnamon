// ミッフィーのスイーツ日記 — エントリ表示 + 投稿/編集
(function () {
  'use strict';

  const ENTRIES_URL = '/api/entries';
  const entriesEl = document.getElementById('entries');
  const emptyEl = document.getElementById('empty-state');
  const homeView = document.getElementById('home-view');
  const postView = document.getElementById('post-view');

  let cachedEntries = [];

  // ===== エントリ表示 =====

  async function loadEntries() {
    try {
      const res = await fetch(ENTRIES_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('fetch failed: ' + res.status);
      const data = await res.json();
      return Array.isArray(data.entries) ? data.entries : [];
    } catch (e) {
      console.error('エントリの読み込みに失敗', e);
      return [];
    }
  }

  function formatDate(isoDate) {
    if (!isoDate) return '';
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return isoDate;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function renderStars(rating) {
    const max = 5;
    const n = Math.max(0, Math.min(max, Number(rating) || 0));
    let html = '';
    for (let i = 0; i < n; i++) html += '★';
    for (let i = n; i < max; i++) html += '<span class="star-empty">★</span>';
    return html;
  }

  function escapeHTML(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderEntry(entry) {
    const nameRaw = (entry.name || '').trim();
    const name = escapeHTML(nameRaw);
    const nameHtml = nameRaw ? `<h2 class="entry-name">${name}</h2>` : '';
    const date = escapeHTML(formatDate(entry.date));
    const where = entry.where ? `<span class="entry-where">${escapeHTML(entry.where)}</span>` : '';
    const rating = renderStars(entry.rating);
    const comment = entry.comment
      ? `<p class="entry-comment">${escapeHTML(entry.comment)}</p>`
      : '';
    const photo = entry.photo
      ? `<img class="entry-photo" src="${escapeHTML(entry.photo)}" alt="${name || 'スイーツ'}" loading="lazy">`
      : '';
    const id = escapeHTML(entry.id);

    return `
      <article class="entry-card" data-id="${id}">
        ${photo}
        <div class="entry-actions">
          <button class="action-btn action-edit" data-action="edit" data-id="${id}" aria-label="なおす" title="なおす">✏️</button>
        </div>
        ${nameHtml}
        <div class="entry-meta">
          ${date ? `<span class="entry-date">${date}</span>` : ''}
          ${where}
        </div>
        <div class="entry-rating" aria-label="評価 ${Number(entry.rating) || 0} / 5">${rating}</div>
        ${comment}
      </article>
    `;
  }

  function render(entries) {
    cachedEntries = entries;
    if (!entries.length) {
      entriesEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }
    entriesEl.hidden = false;
    emptyEl.hidden = true;

    const sorted = [...entries].sort((a, b) => {
      const da = new Date(a.created_at || a.date || 0).getTime();
      const db = new Date(b.created_at || b.date || 0).getTime();
      return db - da;
    });

    entriesEl.innerHTML = sorted.map(renderEntry).join('');
  }

  async function refresh() {
    const entries = await loadEntries();
    render(entries);
  }

  // ===== 画面遷移制御 =====

  const openBtn = document.getElementById('open-form');
  const backBtn = document.getElementById('back-btn');
  const form = document.getElementById('entry-form');
  const messageEl = document.getElementById('form-message');
  const formTitleEl = document.getElementById('form-title');
  const submitBtn = form.querySelector('.btn-submit');

  let editingId = null;
  let existingPhotoUrl = null; // 編集モードで既存の写真URL

  const deleteZone = document.getElementById('delete-zone');
  const deleteBtn = document.getElementById('delete-btn');

  function showPostView(entry = null) {
    editingId = entry?.id || null;
    existingPhotoUrl = null;

    // 共通リセット
    form.reset();
    setRating(0);
    removeRemovePhotoFlag();
    if (photoInput) photoInput.value = '';
    if (photoPreview) photoPreview.hidden = true;
    if (photoPreviewImg) photoPreviewImg.src = '';
    if (photoPickBtn) photoPickBtn.textContent = '📷 しゃしんを えらぶ';

    if (entry) {
      formTitleEl.textContent = 'なおす ✏️';
      submitBtn.textContent = 'なおす';
      form.querySelector('input[name="name"]').value = entry.name || '';
      form.querySelector('input[name="where"]').value = entry.where || '';
      form.querySelector('textarea[name="comment"]').value = entry.comment || '';
      setRating(Number(entry.rating) || 0);

      // 既存の写真があれば、新規選択と同じプレビューUIで表示
      if (entry.photo) {
        existingPhotoUrl = entry.photo;
        photoPreviewImg.src = entry.photo;
        photoPreview.hidden = false;
        photoPickBtn.textContent = '📷 しゃしんを かえる';
      }

      deleteZone.hidden = false;
    } else {
      formTitleEl.textContent = 'あたらしい きろく';
      submitBtn.textContent = 'とうこうする';
      deleteZone.hidden = true;
    }

    homeView.hidden = true;
    postView.hidden = false;
    window.scrollTo(0, 0);
    // ブラウザ履歴に追加（戻るボタン対応）
    history.pushState({ view: 'post' }, '', '#post');
  }

  function showHomeView() {
    editingId = null;
    existingPhotoUrl = null;
    form.reset();
    setRating(0);
    messageEl.hidden = true;
    messageEl.className = 'form-message';
    removeRemovePhotoFlag();
    if (photoPreview) photoPreview.hidden = true;
    if (photoPreviewImg) photoPreviewImg.src = '';
    if (photoPickBtn) photoPickBtn.textContent = '📷 しゃしんを えらぶ';

    postView.hidden = true;
    homeView.hidden = false;
  }

  function goBack() {
    // pushStateしたstateを戻すために history.back を使う
    if (history.state && history.state.view === 'post') {
      history.back();
    } else {
      showHomeView();
    }
  }

  // 「写真を削除する」フラグ操作（編集時に既存写真を消す場合）
  function setRemovePhotoFlag() {
    let flag = form.querySelector('input[name="remove_photo"]');
    if (!flag) {
      flag = document.createElement('input');
      flag.type = 'hidden';
      flag.name = 'remove_photo';
      form.appendChild(flag);
    }
    flag.value = '1';
  }

  function removeRemovePhotoFlag() {
    const flag = form.querySelector('input[name="remove_photo"]');
    if (flag) flag.remove();
  }

  // 投稿ボタン
  openBtn.addEventListener('click', () => showPostView(null));

  // 戻るボタン（ヘッダー）
  backBtn.addEventListener('click', goBack);

  // やめるボタン
  form.addEventListener('click', (e) => {
    if (e.target.dataset.action === 'back') goBack();
  });

  // ブラウザ「戻る」対応
  window.addEventListener('popstate', () => {
    if (!postView.hidden) {
      showHomeView();
    }
  });

  // ===== 写真選択ボタン =====

  const photoInput = document.getElementById('photo-input');
  const photoPickBtn = document.getElementById('photo-pick-btn');
  const photoPreview = document.getElementById('photo-preview');
  const photoPreviewImg = document.getElementById('photo-preview-img');
  const photoClearBtn = document.getElementById('photo-clear-btn');

  photoPickBtn.addEventListener('click', () => photoInput.click());

  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    if (!file) {
      // キャンセル時は何もしない（既存写真があればそのまま）
      return;
    }
    // 新しい写真を選択 → プレビュー更新、既存写真の参照は捨てる
    existingPhotoUrl = null;
    removeRemovePhotoFlag();
    const reader = new FileReader();
    reader.onload = (e) => {
      photoPreviewImg.src = e.target.result;
      photoPreview.hidden = false;
      photoPickBtn.textContent = '📷 しゃしんを かえる';
    };
    reader.readAsDataURL(file);
  });

  photoClearBtn.addEventListener('click', () => {
    // 既存写真を消す場合は remove_photo フラグを立てる
    if (existingPhotoUrl && !photoInput.files.length) {
      setRemovePhotoFlag();
      existingPhotoUrl = null;
    }
    photoInput.value = '';
    photoPreview.hidden = true;
    photoPreviewImg.src = '';
    photoPickBtn.textContent = '📷 しゃしんを えらぶ';
  });

  // フォームリセット時にプレビューもクリア
  form.addEventListener('reset', () => {
    setTimeout(() => {
      photoPreview.hidden = true;
      photoPreviewImg.src = '';
      photoPickBtn.textContent = '📷 しゃしんを えらぶ';
    }, 0);
  });

  // ===== 評価選択 =====

  const ratingInput = form.querySelector('input[name="rating"]');

  function setRating(value) {
    ratingInput.value = String(value);
    form.querySelectorAll('.star-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.value) <= value);
    });
  }

  form.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.value);
      setRating(ratingInput.value === String(v) ? 0 : v);
    });
  });

  // ===== 一覧上のアクション（編集・削除） =====

  entriesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'edit') {
      const entry = cachedEntries.find((x) => x.id === id);
      if (!entry) return;
      showPostView(entry);
    }
  });

  // 編集画面からの削除
  deleteBtn.addEventListener('click', async () => {
    if (!editingId) return;
    const entry = cachedEntries.find((x) => x.id === editingId);
    const name = entry && entry.name ? `「${entry.name}」` : 'このスイーツのきろく';
    if (!confirm(`${name}を ほんとうに けしていい？`)) return;

    deleteBtn.disabled = true;
    submitBtn.disabled = true;
    try {
      const res = await fetch(`/api/entries/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `エラー: ${res.status}`);
      await refresh();
      // 削除後はホームへ確実に戻る
      history.replaceState({}, '', window.location.pathname);
      showHomeView();
    } catch (err) {
      messageEl.textContent = 'けせなかった: ' + err.message;
      messageEl.className = 'form-message error';
      messageEl.hidden = false;
    } finally {
      deleteBtn.disabled = false;
      submitBtn.disabled = false;
    }
  });

  // ===== 送信 =====

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    submitBtn.disabled = true;
    messageEl.hidden = true;

    const fd = new FormData(form);
    const isEdit = !!editingId;
    const url = isEdit ? `/api/entries/${encodeURIComponent(editingId)}` : '/api/entries';
    const method = isEdit ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, { method, body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `エラー: ${res.status}`);
      }

      messageEl.textContent = isEdit ? 'なおせたよ！ ✨' : 'ついかできたよ！ 🎉';
      messageEl.className = 'form-message success';
      messageEl.hidden = false;

      await refresh();
      setTimeout(() => {
        // 投稿成功後はホームへ確実に戻る（URLの#postも消す）
        history.replaceState({}, '', window.location.pathname);
        showHomeView();
      }, 600);
    } catch (e) {
      messageEl.textContent = '失敗しちゃった: ' + e.message;
      messageEl.className = 'form-message error';
      messageEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ===== まとめてとうろく =====

  const bulkBtn = document.getElementById('bulk-btn');
  const bulkInput = document.getElementById('bulk-input');
  const bulkProgress = document.getElementById('bulk-progress');
  const bulkProgressTitle = document.getElementById('bulk-progress-title');
  const bulkProgressText = document.getElementById('bulk-progress-text');
  const bulkProgressFill = document.getElementById('bulk-progress-fill');
  const bulkCloseBtn = document.getElementById('bulk-close-btn');

  bulkBtn.addEventListener('click', () => bulkInput.click());

  bulkInput.addEventListener('change', async () => {
    const files = Array.from(bulkInput.files || []);
    bulkInput.value = ''; // 同じファイル再選択でも change が発火するように
    if (!files.length) return;
    await bulkUpload(files);
  });

  bulkCloseBtn.addEventListener('click', () => {
    bulkProgress.hidden = true;
    bulkCloseBtn.hidden = true;
  });

  function updateProgress(done, total, succeeded) {
    bulkProgressText.textContent = `${done} / ${total}（できた: ${succeeded}）`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    bulkProgressFill.style.width = pct + '%';
  }

  // EXIFから日付とGPSを抽出
  async function extractExif(file) {
    if (typeof exifr === 'undefined') return { date: null, lat: null, lon: null };
    try {
      const data = await exifr.parse(file, {
        pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef', 'latitude', 'longitude'],
      });
      if (!data) return { date: null, lat: null, lon: null };
      const dateObj = data.DateTimeOriginal || data.CreateDate || null;
      let date = null;
      if (dateObj instanceof Date && !isNaN(dateObj.getTime())) {
        const y = dateObj.getFullYear();
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const d = String(dateObj.getDate()).padStart(2, '0');
        date = `${y}-${m}-${d}`;
      }
      const lat = typeof data.latitude === 'number' ? data.latitude : null;
      const lon = typeof data.longitude === 'number' ? data.longitude : null;
      return { date, lat, lon };
    } catch (e) {
      console.warn('EXIF extract failed', e);
      return { date: null, lat: null, lon: null };
    }
  }

  // 座標 → 地名（Worker経由）
  async function reverseGeocode(lat, lon) {
    try {
      const res = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
      if (!res.ok) return '';
      const data = await res.json();
      return data.place || '';
    } catch (e) {
      return '';
    }
  }

  async function uploadOne(file, date, place) {
    const fd = new FormData();
    fd.append('photo', file);
    if (date) fd.append('date', date);
    if (place) fd.append('where', place);
    const res = await fetch('/api/entries', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'unknown');
    return json.entry;
  }

  async function bulkUpload(files) {
    bulkProgress.hidden = false;
    bulkCloseBtn.hidden = true;
    bulkProgressTitle.textContent = 'とうろくちゅう...';
    let done = 0;
    let succeeded = 0;
    updateProgress(0, files.length, 0);

    for (const file of files) {
      try {
        const exif = await extractExif(file);
        let place = '';
        if (exif.lat != null && exif.lon != null) {
          place = await reverseGeocode(exif.lat, exif.lon);
        }
        await uploadOne(file, exif.date, place);
        succeeded++;
      } catch (e) {
        console.error('bulk upload error for', file.name, e);
      }
      done++;
      updateProgress(done, files.length, succeeded);
    }

    bulkProgressTitle.textContent = succeeded === files.length
      ? `${succeeded}まい ぜんぶできたよ！🎉`
      : `${succeeded}/${files.length}まい とうろくできたよ`;
    bulkCloseBtn.hidden = false;
    await refresh();
  }

  // ===== リフレッシュボタン =====

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
      await refresh();
      setTimeout(() => {
        refreshBtn.classList.remove('spinning');
        refreshBtn.disabled = false;
      }, 800);
    });
  }

  // ===== 起動 =====

  refresh();
})();
