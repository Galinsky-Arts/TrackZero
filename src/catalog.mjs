/** Public complete-album projection. A trusted provider must separately verify
 * rights and availability; client-supplied booleans grant no authority. */
export async function projectCompleteAlbums(records, verifyPublishableAlbum){
 if(!Array.isArray(records)||records.length>1000)throw new Error('Invalid catalog');
 if(typeof verifyPublishableAlbum!=='function')throw new Error('Trusted catalog verifier required');
 const seen=new Set();
 const result=[];
 for(const record of records){
  if(!record||typeof record!=='object'||typeof record.id!=='string'||! /^[a-zA-Z0-9_-]{6,100}$/.test(record.id)||seen.has(record.id)||typeof record.title!=='string'||record.title.trim().length<2||record.title.length>200||record.kind!=='album'||!Number.isSafeInteger(record.trackCount)||record.trackCount<1||record.trackCount>500)throw new Error('Invalid complete album');
  if(await verifyPublishableAlbum(record)!==true)throw new Error('Album rights or availability not verified');
  seen.add(record.id);
  result.push(Object.freeze({id:record.id,title:record.title.trim(),trackCount:record.trackCount,kind:'complete_album'}));
 }
 return Object.freeze(result);
}
