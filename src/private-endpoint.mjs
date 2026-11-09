import {readBoundedJson,encryptedControlEnvelope} from './http-boundary.mjs';
/** Mandatory approved endpoint codecs. Framing checks never authenticate a peer. */
export function createPrivateBoundary({decodeControl,encodeResponse}={}){
  if(typeof decodeControl!=='function'||typeof encodeResponse!=='function')throw Error('Approved E2EE endpoint codecs required');
  return Object.freeze({
    async read(request,identity,context){
      return decodeControl(identity,encryptedControlEnvelope(await readBoundedJson(request,8192)),context);
    },
    async respond(status,identity,value,context){
      const packet=encryptedControlEnvelope(await encodeResponse(identity,value,context));
      return new Response(JSON.stringify(packet),{status,headers:{'content-type':'application/json','cache-control':'no-store',
        'content-security-policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'}});
    }
  });
}
