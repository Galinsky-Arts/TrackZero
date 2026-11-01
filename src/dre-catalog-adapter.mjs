const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Adapt DRE-04 RadioCatalog.get to the complete-album verifier contract.
 * The caller fixes tenant and publisher scope server-side; album input may only
 * name the encrypted DRE music items that make up the complete product.
 */
export function createDreAlbumVerifier({tenantId, publisherId, lookupMedia} = {}) {
  if (typeof tenantId !== 'string' || !ID.test(tenantId) ||
      typeof publisherId !== 'string' || !ID.test(publisherId) ||
      typeof lookupMedia !== 'function') throw new Error('Trusted DRE catalog adapter required');
  return async record => {
    if (!record || !Array.isArray(record.trackIds) ||
        record.trackIds.length !== record.trackCount || record.trackIds.length > 500) return false;
    const seen = new Set();
    for (const trackId of record.trackIds) {
      if (typeof trackId !== 'string' || !ID.test(trackId) || seen.has(trackId)) return false;
      seen.add(trackId);
      const media = await lookupMedia({tenantId, id: trackId});
      if (!media || media.id !== trackId || media.tenantId !== tenantId ||
          media.publisherId !== publisherId || media.kind !== 'music' ||
          typeof media.assetRef !== 'string' || !media.assetRef.startsWith('ciphertext:')) return false;
    }
    return true;
  };
}
