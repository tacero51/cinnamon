// ミッフィーのスイーツ日記 — エントリ表示 + 投稿フォーム
(function () {
  'use strict';

  const ENTRIES_URL = '/api/entries';
  const entriesEl = document.getElementById('entries');
  const emptyEl = document.getElementById('empty-state');

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

    return `
      <article class="entry-card">
        ${photo}
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

  function openModal() {
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
  }

  openBtn.addEventListener('click', openModal);

  modal.addEventListener('click', (e) => {
    if (e.target.dataset.close === 'true') closeModal();
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

  // ===== 送信 =====

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = form.querySelector('.btn-submit');
    submitBtn.disabled = true;
    messageEl.hidden = true;

    const fd = new FormData(form);

    try {
      const res = await fetch('/api/entries', { method: 'POST', body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `エラー: ${res.status}`);
      }

      messageEl.textContent = 'ついかできたよ！ 🎉';
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

  // ===== 起動 =====

  refresh();
})();
