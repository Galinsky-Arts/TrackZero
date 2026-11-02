/** Public complete-album projection. Trusted adapters must verify rights,
 * availability and the backing DRE-04 music items. */
function artwork(value, trustedOrigins) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Array.isArray(trustedOrigins)) throw new Error('Invalid album artwork');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid album artwork'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !trustedOrigins.includes(url.origin)) throw new Error('Untrusted album artwork');
  return url.href;
}

export async function projectCompleteAlbums(records, verifyPublishableAlbum,
  {artworkOrigins = []} = {}) {
  if (!Array.isArray(records) || records.length > 1000) throw new Error('Invalid catalog');
  if (typeof verifyPublishableAlbum !== 'function') throw new Error('Trusted catalog verifier required');
  if (!Array.isArray(artworkOrigins) || artworkOrigins.length > 8 ||
      artworkOrigins.some(origin => {
        try {
          const parsed = new URL(origin);
          return parsed.protocol !== 'https:' || parsed.origin !== origin ||
            !!parsed.username || !!parsed.password || !!parsed.port;
        } catch { return true; }
      })) throw new Error('Invalid album artwork policy');
  const seen = new Set();
  const result = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{6,100}$/.test(record.id) || seen.has(record.id) ||
        typeof record.title !== 'string' || record.title.trim().length < 2 ||
        record.title.length > 200 || record.kind !== 'album' ||
        !Number.isSafeInteger(record.trackCount) || record.trackCount < 1 ||
        record.trackCount > 500) throw new Error('Invalid complete album');
    const artworkUrl = artwork(record.artworkUrl, artworkOrigins);
    if (await verifyPublishableAlbum(record) !== true)
      throw new Error('Album rights or availability not verified');
    seen.add(record.id);
    result.push(Object.freeze({id: record.id, title: record.title.trim(),
      trackCount: record.trackCount, kind: 'complete_album',
      ...(artworkUrl ? {artworkUrl} : {})}));
  }
  return Object.freeze(result);
}
