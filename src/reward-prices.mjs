const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function gcd(a,b){while(b){[a,b]=[b,a%b]}return a;}
function q(n,d=1n){if(d<=0n)throw Error('invalid denominator');const g=gcd(n,d);return [n/g,d/g];}
function add([a,b],[c,d]){return q(a*d+c*b,b*d);}
function mul([a,b],[c,d]){return q(a*c,b*d);}
function div([a,b],[c,d]){return q(a*d,b*c);}
function ceil([a,b]){return (a+b-1n)/b;}
function whole(value){if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||value.length>80)throw Error('invalid integer');return BigInt(value);}

/** Exact integer ceiling of a bounded rational interval containing exp(x). */
export function defaultRewardPrice({base,gentleBps,accelerationBps,tier}){
  const b=whole(base);
  if(b<1n||b>1_000_000_000_000n||![gentleBps,accelerationBps,tier].every(Number.isSafeInteger)||
    gentleBps<0||gentleBps>1000||accelerationBps<0||accelerationBps>20||tier<0||tier>100)
    throw Error('bounded price configuration required');
  const x=q(BigInt(accelerationBps*tier*tier),10000n);
  const prefix=q(b*(10000n+BigInt(gentleBps*tier)),10000n);
  let sum=q(1n),term=q(1n);
  for(let n=0;n<256;n++){
    const next=mul(term,div(x,q(BigInt(n+1))));
    const lower=mul(prefix,sum);
    // Remaining terms after next are bounded by a geometric tail once ratio < 1.
    const ratio=div(x,q(BigInt(n+2)));
    if(ratio[0]<ratio[1]){
      const tail=div(next,q(ratio[1]-ratio[0],ratio[1]));
      const upper=mul(prefix,add(sum,tail));
      if(ceil(lower)===ceil(upper))return ceil(lower);
    }
    sum=add(sum,next);term=next;
  }
  throw Error('price interval did not converge');
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
