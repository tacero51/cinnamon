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
    const nameHtml = nameRaw
      ? `<h2 class="entry-name">${name}</h2>`
      : `<h2 class="entry-name entry-name-empty">スイーツ</h2>`;
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
  const existingPhotoContainerId = 'existing-photo';

  let editingId = null;

  const deleteZone = document.getElementById('delete-zone');
  const deleteBtn = document.getElementById('delete-btn');

  function showPostView(entry = null) {
    editingId = entry?.id || null;

    if (entry) {
      formTitleEl.textContent = 'スイーツを なおす ✏️';
      submitBtn.textContent = 'なおす';
      form.querySelector('input[name="name"]').value = entry.name || '';
      form.querySelector('input[name="where"]').value = entry.where || '';
      form.querySelector('textarea[name="comment"]').value = entry.comment || '';
      setRating(Number(entry.rating) || 0);
      showExistingPhoto(entry.photo);
      deleteZone.hidden = false;
    } else {
      formTitleEl.textContent = 'あたらしい スイーツ';
      submitBtn.textContent = 'とうこうする';
      form.reset();
      setRating(0);
      hideExistingPhoto();
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
    form.reset();
    setRating(0);
    messageEl.hidden = true;
    messageEl.className = 'form-message';
    hideExistingPhoto();

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

  // 既存写真のプレビュー（編集時）
  function showExistingPhoto(photoUrl) {
    let el = document.getElementById(existingPhotoContainerId);
    if (!el) {
      const photoField = form.querySelector('input[name="photo"]').closest('.field');
      el = document.createElement('div');
      el.id = existingPhotoContainerId;
      el.className = 'existing-photo';
      photoField.appendChild(el);
    }
    if (photoUrl) {
      el.innerHTML = `
        <img src="${escapeHTML(photoUrl)}" alt="いまの しゃしん">
        <label class="remove-photo-label">
          <input type="checkbox" name="remove_photo" value="1">
          <span>この しゃしんを けす</span>
        </label>
      `;
      el.hidden = false;
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
  }

  function hideExistingPhoto() {
    const el = document.getElementById(existingPhotoContainerId);
    if (el) { el.hidden = true; el.innerHTML = ''; }
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
      photoPreview.hidden = true;
      photoPreviewImg.src = '';
      photoPickBtn.textContent = '📷 しゃしんを えらぶ';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      photoPreviewImg.src = e.target.result;
      photoPreview.hidden = false;
      photoPickBtn.textContent = '📷 しゃしんを かえる';
    };
    reader.readAsDataURL(file);
  });

  photoClearBtn.addEventListener('click', () => {
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
    const name = entry ? entry.name : 'これ';
    if (!confirm(`「${name}」を ほんとうに けしていい？`)) return;

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
