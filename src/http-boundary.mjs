export class BoundaryError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
/** Bound bytes while reading; Request.text() would first buffer an unbounded body. */
export async function readBoundedJson(request,maxBytes=4096){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>100000)throw new Error('Invalid body limit');
  const reader=request.body?.getReader();if(!reader)throw new BoundaryError('INVALID_JSON');
  const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
  try{
    while(true){const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>maxBytes){await reader.cancel();throw new BoundaryError('BODY_TOO_LARGE',413);}
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
  }catch(error){if(error instanceof BoundaryError)throw error;throw new BoundaryError('INVALID_JSON');}
  finally{reader.releaseLock();}
  let body;try{body=JSON.parse(text);}catch{throw new BoundaryError('INVALID_JSON');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new BoundaryError('INVALID_JSON');
  return body;
}

/** Structural envelope check only; the bound DAE endpoint authenticates and decrypts. */
export function encryptedControlEnvelope(packet){
  const fields=['version','scope','keyId','algorithm','epoch','sequence','issuedAtMs','expiresAtMs','action','payloadCiphertextBase64'];
  if(!packet||typeof packet!=='object'||Array.isArray(packet)||Object.keys(packet).sort().join(',')!=='body,signatureHex'||
    !packet.body||typeof packet.body!=='object'||Array.isArray(packet.body)||
    Object.keys(packet.body).sort().join(',')!==fields.sort().join(',')||
    !packet.body.scope||Object.keys(packet.body.scope).sort().join(',')!=='application,sessionId,tenantId'||
    !['tenantId','sessionId'].every(k=>typeof packet.body.scope[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(packet.body.scope[k]))||
    !['distributed-radio','scenesignal'].includes(packet.body.scope.application)||packet.body.version!=='1.0.0'||
    packet.body.algorithm!=='ALG-ED25519'||
    !['keyId','action'].every(k=>typeof packet.body[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(packet.body[k]))||
    !['epoch','sequence','issuedAtMs','expiresAtMs'].every(k=>Number.isSafeInteger(packet.body[k])&&packet.body[k]>=0)||
    packet.body.epoch<1||packet.body.sequence<1||packet.body.expiresAtMs<=packet.body.issuedAtMs||
    typeof packet.body.payloadCiphertextBase64!=='string'||!packet.body.payloadCiphertextBase64||
    packet.body.payloadCiphertextBase64.length>65536||typeof packet.signatureHex!=='string'||!/^[a-f0-9]{128}$/.test(packet.signatureHex)||
    new TextEncoder().encode(JSON.stringify(packet)).byteLength>8192)throw new BoundaryError('ENCRYPTED_CONTROL_REQUIRED');
  return packet;
}
