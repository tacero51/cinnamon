// 既存エントリの date を、写真のEXIF撮影日に置き換えるバッチスクリプト
// 使い方: cd cinnamon/scripts && node migrate-dates.mjs
import exifr from 'exifr';

const BASE = process.env.SITE_BASE || 'https://cinnamon.tacero.workers.dev';

async function main() {
  console.log(`Fetching entries from ${BASE} ...`);
  const res = await fetch(`${BASE}/api/entries`);
  if (!res.ok) throw new Error(`fetch entries failed: ${res.status}`);
  const { entries } = await res.json();
  console.log(`Found ${entries.length} entries\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const tag = `${entry.id} (${entry.name || '(なまえなし)'})`;

    if (!entry.photo) {
      console.log(`  [skip] ${tag}: 写真なし`);
      skipped++;
      continue;
    }

    try {
      const photoUrl = entry.photo.startsWith('http') ? entry.photo : BASE + entry.photo;
      const photoRes = await fetch(photoUrl);
      if (!photoRes.ok) throw new Error(`photo fetch failed: ${photoRes.status}`);
      const photoBuf = Buffer.from(await photoRes.arrayBuffer());

      const exif = await exifr.parse(photoBuf, { pick: ['DateTimeOriginal', 'CreateDate'] });
      const dateObj = exif?.DateTimeOriginal || exif?.CreateDate;

      if (!dateObj || isNaN(new Date(dateObj).getTime())) {
        console.log(`  [skip] ${tag}: EXIF日付なし`);
        skipped++;
        continue;
      }

      const d = new Date(dateObj);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      const newDate = `${y}-${mo}-${da}`;

      if (newDate === entry.date) {
        console.log(`  [skip] ${tag}: 既に ${newDate}`);
        skipped++;
        continue;
      }

      // PUT: 既存フィールドをすべて送り、date のみ更新
      const fd = new FormData();
      fd.append('name', entry.name || '');
      fd.append('where', entry.where || '');
      fd.append('comment', entry.comment || '');
      fd.append('rating', String(entry.rating || 0));
      fd.append('emoji', entry.emoji || '');
      fd.append('date', newDate);

      const putRes = await fetch(`${BASE}/api/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        body: fd,
      });
      const putJson = await putRes.json().catch(() => ({}));
      if (!putRes.ok || !putJson.ok) {
        throw new Error(`PUT failed: ${putRes.status} ${JSON.stringify(putJson)}`);
      }

      console.log(`  [done] ${tag}: ${entry.date || '(none)'} → ${newDate}`);
      updated++;

      // Cloudflare R2 への連続書き込みを抑える
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      console.error(`  [fail] ${tag}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n=== 完了 ===`);
  console.log(`更新: ${updated}件 / スキップ: ${skipped}件 / 失敗: ${failed}件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
