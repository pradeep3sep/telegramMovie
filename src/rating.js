export function normalizeRating(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 10 ? String(number) : null;
}

export function formatRating(value) {
  const rating = normalizeRating(value);
  return rating ? rating + '/10' : 'Not available';
}
