// Read-only summaries: missing stars are unanswered, never zero-point ratings.
(function (root) {
  'use strict';
  const places = ['おうち', 'おみせ', 'カフェ', 'おでかけ', 'そのほか', ''];
  function rating(entry) {
    const value = typeof entry.rating === 'number' || typeof entry.rating === 'string'
      ? Number(entry.rating) : NaN;
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  }
  function place(entry) {
    return places.includes(entry.where) ? entry.where : '';
  }
  function newest(a, b) {
    return String(b.date || '').localeCompare(String(a.date || ''));
  }
  function byRating(entries) {
    return [...entries].sort((a, b) => (rating(b) || 0) - (rating(a) || 0) || newest(a, b));
  }
  function summarize(entries) {
    const groups = places.map(key => {
      const items = entries.filter(entry => place(entry) === key);
      const rated = items.map(rating).filter(value => value !== null);
      return { key, label: key || 'ばしょ未記入', count: items.length, rated: rated.length,
        average: rated.length ? rated.reduce((sum, n) => sum + n, 0) / rated.length : null };
    }).filter(group => group.count);
    return { total: entries.length, rated: entries.filter(entry => rating(entry) !== null).length,
      five: entries.filter(entry => rating(entry) === 5).length, groups };
  }
  root.CinnamonDiscovery = Object.freeze({ rating, place, byRating, summarize });
})(globalThis);
