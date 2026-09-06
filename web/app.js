// ミッフィーのスイーツ日記 — エントリ表示 + 投稿/編集
(function () {
  'use strict';

  const ENTRIES_URL = '/api/entries';
  const SAFE_WHERE_VALUES = new Set(['', 'おうち', 'おみせ', 'カフェ', 'おでかけ', 'そのほか']);
  const entriesEl = document.getElementById('entries');
  const emptyEl = document.getElementById('empty-state');
  const homeView = document.getElementById('home-view');
  const postView = document.getElementById('post-view');
  const discoveryView = document.getElementById('discovery-view');
  const discovery = window.CinnamonDiscovery;
  let discoveryMode = 'five';
  let discoveryPlace = null;
  let entriesLoaded = false;
  let entriesLoadFailed = false;
  let entriesRequestSequence = 0;

  let cachedEntries = [];
  let currentSort = localStorage.getItem('cinnamon.sort') || 'newest';
  // 一覧を読んだ時点の版。編集を開く時だけ editingETag に写す。
  // 編集中の再読み込みでその版を更新すると、他端末の変更を上書きしてしまう。
  let entriesETag = null;

  // ===== エントリ表示 =====

  async function loadEntries() {
    try {
      const res = await fetch(ENTRIES_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('fetch failed: ' + res.status);
      const data = await res.json();
      return {
        entries: Array.isArray(data.entries) ? data.entries : [],
        etag: res.headers.get('x-entries-version'),
      };
    } catch (e) {
      console.error('エントリの読み込みに失敗', e);
      return null;
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
    if (!discoveryView.hidden) renderDiscovery();
    if (!entries.length) {
      entriesEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }
    entriesEl.hidden = false;
    emptyEl.hidden = true;

    const sorted = sortEntries(entries, currentSort);

    entriesEl.innerHTML = sorted.map(renderEntry).join('');
  }

  // ===== ソート =====

  function sortEntries(entries, mode) {
    const list = [...entries];
    const byDateDesc = (a, b) => {
      const da = a.date || '';
      const db = b.date || '';
      if (da !== db) return da < db ? 1 : -1;
      const ca = new Date(a.created_at || 0).getTime();
      const cb = new Date(b.created_at || 0).getTime();
      return cb - ca;
    };
    const byDateAsc = (a, b) => -byDateDesc(a, b);

    switch (mode) {
      case 'oldest':
        return list.sort(byDateAsc);
      case 'rating-desc':
        return list.sort((a, b) => {
          const diff = (Number(b.rating) || 0) - (Number(a.rating) || 0);
          return diff !== 0 ? diff : byDateDesc(a, b);
        });
      case 'rating-asc':
        return list.sort((a, b) => {
          const diff = (Number(a.rating) || 0) - (Number(b.rating) || 0);
          return diff !== 0 ? diff : byDateDesc(a, b);
        });
      case 'newest':
      default:
        return list.sort(byDateDesc);
    }
  }

  const sortBar = document.getElementById('sort-bar');
  if (sortBar) {
    // 初期: localStorage の現在ソートをactive表示
    sortBar.querySelectorAll('.sort-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sort === currentSort);
    });

    sortBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.sort-btn');
      if (!btn) return;
      const mode = btn.dataset.sort;
      if (!mode || mode === currentSort) return;
      currentSort = mode;
      localStorage.setItem('cinnamon.sort', mode);
      sortBar.querySelectorAll('.sort-btn').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      render(cachedEntries);
    });
  }

  async function refresh() {
    const requestSequence = ++entriesRequestSequence;
    const snapshot = await loadEntries();
    // A slower, older response must not replace newer data or error state.
    if (requestSequence !== entriesRequestSequence) return false;
    if (!snapshot) {
      entriesLoadFailed = true;
      if (!discoveryView.hidden) {
        document.getElementById('discovery-status').textContent = entriesLoaded
          ? 'さいしんの記録を よめなかったよ。前によんだ記録を ひょうじしているよ。'
          : '記録を よめなかったよ。もういちど ためしてね。';
        document.getElementById('discovery-retry').hidden = false;
      }
      return false;
    }
    entriesLoaded = true;
    entriesLoadFailed = false;
    entriesETag = snapshot.etag;
    render(snapshot.entries);
    return true;
  }

  // ===== 画面遷移制御 =====

  const openBtn = document.getElementById('open-form');
  const backBtn = document.getElementById('back-btn');
  const form = document.getElementById('entry-form');
  const messageEl = document.getElementById('form-message');
  const formTitleEl = document.getElementById('form-title');
  const submitBtn = form.querySelector('.btn-submit');

  let editingId = null;
  let editingETag = null;
  let existingPhotoUrl = null; // 編集モードで既存の写真URL
  let formRequestInFlight = false;

  const deleteZone = document.getElementById('delete-zone');
  const deleteBtn = document.getElementById('delete-btn');

  function showPostView(entry = null) {
    editingId = entry?.id || null;
    editingETag = entry ? entriesETag : null;
    existingPhotoUrl = null;

    // 共通リセット
    form.reset();
    setRating(0);
    removeRemovePhotoFlag();
    clearDateField();
    if (photoInput) photoInput.value = '';
    if (photoPreview) photoPreview.hidden = true;
    if (photoPreviewImg) photoPreviewImg.src = '';
    if (photoPickBtn) photoPickBtn.textContent = '📷 しゃしんを えらぶ';

    if (entry) {
      formTitleEl.textContent = 'なおす ✏️';
      submitBtn.textContent = 'なおす';
      form.querySelector('input[name="name"]').value = entry.name || '';
      const whereInput = form.querySelector('[name="where"]');
      whereInput.value = SAFE_WHERE_VALUES.has(entry.where || '') ? (entry.where || '') : '';
      form.querySelector('textarea[name="comment"]').value = entry.comment || '';
      setRating(Number(entry.rating) || 0);
      // 日付: 既存の日付があればそれを、なければ今日
      setDateField(entry.date || todayString());

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
      // 新規: 日付のデフォルトは今日。写真のメタデータは読まない。
      setDateField(todayString());
      deleteZone.hidden = true;
    }

    homeView.hidden = true;
    discoveryView.hidden = true;
    postView.hidden = false;
    window.scrollTo(0, 0);
    // ブラウザ履歴に追加（戻るボタン対応）
    history.pushState({ view: 'post' }, '', '#post');
  }

  function showHomeView({ reload = true } = {}) {
    editingId = null;
    editingETag = null;
    existingPhotoUrl = null;
    form.reset();
    setRating(0);
    messageEl.hidden = true;
    messageEl.className = 'form-message';
    removeRemovePhotoFlag();
    clearDateField();
    if (photoPreview) photoPreview.hidden = true;
    if (photoPreviewImg) photoPreviewImg.src = '';
    if (photoPickBtn) photoPickBtn.textContent = '📷 しゃしんを えらぶ';

    postView.hidden = true;
    discoveryView.hidden = true;
    homeView.hidden = false;
    // 編集画面から戻った時は、競合後にも必ず最新の一覧を取り直す。
    if (reload) void refresh();
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

  function setFormActionsBusy(isBusy) {
    submitBtn.disabled = isBusy;
    deleteBtn.disabled = isBusy;
  }

  function showConcurrentChangeMessage() {
    messageEl.textContent = 'ほかの端末で きろくが かわったみたい。いまの入力は のこしてあるよ。いちらんに もどって さいしんにしてから、もういちど ひらいてね。';
    messageEl.className = 'form-message error';
    messageEl.hidden = false;
  }

  function isConcurrentChange(res) {
    return res.status === 409 || res.status === 428;
  }

  function editRequestHeaders() {
    return editingETag ? { 'If-Match': editingETag } : {};
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
    if (window.location.hash === '#discover') {
      showDiscovery({ push: false });
    } else if (!postView.hidden || !discoveryView.hidden) {
      const fromDiscovery = !discoveryView.hidden;
      showHomeView();
      if (fromDiscovery) document.getElementById('open-discovery').focus();
    }
  });

  // ===== 好き発見（既存の記録だけで見比べる） =====

  function discoveryCard(entry) {
    const name = escapeHTML(entry.name || 'なまえのない スイーツ');
    const score = discovery.rating(entry);
    const stars = score === null ? '★は まだつけていないよ' : `${'★'.repeat(score)} <span>${score} / 5</span>`;
    const photo = typeof entry.photo === 'string' && /^\/photos\/secure\/[a-zA-Z0-9/_-]+\.webp$/.test(entry.photo)
      ? `<img src="${escapeHTML(entry.photo)}" alt="${name}" loading="lazy">` : '';
    const location = discovery.place(entry) || 'ばしょ未記入';
    return `<article class="discovery-card">${photo}<div class="discovery-card-body">
      <h3>${name}</h3><p class="discovery-rating" aria-label="${score === null ? '星は未回答' : `星${score}つ、5点満点`}">${stars}</p>
      <p class="discovery-meta">${[escapeHTML(formatDate(entry.date)), location].filter(Boolean).join(' · ')}</p>
      ${entry.comment ? `<p>${escapeHTML(entry.comment)}</p>` : ''}</div></article>`;
  }

  function renderDiscovery() {
    if (!entriesLoaded) return;
    const summary = discovery.summarize(cachedEntries);
    document.getElementById('discovery-summary').innerHTML = [
      [summary.total, '記録ぜんぶ'], [summary.five, '★5の記録'], [summary.rated, '★つきの記録'],
    ].map(([count, label]) => `<div class="discovery-summary-item"><strong>${count}<small>こ</small></strong><span>${label}</span></div>`).join('');
    document.querySelectorAll('[data-discovery-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.discoveryMode === discoveryMode));
    });
    let entries = discovery.byRating(cachedEntries);
    let heading = '★5だった スイーツ';
    let prefix = '';
    let note = 'どんなところが すきだったかな？';
    if (discoveryMode === 'five') entries = entries.filter(entry => discovery.rating(entry) === 5);
    if (discoveryMode === 'rating') {
      heading = '★の おおい順に 見てみよう';
      note = '★をまだつけていない記録は、いちばん下にあるよ。';
    }
    if (discoveryMode === 'place') {
      if (!summary.groups.some(group => group.key === discoveryPlace)) discoveryPlace = null;
      prefix = `<div class="discovery-place-list">${summary.groups.map(group => `<button type="button" class="discovery-place"
        data-discovery-place="${group.key}" aria-pressed="${discoveryPlace === group.key}"><strong>${group.label}</strong>
        <span>${group.count}こ の記録</span><span>${group.average === null ? '★は まだないよ' : `★のへいきん ${group.average.toFixed(1)} / 5（${group.rated}こ）`}</span></button>`).join('')}</div>`;
      heading = discoveryPlace === null ? 'ばしょを えらんで 見くらべよう' : `${discoveryPlace || 'ばしょ未記入'}の スイーツ`;
      note = 'へいきんは、★をつけた記録だけで くらべているよ。ばしょを もう一度おすと、ぜんぶ見られるよ。';
      if (discoveryPlace !== null) entries = entries.filter(entry => discovery.place(entry) === discoveryPlace);
    }
    const empty = summary.total === 0 ? 'まだ記録がないよ。日記に スイーツを ついかすると、ここで見られるよ。'
      : '★5の記録は まだないよ。「★のおおい順」で、いまの すきを見てみよう。';
    document.getElementById('discovery-results').innerHTML = `${prefix}<h2 class="discovery-results-title">${heading}</h2>
      <p class="discovery-note">${note}</p>${entries.length ? `<div class="discovery-grid">${entries.map(discoveryCard).join('')}</div>` : `<p class="discovery-empty">${empty}</p>`}`;
    document.getElementById('discovery-status').textContent = entriesLoadFailed
      ? 'さいしんの記録を よめなかったよ。前によんだ記録を ひょうじしているよ。'
      : `${entries.length}この記録を ひょうじしているよ。`;
    document.getElementById('discovery-retry').hidden = !entriesLoadFailed;
  }

  function showDiscovery({ push = true, reload = true } = {}) {
    homeView.hidden = true;
    postView.hidden = true;
    discoveryView.hidden = false;
    if (push) history.pushState({ view: 'discover' }, '', '#discover');
    renderDiscovery();
    if (!entriesLoaded) document.getElementById('discovery-status').textContent = '記録を よんでいるよ…';
    document.getElementById('discovery-title').focus({ preventScroll: true });
    window.scrollTo(0, 0);
    if (reload) void refresh();
  }

  document.getElementById('open-discovery').addEventListener('click', () => showDiscovery());
  document.getElementById('discovery-back').addEventListener('click', () => {
    if (history.state?.view === 'discover') history.back();
    else {
      history.replaceState({}, '', window.location.pathname);
      showHomeView();
      document.getElementById('open-discovery').focus();
    }
  });
  document.getElementById('discovery-filters').addEventListener('click', event => {
    const button = event.target.closest('[data-discovery-mode]');
    if (!button) return;
    discoveryMode = button.dataset.discoveryMode;
    renderDiscovery();
  });
  document.getElementById('discovery-results').addEventListener('click', event => {
    const button = event.target.closest('[data-discovery-place]');
    if (!button) return;
    const key = button.dataset.discoveryPlace;
    discoveryPlace = discoveryPlace === key ? null : key;
    renderDiscovery();
    // Rendering replaces these buttons; restore keyboard focus to the same place.
    [...document.querySelectorAll('[data-discovery-place]')].find(item => item.dataset.discoveryPlace === key)?.focus({ preventScroll: true });
  });
  document.getElementById('discovery-retry').addEventListener('click', async () => {
    const button = document.getElementById('discovery-retry');
    button.disabled = true;
    document.getElementById('discovery-status').textContent = '記録を よんでいるよ…';
    await refresh();
    button.disabled = false;
  });

  // ===== 写真選択ボタン =====

  const photoInput = document.getElementById('photo-input');
  const photoPickBtn = document.getElementById('photo-pick-btn');
  const photoPreview = document.getElementById('photo-preview');
  const photoPreviewImg = document.getElementById('photo-preview-img');
  const photoClearBtn = document.getElementById('photo-clear-btn');

  photoPickBtn.addEventListener('click', () => photoInput.click());

  photoInput.addEventListener('change', async () => {
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
    clearDateField();
  });

  const dateInput = document.getElementById('date-input');

  function setDateField(date) {
    if (dateInput) dateInput.value = date || '';
  }

  function clearDateField() {
    if (dateInput) dateInput.value = '';
  }

  function todayString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  // フォームリセット時の写真プレビュークリアは、
  // showPostView / showHomeView で明示的に行うため、ここでは行わない
  // （setTimeout(0) を使うと showPostView の同期処理後に発火して
  //  プレビュー設定を上書きしてしまうバグがあったため削除）

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
    if (!editingId || formRequestInFlight) return;
    const entry = cachedEntries.find((x) => x.id === editingId);
    const name = entry && entry.name ? `「${entry.name}」` : 'このスイーツのきろく';
    if (!confirm(`${name}を ほんとうに けしていい？`)) return;

    formRequestInFlight = true;
    setFormActionsBusy(true);
    try {
      const res = await fetch(`/api/entries/${encodeURIComponent(editingId)}`, {
        method: 'DELETE',
        headers: editRequestHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (isConcurrentChange(res)) {
        showConcurrentChangeMessage();
        return;
      }
      if (!res.ok || !json.ok) throw new Error(json.error || `エラー: ${res.status}`);
      await refresh();
      // 削除後はホームへ確実に戻る
      history.replaceState({}, '', window.location.pathname);
      showHomeView({ reload: false });
    } catch (err) {
      messageEl.textContent = 'けせなかった: ' + err.message;
      messageEl.className = 'form-message error';
      messageEl.hidden = false;
    } finally {
      formRequestInFlight = false;
      setFormActionsBusy(false);
    }
  });

  // ===== 送信 =====

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (formRequestInFlight) return;

    formRequestInFlight = true;
    setFormActionsBusy(true);
    messageEl.hidden = true;

    const fd = new FormData(form);
    const isEdit = !!editingId;
    const url = isEdit ? `/api/entries/${encodeURIComponent(editingId)}` : '/api/entries';
    const method = isEdit ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        body: fd,
        headers: isEdit ? editRequestHeaders() : {},
      });
      const json = await res.json().catch(() => ({}));
      if (isConcurrentChange(res)) {
        showConcurrentChangeMessage();
        return;
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `エラー: ${res.status}`);
      }

      messageEl.textContent = isEdit ? 'なおせたよ！ ✨' : 'ついかできたよ！ 🎉';
      messageEl.className = 'form-message success';
      messageEl.hidden = false;

      await refresh();
      await new Promise((resolve) => setTimeout(resolve, 600));
      // 投稿成功後はホームへ確実に戻る（URLの#postも消す）
      history.replaceState({}, '', window.location.pathname);
      showHomeView({ reload: false });
    } catch (e) {
      messageEl.textContent = '失敗しちゃった: ' + e.message;
      messageEl.className = 'form-message error';
      messageEl.hidden = false;
    } finally {
      formRequestInFlight = false;
      setFormActionsBusy(false);
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
    bulkProgressFill.value = pct;
  }

  // 写真のEXIFはブラウザ側でも読まない。日付はフォーム入力または登録日にする。
  async function uploadOne(file) {
    const fd = new FormData();
    fd.append('photo', file);
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
        await uploadOne(file);
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

  if (window.location.hash === '#discover') showDiscovery({ push: false, reload: false });
  refresh();
})();
