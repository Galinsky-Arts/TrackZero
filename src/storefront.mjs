/** Public metadata only. No rights, entitlement or live playback assertions. */
const slug = /^[a-z0-9-]{3,80}$/;

function artwork(value, trustedOrigins) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !Array.isArray(trustedOrigins)) throw new Error('Invalid artwork URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid artwork URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !trustedOrigins.includes(url.origin)) throw new Error('Untrusted artwork URL');
  return url.href;
}

export function validateStationStorefront(record, {artworkOrigins = []} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid station');
  const {id, name, description, artworkUrl, offers} = record;
  if (typeof id !== 'string' || !slug.test(id) || typeof name !== 'string' ||
      name.trim().length < 2 || name.length > 100 || typeof description !== 'string' ||
      description.length > 1000) throw new Error('Invalid station metadata');
  if (!Array.isArray(offers) || offers.length > 20) throw new Error('Invalid offers');
  return Object.freeze({
    id, name: name.trim(), description, artworkUrl: artwork(artworkUrl, artworkOrigins),
    offers: Object.freeze(offers.map(offer => {
      if (!offer || typeof offer !== 'object' || Array.isArray(offer) ||
          typeof offer.id !== 'string' || !slug.test(offer.id) ||
          typeof offer.title !== 'string' || offer.title.trim().length < 2 ||
          offer.title.length > 120 || offer.type !== 'complete_product' ||
          offer.available !== true) throw new Error('Invalid complete-product offer');
      return Object.freeze({id: offer.id, title: offer.title.trim(), type: 'complete_product', available: true});
    }))
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

/** Static accessible preview; publication and transactions require trusted rights data. */
export function renderStorefrontHtml(record, options = {}) {
  const station = validateStationStorefront(record, options);
  const title = escapeHtml(station.name);
  const image = station.artworkUrl ? `<img src="${escapeHtml(station.artworkUrl)}" alt="Artwork for ${title}" loading="lazy">` : '';
  const offers = station.offers.length
    ? `<ul>${station.offers.map(offer => `<li><span>${escapeHtml(offer.title)}</span><span>Complete product</span></li>`).join('')}</ul>`
    : '<p>No catalog information is available.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | TrackZero</title></head><body><main><article aria-labelledby="station-title"><header>${image}<h1 id="station-title">${title}</h1></header><p>${escapeHtml(station.description)}</p><section aria-labelledby="catalog-title"><h2 id="catalog-title">Catalog information</h2>${offers}</section></article></main></body></html>`;
}
