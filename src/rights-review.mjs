/** Conservative local decision only, not authenticated legal approval evidence. */
export function mayPublishCatalogItem(x,nowMs=Date.now()){
 if(!Number.isSafeInteger(nowMs)||nowMs<=0)return false;
 if(!x||typeof x!=='object'||Array.isArray(x)||x.ownerVerified!==true||x.rightsReviewed!==true||x.rightsApproved!==true||x.regionApproved!==true||x.sourceVerified!==true||x.withdrawn!==false)return false;
 if(typeof x.licenseVersion!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x.licenseVersion))return false;
 if(!Number.isSafeInteger(x.reviewedAtMs)||x.reviewedAtMs<=0||x.reviewedAtMs>nowMs)return false;
 if(x.reviewValidUntilMs!==undefined&&(!Number.isSafeInteger(x.reviewValidUntilMs)||x.reviewValidUntilMs<=nowMs))return false;
 return true;
}
