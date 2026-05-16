// ミッフィーのスイーツ日記 — エントリ表示 + 投稿フォーム
(function () {
  'use strict';

  const ENTRIES_URL = '/api/entries';
  const entriesEl = document.getElementById('entries');
  const emptyEl = document.getElementById('empty-state');

  let cachedEntries = []; // 編集時にcurrent値を取得するため

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
    const emoji = entry.emoji || '🍰';
    const name = escapeHTML(entry.name);
    const date = escapeHTML(formatDate(entry.date));
    const where = entry.where ? `<span class="entry-where">${escapeHTML(entry.where)}</span>` : '';
    const rating = renderStars(entry.rating);
    const comment = entry.comment
      ? `<p class="entry-comment">${escapeHTML(entry.comment)}</p>`
      : '';
    const photo = entry.photo
      ? `<img class="entry-photo" src="${escapeHTML(entry.photo)}" alt="${name}" loading="lazy">`
      : '';
    const id = escapeHTML(entry.id);

    return `
      <article class="entry-card" data-id="${id}">
        ${photo}
        <div class="entry-actions">
          <button class="action-btn action-edit" data-action="edit" data-id="${id}" aria-label="なおす" title="なおす">✏️</button>
          <button class="action-btn action-delete" data-action="delete" data-id="${id}" aria-label="けす" title="けす">🗑️</button>
        </div>
        <div class="entry-emoji">${emoji}</div>
        <h2 class="entry-name">${name}</h2>
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

  // ===== モーダル制御 =====

  const modal = document.getElementById('form-modal');
  const openBtn = document.getElementById('open-form');
  const form = document.getElementById('entry-form');
  const messageEl = document.getElementById('form-message');
  const formTitleEl = document.getElementById('form-title');
  const submitBtn = form.querySelector('.btn-submit');

  let editingId = null; // null=新規、文字列=編集中のID

  function openModal(entry = null) {
    editingId = entry?.id || null;

    if (entry) {
      // 編集モード
      formTitleEl.textContent = 'スイーツを なおす ✏️';
      submitBtn.textContent = 'なおす';
      form.querySelector('input[name="name"]').value = entry.name || '';
      form.querySelector('input[name="where"]').value = entry.where || '';
      form.querySelector('textarea[name="comment"]').value = entry.comment || '';
      setEmoji(entry.emoji || '🍰');
      setRating(Number(entry.rating) || 0);
      showExistingPhoto(entry.photo);
    } else {
      // 新規モード
      formTitleEl.textContent = 'あたらしい スイーツを ついか🍰';
      submitBtn.textContent = 'とうこうする';
      form.reset();
      setEmoji('🍰');
      setRating(0);
      hideExistingPhoto();
    }

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    form.reset();
    setEmoji('🍰');
    setRating(0);
    messageEl.hidden = true;
    messageEl.className = 'form-message';
    editingId = null;
    hideExistingPhoto();
  }

  function showExistingPhoto(photoUrl) {
    let el = document.getElementById('existing-photo');
    if (!el) {
      const photoField = form.querySelector('input[name="photo"]').closest('.field');
      el = document.createElement('div');
      el.id = 'existing-photo';
      el.className = 'existing-photo';
      photoField.insertBefore(el, photoField.firstChild.nextSibling);
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
    const el = document.getElementById('existing-photo');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  openBtn.addEventListener('click', () => openModal(null));

  modal.addEventListener('click', (e) => {
    if (e.target.dataset.close === 'true') closeModal();
  });

  // ===== 一覧上のアクション（編集・削除） =====

  entriesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;

    if (action === 'edit') {
      const entry = cachedEntries.find((x) => x.id === id);
      if (!entry) return;
      openModal(entry);
    } else if (action === 'delete') {
      const entry = cachedEntries.find((x) => x.id === id);
      const name = entry ? entry.name : 'これ';
      if (!confirm(`「${name}」を ほんとうに けしていい？`)) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.error || `エラー: ${res.status}`);
        await refresh();
      } catch (err) {
        alert('けせなかった: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    }
  });

  // ===== 絵文字選択 =====

  const emojiInput = form.querySelector('input[name="emoji"]');

  function setEmoji(emoji) {
    emojiInput.value = emoji;
    form.querySelectorAll('.emoji-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.emoji === emoji);
    });
  }
  setEmoji('🍰');

  form.querySelectorAll('.emoji-btn').forEach((btn) => {
    btn.addEventListener('click', () => setEmoji(btn.dataset.emoji));
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
      // 同じスターをタップしたら解除
      setRating(ratingInput.value === String(v) ? 0 : v);
    });
  });

  // ===== 送信（新規・編集の両方） =====

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

      // 一覧更新 + フォーム閉じる
      await refresh();
      setTimeout(closeModal, 900);
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
