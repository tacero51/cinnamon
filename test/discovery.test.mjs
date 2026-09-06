import assert from 'node:assert/strict';
import test from 'node:test';
import '../web/discovery.js';
const { rating, place, byRating, summarize } = globalThis.CinnamonDiscovery;

test('discovery separates missing or invalid stars from rated records', () => {
  for (const value of [undefined, null, '', 0, '0', 6, -1, 2.5, true, {}, 'bad']) {
    assert.equal(rating({ rating: value }), null);
  }
  assert.equal(rating({ rating: '5' }), 5);
  assert.equal(rating({ rating: 1 }), 1);
});

test('place averages use answered stars only and expose sample counts', () => {
  const result = summarize([
    { where: 'おうち', rating: 5 }, { where: 'おうち', rating: 3 }, { where: 'おうち' },
    { where: 'カフェ', rating: 0 }, { where: 'unknown private location', rating: 4 },
  ]);
  assert.equal(result.total, 5);
  assert.equal(result.five, 1);
  assert.equal(result.rated, 3);
  assert.deepEqual(result.groups.find(g => g.key === 'おうち'), { key: 'おうち', label: 'おうち', count: 3, rated: 2, average: 4 });
  assert.equal(result.groups.find(g => g.key === 'カフェ').average, null);
  assert.equal(place({ where: 'unknown private location' }), '');
  assert.equal(JSON.stringify(result).includes('unknown private location'), false);
});

test('rating order keeps unanswered entries last and does not mutate the diary', () => {
  const entries = [
    { id: 'unrated', date: '2026-09-07' },
    { id: 'older-five', rating: 5, date: '2026-09-01' },
    { id: 'three', rating: 3 },
    { id: 'newer-five', rating: '5', date: '2026-09-06' },
  ];
  const before = JSON.stringify(entries);
  assert.deepEqual(byRating(entries).map(e => e.id), ['newer-five', 'older-five', 'three', 'unrated']);
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(summarize([]), { total: 0, five: 0, rated: 0, groups: [] });
});
