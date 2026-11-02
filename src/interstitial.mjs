/** User-supplied interstitial metadata is never a publish authorization. */
export function prepareInterstitialDraft(input,nowMs=Date.now()){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid interstitial');
 const expected=['capturedAtMs','clipId','durationMs','kind','mimeType','origin','sha256','stationId'];
 if(Object.keys(input).sort().join(',')!==expected.join(','))throw new Error('Unexpected interstitial fields');
 const id=/^[a-z0-9-]{3,80}$/;
 if(typeof input.clipId!=='string'||!id.test(input.clipId)||typeof input.stationId!=='string'||!id.test(input.stationId))throw new Error('Invalid identity');
 if(!['station-ident','content-ident'].includes(input.kind)||!['recorded','uploaded'].includes(input.origin))throw new Error('Invalid clip type');
 if(!['audio/wav','audio/mpeg','audio/ogg'].includes(input.mimeType)||typeof input.sha256!=='string'||! /^[a-f0-9]{64}$/.test(input.sha256))throw new Error('Invalid claimed media metadata');
 if(!Number.isSafeInteger(input.durationMs)||input.durationMs<200||input.durationMs>300000||!Number.isSafeInteger(nowMs)||!Number.isSafeInteger(input.capturedAtMs)||input.capturedAtMs<1||input.capturedAtMs>nowMs)throw new Error('Invalid clip timing');
 return Object.freeze({...input,reviewState:'quarantined',publishable:false,assurance:'unverified-input'});
}
