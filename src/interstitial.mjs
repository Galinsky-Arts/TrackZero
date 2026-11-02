const localId = /^[a-z0-9-]{3,80}$/;
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** User-supplied metadata is never a publish authorization. */
export function prepareInterstitialDraft(input, nowMs = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid interstitial');
  const expected = ['capturedAtMs', 'clipId', 'contentRef', 'durationMs', 'kind', 'mimeType', 'origin', 'sha256', 'stationId'];
  if (Object.keys(input).sort().join(',') !== expected.join(',')) throw new Error('Unexpected interstitial fields');
  if (typeof input.clipId !== 'string' || !localId.test(input.clipId) ||
      typeof input.stationId !== 'string' || !localId.test(input.stationId) ||
      typeof input.contentRef !== 'string' || !opaqueId.test(input.contentRef)) {
    throw new Error('Invalid identity');
  }
  if (!['opening', 'closing', 'station-id'].includes(input.kind) ||
      !['recorded', 'uploaded'].includes(input.origin)) throw new Error('Invalid clip type');
  if (!['audio/wav', 'audio/mpeg', 'audio/ogg'].includes(input.mimeType) ||
      typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error('Invalid claimed media metadata');
  }
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 1 || input.durationMs > 1_800_000 ||
      !Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 1 ||
      input.capturedAtMs > nowMs) throw new Error('Invalid clip timing');
  return Object.freeze({...input, reviewState: 'quarantined', publishable: false, assurance: 'unverified-input'});
}

/** Shape the exact DRE-08 record without treating a ciphertext reference as proof. */
export function prepareDreInterstitial(draft, audioRef) {
  if (!draft || draft.reviewState !== 'quarantined' || draft.publishable !== false ||
      typeof audioRef !== 'string' ||
      !/^ciphertext:[A-Za-z0-9][A-Za-z0-9._:-]{0,117}$/.test(audioRef)) throw new Error('Invalid published audio reference');
  return Object.freeze({
    stationId: draft.stationId,
    contentRef: draft.contentRef,
    audioRef,
    kind: draft.kind,
    durationMs: draft.durationMs
  });
}
