const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function whole(value){if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||value.length>1000)throw Error('invalid integer');return BigInt(value);}

/** DRE-17 owns price arithmetic. This adapter only maps creator configuration.
 * A symbolic quote is displayable but never becomes an executable integer cost.
 */
export function createRewardPricing({createRewardPricePolicy,rewardPrice}){
  if(typeof createRewardPricePolicy!=='function'||typeof rewardPrice!=='function')
    throw Error('DRE price policy and quote functions required');
  return ({artistId,version=1,base,gentleBps=500,accelerationBps=100,tier})=>{
    if(typeof artistId!=='string'||!id.test(artistId)||!Number.isSafeInteger(version)||version<1||
      ![gentleBps,accelerationBps].every(v=>Number.isSafeInteger(v)&&v>=0))throw Error('invalid creator price settings');
    const policy=createRewardPricePolicy({creatorId:artistId,version,basePoints:whole(base),
      gentleNumerator:BigInt(gentleBps),gentleDenominator:10000n,
      accelerationNumerator:BigInt(accelerationBps),accelerationDenominator:10000n});
    const level=typeof tier==='string'?whole(tier):tier;
    return rewardPrice({policy,level});
  };
}

export function rewardPreview(offer,wallet){
  if(!offer||!wallet||typeof offer!=='object'||typeof wallet!=='object'||
    ![offer.id,offer.artistId,wallet.artistId].every(v=>typeof v==='string'&&id.test(v))||
    typeof offer.title!=='string'||!offer.title.trim()||offer.title.length>200||
    !Number.isSafeInteger(offer.version)||offer.version<1||
    typeof offer.available!=='boolean'||wallet.artistId!==offer.artistId)
    throw Error('trusted same-artist offer and wallet required');
  const cost=whole(offer.cost),balance=whole(wallet.spendable);
  if(cost<1n||balance<0n)throw Error('invalid cost or balance');
  return {id:offer.id,title:offer.title,artistId:offer.artistId,version:offer.version,
    cost:cost.toString(),balance:balance.toString(),available:offer.available,
    canRequest:offer.available&&balance>=cost};
}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export function renderRewardPreview(view){
  if(!view||typeof view.id!=='string'||!id.test(view.id)||
    typeof view.artistId!=='string'||!id.test(view.artistId)||typeof view.title!=='string'||
    !view.title.trim()||view.title.length>200||
    !Number.isSafeInteger(view.version)||view.version<1||
    typeof view.available!=='boolean'||typeof view.canRequest!=='boolean')
    throw Error('invalid reward preview');
  const balance=whole(view.balance),cost=whole(view.cost);
  if(balance<0n||cost<1n||view.canRequest!==(view.available&&balance>=cost))
    throw Error('invalid reward preview');
  return `<article><h2>${esc(view.title)}</h2><p>Artist: ${esc(view.artistId)}</p>`+
    `<p>Offer version ${view.version}; cost ${esc(view.cost)} artist points; spendable balance ${esc(view.balance)}.</p>`+
    `<p>${view.available?'Available for request':'Unavailable'}; ${view.canRequest?'balance meets the displayed cost':'cannot request with this balance and availability'}.</p>`+
    `<p>Requesting does not reserve or grant a reward. The issuer must recheck the offer and spend atomically.</p></article>`;
}
