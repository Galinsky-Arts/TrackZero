import { projectCompleteAlbums } from './catalog.mjs';
import { validateStationStorefront } from './storefront.mjs';

/** Inert offer projection from the accepted TZ-03 storefront contract and
 * independently supplied complete-album metadata. */
export async function matchStationOffers(station, catalogRecords, verifyPublishableAlbum,
  options = {}) {
  const storefront = validateStationStorefront(station);
  const seen = new Set();
  for (const offer of storefront.offers) {
    if (seen.has(offer.id)) throw new Error('Duplicate station offer');
    seen.add(offer.id);
  }
  const albums = await projectCompleteAlbums(catalogRecords, verifyPublishableAlbum, options);
  const byId = new Map(albums.map(album => [album.id, album]));
  return Object.freeze(storefront.offers.map(offer => {
    const album = byId.get(offer.id);
    if (!album) throw new Error('Station offer is not present in the permitted complete-album catalog');
    return Object.freeze({id: album.id, title: album.title, trackCount: album.trackCount,
      type: 'complete_product', stationId: storefront.id,
      ...(album.artworkUrl ? {artworkUrl: album.artworkUrl} : {})});
  }));
}
