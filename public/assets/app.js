// TrackZero web UI. Vanilla ES modules; reuses the repository's pure browser
// modules from /modules/. Access tokens live in memory only; the HttpOnly
// account cookie never becomes readable here. Endpoint-encrypted operations call
// their real paths and display the server's ENDPOINT_ENROLLMENT_REQUIRED answer:
// no plaintext payload is ever sent in their place.
import {createProgramController, mountProgramEditor} from '/modules/program-sequence.mjs';
import {bindContributionSetup, renderContributionSetup} from '/modules/contribute-sound.mjs';
import {LivePointsView, renderLivePoints} from '/modules/live-points.mjs';
import {mountGrooveReveal} from '/modules/groove-reveal.mjs';

const main = document.getElementById('main');
const state = {session: {signedIn: false}, context: null, token: null, readiness: null, operatorToken: null};

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false)
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const field = (label, input, hint) => h('label', {}, label, input, hint ? h('span', {class: 'muted'}, hint) : null);
const input = attrs => h('input', attrs);
const card = (title, ...body) => h('section', {class: 'card', 'aria-label': title}, h('h2', {}, title), ...body);
const resultBox = () => h('div', {class: 'result', role: 'status', 'aria-live': 'polite', hidden: true});
function show(box, text, kind = '') { box.hidden = false; box.className = `result ${kind}`; box.textContent = text; }
const messages = {
  ENDPOINT_ENROLLMENT_REQUIRED: 'Requires an enrolled endpoint. This operation exchanges endpoint-encrypted payloads; TrackZero has no plaintext fallback, so it stays unavailable until an approved endpoint is enrolled.',
  UNAUTHENTICATED: 'Sign in first.', STATION_CLAIM_REQUIRED: 'An operator must verify and provision your station claim first.',
  PUBLISHER_ROLE_REQUIRED: 'Artist or label onboarding (by invitation) is required.', RIGHTS_NOT_VERIFIED: 'Every offer needs approved sale rights from a different rights reviewer.',
  PROGRAM_ITEM_DENIED: 'An item is not authorized: songs need approved broadcast rights; ads need an approved campaign; intros need a published clip.',
  BROADCASTER_ROLE_REQUIRED: 'Only the verified owner of a station can edit it.', STATION_ACCESS_DENIED: 'You do not own this station.',
  SELF_REVIEW_DENIED: 'Reviewers cannot approve their own claims.', ROLE_DENIED: 'Your account lacks the required role.',
  INVITATION_DENIED: 'That invitation is invalid, expired, already used or for another role.', INVITATION_REQUIRED: 'Artist and label onboarding needs an invitation code.',
  PUBLICATION_DENIED: 'Publishing requires a verified endpoint-encrypted clip upload, which no enrolled endpoint has provided.',
  CAMPAIGN_NOT_AUTHORIZED: 'Approval requires verified endpoint-encrypted sponsor audio, which no enrolled endpoint has provided.',
  VERSION_CONFLICT: 'The program changed elsewhere. Reload it and try again.', ORIGIN_DENIED: 'Request origin denied.'
};
const describe = (status, data) => data?.error ? (messages[data.error] ? `${messages[data.error]} (${data.error})` : `Request failed: ${data.error} (HTTP ${status})`) : `HTTP ${status}`;

async function token(force = false) {
  if (!force && state.token && state.token.expiresAt - Date.now() > 30_000) return state.token.value;
  const response = await fetch('/api/account/token', {method: 'POST', credentials: 'same-origin'});
  if (!response.ok) { state.token = null; return null; }
  const body = await response.json();
  state.token = {value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000};
  return state.token.value;
}
async function api(path, {method = 'GET', body, auth = true, headers = {}, raw = false} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const merged = {...headers};
    if (body !== undefined) merged['content-type'] = 'application/json';
    if (auth) { const value = await token(attempt > 0); if (value) merged.authorization = `Bearer ${value}`; }
    const response = await fetch(path, {method, headers: merged, credentials: 'same-origin',
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))});
    if (response.status === 401 && auth && attempt === 0 && state.session.signedIn) continue;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = raw ? text : null; }
    return {status: response.status, ok: response.ok, data, text};
  }
}
async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const operationId = () => 'op-' + crypto.randomUUID().replaceAll('-', '');
const roles = () => state.context?.roles ?? [];
const has = role => roles().includes(role);
const creator = () => has('artist') || has('label');
const feature = name => state.readiness?.features?.[name] ?? {state: 'unknown'};

async function refreshSession() {
  const response = await fetch('/api/account/session', {credentials: 'same-origin'});
  state.session = response.ok ? await response.json() : {signedIn: false};
  state.context = null;
  if (state.session.signedIn) {
    const context = await api('/api/context');
    state.context = context.ok ? context.data : null;
  } else state.token = null;
  document.getElementById('nav-account').textContent = state.session.signedIn ? 'Account' : 'Sign in';
}
async function refreshReadiness() {
  try { const response = await fetch('/readyz'); state.readiness = await response.json(); } catch { state.readiness = null; }
  const notice = document.getElementById('notice');
  if (state.readiness?.storage?.durability === 'ephemeral') {
    notice.hidden = false;
    notice.textContent = state.readiness.storage.notice;
  }
}

/** A card for an endpoint-encrypted feature. The button calls the real route
 * without any payload and shows the server's answer. */
function gatedCard(title, featureName, description, {path, method = 'POST'}) {
  const box = resultBox(), info = feature(featureName);
  const button = h('button', {type: 'button', class: 'secondary', onclick: async () => {
    button.disabled = true;
    const response = await api(path, {method, headers: {'idempotency-key': operationId()}});
    show(box, describe(response.status, response.data), response.ok ? 'success' : 'error');
    button.disabled = false;
  }}, `Try ${title.toLowerCase()}`);
  return h('section', {class: 'card gated', 'aria-label': title}, h('h2', {}, title, ' ',
    h('span', {class: info.state === 'available' ? 'badge ok' : 'badge'}, info.state === 'available' ? 'Available' : 'Requires enrolled endpoint')),
    h('p', {}, description), info.needs ? h('p', {class: 'muted'}, `Needs: ${info.needs}.`) : null, button, box);
}
function requireSignIn() {
  return card('Sign in required', h('p', {}, 'This area needs a TrackZero account.'), h('p', {}, h('a', {href: '#/account'}, 'Sign in or create an account')));
}

// ---------------------------------------------------------------- views
function homeView() {
  return [h('h1', {}, 'TrackZero radio'),
    h('p', {}, 'Live, linear radio stations run by artists and labels. Listeners join the current broadcast — there is no song picker and no skipping.'),
    h('div', {class: 'grid'},
      card('Listeners', h('p', {}, 'Discover stations, open album pages and manage listener features.'), h('p', {}, h('a', {href: '#/discover'}, 'Discover stations'), ' · ', h('a', {href: '#/listen'}, 'Listener features'))),
      card('Artists and labels', h('p', {}, 'Publish your station, manage complete-album offers, rights, program sequence, interstitials, sponsors and reward prices.'), h('p', {}, h('a', {href: '#/studio'}, 'Open the studio'))),
      card('Status', h('p', {}, state.readiness ? `Service ${state.readiness.status}. ${state.readiness.notice}` : 'Readiness unavailable.'), h('p', {}, h('a', {href: '/readyz'}, 'Full readiness report'))))];
}

async function discoverView() {
  const response = await api('/api/public/stations', {auth: false});
  const stations = response.ok ? response.data.stations : [];
  return [h('h1', {}, 'Discover live radio'), h('p', {}, 'Station links join the current broadcast; songs cannot be selected.'),
    stations.length ? h('ul', {class: 'plain stations'}, stations.map(station => h('li', {}, h('article', {class: 'card'},
      h('h2', {}, station.name), h('p', {}, station.description || 'No description.'),
      h('a', {href: `/stations/${encodeURIComponent(station.id)}`}, `Open ${station.name}`)))))
      : h('p', {class: 'card'}, 'No stations have been published yet.')];
}

function accountView() {
  if (!state.session.signedIn) {
    const box = resultBox(), mode = {value: 'sign-in'};
    const name = input({name: 'name', autocomplete: 'name', maxlength: 80});
    const nameField = field('Display name', name);
    nameField.hidden = true;
    const email = input({type: 'email', name: 'email', autocomplete: 'email', required: true});
    const password = input({type: 'password', name: 'password', autocomplete: 'current-password', minlength: 10, required: true});
    const submit = h('button', {type: 'submit'}, 'Sign in');
    const toggle = h('button', {type: 'button', class: 'secondary', onclick: () => {
      mode.value = mode.value === 'sign-in' ? 'sign-up' : 'sign-in';
      const signUp = mode.value === 'sign-up';
      nameField.hidden = !signUp; name.required = signUp;
      password.autocomplete = signUp ? 'new-password' : 'current-password';
      submit.textContent = signUp ? 'Create account' : 'Sign in';
      toggle.textContent = signUp ? 'I already have an account' : 'Create a new account';
      heading.textContent = signUp ? 'Create your account' : 'Sign in';
    }}, 'Create a new account');
    const heading = h('h1', {}, 'Sign in');
    const form = h('form', {onsubmit: async event => {
      event.preventDefault(); submit.disabled = true;
      const signUp = mode.value === 'sign-up';
      const response = await api(`/api/auth/${signUp ? 'sign-up' : 'sign-in'}/email`, {method: 'POST', auth: false,
        body: signUp ? {name: name.value.trim(), email: email.value.trim(), password: password.value} : {email: email.value.trim(), password: password.value}});
      password.value = '';
      submit.disabled = false;
      if (!response.ok) return show(box, response.data?.message || describe(response.status, response.data), 'error');
      await refreshSession(); render();
    }}, nameField, field('Email', email), field('Password', password, 'At least 10 characters.'), h('div', {class: 'row'}, submit, toggle));
    return [heading, h('section', {class: 'card'}, form, box),
      h('p', {class: 'muted'}, 'Passwords and sessions are handled by the TrackZero account service. Email ownership is not verified in this preview.')];
  }
  const box = resultBox();
  const onboard = async (role, invitation) => {
    const response = await api('/v1/onboarding', {method: 'POST', body: invitation ? {role, invitation} : {role}});
    if (!response.ok) return show(box, describe(response.status, response.data), 'error');
    await refreshSession(); render();
  };
  const invite = input({name: 'invitation', autocomplete: 'off', pattern: '[a-fA-F0-9]{64}', required: true, spellcheck: 'false'});
  const inviteRole = h('select', {name: 'role'}, h('option', {value: 'artist'}, 'Artist'), h('option', {value: 'label'}, 'Label'));
  return [h('h1', {}, 'Your account'),
    card('Account', h('p', {}, `Signed in as ${state.session.name || state.session.email} (${state.session.email}).`),
      h('p', {}, 'Account reference (give this to an operator for station claims or role grants): ', h('code', {id: 'account-reference'}, state.context?.subject ?? state.session.userId)),
      h('p', {}, 'Roles: ', h('strong', {id: 'account-roles'}, roles().length ? roles().join(', ') : 'none yet')),
      h('button', {type: 'button', class: 'secondary', onclick: async () => {
        await api('/api/auth/sign-out', {method: 'POST', auth: false, body: {}});
        state.token = null; await refreshSession(); render();
      }}, 'Sign out')),
    card('Join as a listener', h('p', {}, 'Listener onboarding needs no invitation.'),
      h('button', {type: 'button', disabled: has('listener'), onclick: () => onboard('listener')}, has('listener') ? 'Listener role active' : 'Join as listener')),
    card('Artist or label invitation', h('p', {}, 'Creators join by a single-use invitation from an operator.'),
      h('form', {onsubmit: event => { event.preventDefault(); onboard(inviteRole.value, invite.value.trim()); }},
        field('Role', inviteRole), field('Invitation code', invite), h('button', {type: 'submit'}, 'Redeem invitation'))),
    box];
}

function stationOptions() {
  return (state.context?.stations ?? []).map(station => h('option', {value: station.id}, station.name ? `${station.name} (${station.id})` : `${station.id} (unpublished)`));
}

function stationCard() {
  const box = resultBox();
  const claims = state.context?.stations ?? [];
  if (!claims.length) return card('Your station', h('p', {}, 'No verified station claim yet. Send an operator your account reference and the station address you want (3–80 lowercase letters, digits or hyphens).'),
    h('p', {}, 'Your account reference: ', h('code', {}, state.context?.subject ?? '')));
  const select = h('select', {name: 'station', id: 'station-select'}, stationOptions());
  const name = input({name: 'name', minlength: 2, maxlength: 100, required: true});
  const description = h('textarea', {name: 'description', maxlength: 1000});
  const offers = h('div', {class: 'offers'});
  const addOffer = (offer = {}) => {
    const id = input({name: 'offer-id', pattern: '[a-z0-9\\-]{3,80}', required: true, value: offer.id ?? '', 'aria-label': 'Album offer ID'});
    const title = input({name: 'offer-title', minlength: 2, maxlength: 120, required: true, value: offer.title ?? '', 'aria-label': 'Album title'});
    const row = h('div', {class: 'row'}, field('Album ID', id), field('Album title', title),
      h('button', {type: 'button', class: 'secondary', onclick: () => row.remove()}, 'Remove'));
    offers.append(row);
  };
  const load = async () => {
    offers.replaceChildren();
    if (!claims.find(claim => claim.id === select.value)?.published) { name.value = ''; description.value = ''; return; }
    const response = await api(`/api/public/stations/${encodeURIComponent(select.value)}`, {auth: false});
    if (response.ok) { name.value = response.data.name; description.value = response.data.description; response.data.offers.forEach(addOffer); }
    else { name.value = ''; description.value = ''; }
  };
  select.addEventListener('change', load); load();
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    const items = [...offers.querySelectorAll('.row')].map(row => ({id: row.querySelector('[name="offer-id"]').value.trim(),
      title: row.querySelector('[name="offer-title"]').value.trim(), type: 'complete_product', available: true}));
    const response = await api('/v1/stations', {method: 'POST', body: {id: select.value, name: name.value.trim(), description: description.value, offers: items}});
    if (!response.ok) return show(box, describe(response.status, response.data), 'error');
    show(box, `Published ${response.data.name} with ${response.data.offers.length} complete-album offer(s).`, 'success');
    await refreshSession();
  }}, field('Station', select), field('Station name', name), field('Description', description),
    h('fieldset', {}, h('legend', {}, 'Complete-album offers'), h('p', {class: 'muted'}, 'Each album needs approved sale rights in your region before publication.'), offers,
      h('button', {type: 'button', class: 'secondary', onclick: () => addOffer()}, 'Add album')),
    h('div', {class: 'row'}, h('button', {type: 'submit'}, 'Publish station'),
      h('a', {href: '#', onclick: event => { event.preventDefault(); location.href = `/stations/${encodeURIComponent(select.value)}`; }}, 'View public page')));
  return card('Your station and catalog', form, box);
}

function rightsCard() {
  const box = resultBox(), region = state.context?.region ?? 'US';
  const item = input({name: 'itemId', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._:\\-]{0,127}'});
  const area = input({name: 'region', required: true, pattern: '[A-Z]{2}', value: region, maxlength: 2});
  const license = input({name: 'licenseVersion', required: true, value: 'v1', pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}'});
  const evidence = input({type: 'file', name: 'evidence', required: true});
  const uses = ['broadcast', 'sale', 'cache', 'reward'].map(use => h('label', {}, h('input', {type: 'checkbox', name: 'uses', value: use, checked: use === 'broadcast' || use === 'sale'}), use));
  const from = input({type: 'date', name: 'from', required: true, value: new Date().toISOString().slice(0, 10)});
  const until = input({type: 'date', name: 'until', required: true, value: new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10)});
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    if (!evidence.files[0]) return;
    show(box, 'Computing the evidence fingerprint on this device…');
    const evidenceDigest = await sha256Hex(evidence.files[0]);
    const response = await api('/v1/rights/claims', {method: 'POST', body: {itemId: item.value.trim(), region: area.value.trim(),
      licenseVersion: license.value.trim(), evidenceDigest, uses: [...form.querySelectorAll('[name="uses"]:checked')].map(x => x.value),
      rightsValidFromMs: Date.parse(from.value), rightsValidUntilMs: Date.parse(until.value)}});
    show(box, response.ok ? `Claim for ${response.data.itemId} in ${response.data.region} is ${response.data.state}. A different rights reviewer must approve it.` : describe(response.status, response.data), response.ok ? 'success' : 'error');
  }}, field('Recording or album ID', item, 'Use the same ID as the album offer or program song.'), field('Region', area), field('License version', license),
    field('Rights evidence document', evidence, 'Only its SHA-256 fingerprint is sent; the document never leaves this device.'),
    h('fieldset', {}, h('legend', {}, 'Requested uses'), uses), h('div', {class: 'row'}, field('Valid from', from), field('Valid until', until)),
    h('button', {type: 'submit'}, 'Submit rights claim'));
  const check = input({name: 'check', 'aria-label': 'Item ID to check'}), checkUse = h('select', {'aria-label': 'Use'}, ['broadcast', 'sale', 'cache', 'reward'].map(u => h('option', {value: u}, u)));
  const checkBox = resultBox();
  const checkForm = h('form', {onsubmit: async event => {
    event.preventDefault();
    const params = new URLSearchParams({tenant: state.context.tenant, application: state.context.application, region, use: checkUse.value});
    const response = await api(`/v1/rights/decisions/${encodeURIComponent(check.value.trim())}?${params}`, {auth: false});
    show(checkBox, response.ok ? (response.data.publishable ? `Approved for ${checkUse.value} in ${region}.` : `Not publishable for ${checkUse.value} in ${region}.`) : describe(response.status, response.data), response.ok && response.data.publishable ? 'success' : '');
  }}, h('div', {class: 'row'}, field('Check an item', check), field('Use', checkUse), h('button', {type: 'submit', class: 'secondary'}, 'Check')));
  const withdrawBox = resultBox(), withdrawItem = input({'aria-label': 'Item ID to withdraw', required: true});
  const withdrawForm = h('form', {onsubmit: async event => {
    event.preventDefault();
    const response = await api('/v1/rights/withdrawals', {method: 'POST', body: {itemId: withdrawItem.value.trim(), region}});
    show(withdrawBox, response.ok ? `Rights for ${response.data.itemId} withdrawn.` : describe(response.status, response.data), response.ok ? 'success' : 'error');
  }}, h('div', {class: 'row'}, field('Withdraw a claim', withdrawItem), h('button', {type: 'submit', class: 'secondary'}, 'Withdraw')));
  return card('Rights', form, box, checkForm, checkBox, withdrawForm, withdrawBox);
}

function programCard() {
  const claims = state.context?.stations ?? [];
  if (!claims.length) return null;
  const select = h('select', {'aria-label': 'Station to sequence'}, stationOptions());
  let editor = h('div', {class: 'program'});
  const box = resultBox();
  let controller = null;
  const mount = (items, version) => {
    // A fresh container per controller so stale listeners never act on old state.
    const fresh = h('div', {class: 'program'});
    editor.replaceWith(fresh); editor = fresh;
    if (!items.length) { editor.append(h('p', {class: 'muted'}, 'No program saved yet. Add the first items below.')); controller = null; return; }
    controller = createProgramController(items, {version, save: async payload => {
      const response = await api(`/v1/programs/${encodeURIComponent(select.value)}`, {method: 'PUT', body: payload});
      if (!response.ok) { show(box, describe(response.status, response.data), 'error'); throw new Error(response.data?.error); }
      show(box, `Saved schedule version ${response.data.version}.`, 'success');
      return response.data;
    }});
    mountProgramEditor(editor, controller);
  };
  let pending = [], version = 0;
  const load = async () => {
    const response = await api(`/v1/programs/${encodeURIComponent(select.value)}`);
    if (!response.ok) return show(box, describe(response.status, response.data), 'error');
    version = response.data.version; pending = response.data.items; mount(pending, version);
  };
  select.addEventListener('change', load); load();
  const id = input({required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._:\\-]{0,127}', 'aria-label': 'Item ID'});
  const kind = h('select', {'aria-label': 'Item kind'}, ['song', 'block', 'intro', 'ad'].map(k => h('option', {value: k}, k)));
  const add = h('form', {onsubmit: async event => {
    event.preventDefault();
    const items = [...(controller ? controller.snapshot().items : pending), {id: id.value.trim(), kind: kind.value}];
    const current = controller ? controller.snapshot().version : version;
    const response = await api(`/v1/programs/${encodeURIComponent(select.value)}`, {method: 'PUT', body: {expectedVersion: current, items}});
    if (!response.ok) return show(box, describe(response.status, response.data), 'error');
    version = response.data.version; pending = response.data.items; id.value = '';
    show(box, `Added and saved schedule version ${version}.`, 'success'); mount(pending, version);
  }}, h('div', {class: 'row'}, field('Item ID', id), field('Kind', kind), h('button', {type: 'submit'}, 'Add item')));
  return card('Programming', h('p', {}, 'Drag rows, or use Move up / Move down, then Save sequence. Songs need approved broadcast rights.'),
    field('Station', select), editor, add, box);
}

function interstitialCard() {
  const claims = state.context?.stations ?? [];
  if (!claims.length) return null;
  const box = resultBox();
  const station = h('select', {'aria-label': 'Station'}, stationOptions());
  const clipId = input({required: true, pattern: '[a-z0-9\\-]{3,80}'});
  const kind = h('select', {}, ['opening', 'closing', 'station-id'].map(k => h('option', {value: k}, k)));
  const file = input({type: 'file', accept: 'audio/wav,audio/mpeg,audio/ogg', required: true});
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    const audio = file.files[0];
    if (!audio || !['audio/wav', 'audio/mpeg', 'audio/ogg'].includes(audio.type)) return show(box, 'Choose a WAV, MP3 or Ogg file.', 'error');
    show(box, 'Reading clip metadata on this device…');
    const url = URL.createObjectURL(audio);
    const durationMs = await new Promise(resolve => { const el = new Audio(); el.preload = 'metadata';
      el.onloadedmetadata = () => resolve(Math.round(el.duration * 1000)); el.onerror = () => resolve(0); el.src = url; });
    URL.revokeObjectURL(url);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) return show(box, 'Could not read the clip duration.', 'error');
    const response = await api('/v1/interstitials', {method: 'POST', body: {stationId: station.value, clipId: clipId.value.trim(),
      contentRef: `clip-${clipId.value.trim()}`, kind: kind.value, origin: 'uploaded', mimeType: audio.type, sha256: await sha256Hex(audio),
      durationMs, capturedAtMs: Math.min(audio.lastModified || Date.now(), Date.now())}});
    show(box, response.ok ? `Draft ${response.data.clipId} saved as metadata only (${response.data.reviewState}). Publishing requires an endpoint-encrypted upload from an enrolled endpoint.` : describe(response.status, response.data), response.ok ? 'success' : 'error');
  }}, field('Station', station), field('Clip ID', clipId), field('Kind', kind),
    field('Clip audio', file, 'Fingerprint and duration are computed locally; audio is not uploaded by this browser page.'),
    h('button', {type: 'submit'}, 'Save interstitial draft'));
  return card('Interstitials', form, box, h('p', {class: 'muted'}, `Publication: ${feature('interstitialPublication').needs ?? 'unavailable'}.`));
}

function sponsorCard() {
  const box = resultBox();
  const parts = [];
  if (has('sponsor')) {
    const station = input({required: true, pattern: '[a-z0-9\\-]{3,80}'}), campaign = input({required: true});
    const audioRef = input({required: true, pattern: 'ciphertext:[A-Za-z0-9][A-Za-z0-9._:\\-]{0,117}'});
    const digest = input({required: true, pattern: 'sha256:[a-f0-9]{64}'}), rate = input({type: 'number', min: 0, step: 1, required: true, value: 0});
    const start = input({type: 'datetime-local', required: true}), end = input({type: 'datetime-local', required: true});
    parts.push(h('form', {onsubmit: async event => {
      event.preventDefault();
      const response = await api('/v1/sponsor-campaigns', {method: 'POST', body: {stationId: station.value.trim(), campaignId: campaign.value.trim(),
        audioRef: audioRef.value.trim(), programDigest: digest.value.trim(), rateMinor: Number(rate.value),
        startsAtMs: Date.parse(start.value), endsAtMs: Date.parse(end.value)}});
      show(box, response.ok ? `Campaign ${response.data.campaignId} is ${response.data.state}; not schedulable until the station approves it.` : describe(response.status, response.data), response.ok ? 'success' : 'error');
    }}, h('h3', {}, 'Submit a sponsor campaign'), field('Station ID', station), field('Campaign ID', campaign),
      field('Encrypted audio reference', audioRef, 'The ciphertext reference an enrolled endpoint returned for your sponsor audio.'),
      field('Program digest', digest), field('Rate (minor currency units)', rate), h('div', {class: 'row'}, field('Starts', start), field('Ends', end)),
      h('button', {type: 'submit'}, 'Submit campaign')));
  }
  if (has('broadcaster')) {
    const station = h('select', {'aria-label': 'Station'}, stationOptions()), campaign = input({required: true, 'aria-label': 'Campaign ID'});
    const act = action => async () => {
      if (!campaign.reportValidity()) return;
      const response = await api(`/v1/sponsor-campaigns/${action}`, {method: 'POST', body: {stationId: station.value, campaignId: campaign.value.trim()}});
      show(box, response.ok ? `Campaign ${response.data.campaignId}: ${response.data.state}.` : describe(response.status, response.data), response.ok ? 'success' : 'error');
    };
    const list = async () => {
      const response = await api(`/v1/sponsor-campaigns/active?stationId=${encodeURIComponent(station.value)}`);
      show(box, response.ok ? (response.data.campaigns.length ? `Active: ${response.data.campaigns.map(c => c.campaignId).join(', ')}` : 'No active approved campaigns.') : describe(response.status, response.data));
    };
    parts.push(h('h3', {}, 'Review campaigns for your station'), field('Station', station), field('Campaign ID', campaign),
      h('div', {class: 'row'}, h('button', {type: 'button', onclick: act('approve')}, 'Approve'),
        h('button', {type: 'button', class: 'secondary', onclick: act('revoke')}, 'Revoke'),
        h('button', {type: 'button', class: 'secondary', onclick: list}, 'List active')));
  }
  if (!parts.length) parts.push(h('p', {}, 'Sponsors need an operator-granted sponsor role; station owners review campaigns here.'));
  return card('Sponsors', ...parts, box);
}

function rewardCard() {
  const box = resultBox(), table = h('div');
  const base = input({type: 'number', min: 1, step: 1, value: 100, required: true});
  const gentle = input({type: 'number', min: 0, step: 1, value: 20, required: true});
  const acceleration = input({type: 'number', min: 0, step: 1, value: 2, required: true});
  const form = h('form', {onsubmit: async event => {
    event.preventDefault();
    const response = await api('/api/reward-prices/preview', {method: 'POST', body: {base: base.value, gentleBps: Number(gentle.value), accelerationBps: Number(acceleration.value)}});
    if (!response.ok) return show(box, describe(response.status, response.data), 'error');
    table.replaceChildren(h('table', {}, h('caption', {}, 'Point price by reward tier'), h('thead', {}, h('tr', {}, h('th', {scope: 'col'}, 'Tier'), h('th', {scope: 'col'}, 'Points'))),
      h('tbody', {}, response.data.tiers.map(row => h('tr', {}, h('th', {scope: 'row'}, String(row.tier)), h('td', {}, row.points ?? 'symbolic (too large)'))))));
    show(box, response.data.notice);
  }}, h('div', {class: 'row'}, field('Base points', base), field('Gentle growth (basis points)', gentle), field('Acceleration (basis points)', acceleration)),
    h('button', {type: 'submit'}, 'Preview prices'));
  return card('Reward prices', form, table, box);
}

function statusCard() {
  const claims = state.context?.stations ?? [];
  if (!claims.length) return null;
  const station = h('select', {'aria-label': 'Station'}, stationOptions()), box = resultBox();
  return card('Station operations', h('p', {}, 'Engine-reported schedule state. A report is never proof of audible output.'),
    h('div', {class: 'row'}, field('Station', station), h('button', {type: 'button', class: 'secondary', onclick: async () => {
      const response = await api(`/v1/stations/${encodeURIComponent(station.value)}/status`);
      show(box, response.ok ? `${response.data.state}${response.data.reason ? ` (${response.data.reason})` : ''}; schedule version ${response.data.scheduleVersion ?? 'unknown'}.` : describe(response.status, response.data));
    }}, 'Check status')), box);
}

function studioView() {
  if (!state.session.signedIn) return [h('h1', {}, 'Creator studio'), requireSignIn()];
  if (!creator()) return [h('h1', {}, 'Creator studio'), card('Creator access', h('p', {}, 'The studio is for artists and labels. Redeem an operator invitation on your account page.'), h('a', {href: '#/account'}, 'Go to account')), has('sponsor') ? sponsorCard() : null];
  return [h('h1', {}, 'Creator studio'), stationCard(), rightsCard(), programCard(), interstitialCard(), sponsorCard(), rewardCard(), statusCard(),
    h('div', {class: 'grid'},
      gatedCard('Groove settings', 'grooveSettings', 'Configure Unlocked Groove bonus recordings, cadence and rarity. Settings travel as endpoint-encrypted controls to the DRE publisher.', {path: '/v1/grooves/preview'}),
      gatedCard('Reports', 'reports', 'Issuer-verified output, processor and campaign counts, delivered encrypted to your endpoint.', {path: `/v1/reports/artist/${encodeURIComponent(state.context.subject)}`, method: 'GET'}))];
}

function reviewView() {
  if (!state.session.signedIn) return [h('h1', {}, 'Rights review'), requireSignIn()];
  if (!has('rights_reviewer')) return [h('h1', {}, 'Rights review'), card('Reviewer access', h('p', {}, 'Rights review needs an operator-granted rights_reviewer role. Reviewers cannot approve their own claims.'))];
  const box = resultBox(), item = input({required: true}), region = input({required: true, pattern: '[A-Z]{2}', value: state.context.region});
  const decision = h('select', {}, h('option', {value: 'approve'}, 'Approve'), h('option', {value: 'deny'}, 'Deny'));
  const until = input({type: 'date', required: true, value: new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10)});
  return [h('h1', {}, 'Rights review'), card('Review a pending claim', h('form', {onsubmit: async event => {
    event.preventDefault();
    const approved = decision.value === 'approve';
    const response = await api('/v1/rights/reviews', {method: 'POST', body: {itemId: item.value.trim(), region: region.value.trim(), approved,
      ...(approved ? {validUntilMs: Date.parse(until.value)} : {})}});
    show(box, response.ok ? `${response.data.itemId} in ${response.data.region}: ${response.data.state}.` : describe(response.status, response.data), response.ok ? 'success' : 'error');
  }}, field('Item ID', item), field('Region', region), field('Decision', decision), field('Review valid until', until, 'At most 366 days ahead.'), h('button', {type: 'submit'}, 'Record decision')), box)];
}

function listenView() {
  const contribution = h('div', {class: 'card'});
  contribution.innerHTML = renderContributionSetup({state: 'OFF', label: 'Off', pointsEligible: false});
  // A web page cannot prove the active output is a speaker. The route provider
  // therefore reports unverified, and setup ends in the honest UNSUPPORTED state.
  const unbind = bindContributionSetup(contribution, {requestMic: constraints => navigator.mediaDevices.getUserMedia(constraints),
    verifiedRoute: async () => ({verified: false, active: false, output: 'unknown'}), subscribeRouteChange: () => () => {}});
  cleanups.push(unbind);
  const points = h('div', {class: 'card'});
  points.innerHTML = renderLivePoints(new LivePointsView().view(state.context?.subject ?? 'listener'));
  points.append(h('p', {class: 'muted'}, 'No authenticated DRE point issuer is connected, so no provisional or vested points are shown.'));
  const reveal = h('div', {class: 'card'}, h('h2', {}, 'Unlocked Groove'), h('p', {}, 'Rare bonus recordings may unlock at the outro-to-intro transition of a live broadcast. The reveal appears only after an authenticated shared transition and grant from the station engine.'));
  const view = mountGrooveReveal(reveal); view.update({phase: 'HIDDEN'});
  const payments = feature('payments');
  const paymentsLine = payments.state === 'not_configured' ? 'Payments not configured: the operator has not supplied Stripe sandbox keys.' :
    `Payments: ${payments.state}.`;
  const checkout = gatedCard('Album checkout', 'albumCheckout', 'Buy a complete album through Stripe Checkout (sandbox). The purchase request is endpoint-encrypted and the payment page is hosted by Stripe.', {path: '/v1/album-checkouts'});
  checkout.insertBefore(h('p', {id: 'payments-state'}, h('strong', {}, paymentsLine)), checkout.querySelector('button'));
  return [h('h1', {}, 'Listener features'), !state.session.signedIn ? requireSignIn() : null,
    state.session.signedIn && !has('listener') ? card('Listener role', h('p', {}, 'Join as a listener on your account page to use these features.'), h('a', {href: '#/account'}, 'Go to account')) : null,
    contribution, points, reveal,
    h('div', {class: 'grid'}, checkout,
      gatedCard('Fan library', 'fanLibrary', 'Your purchases, point redemptions and Unlocked Grooves, delivered encrypted to your endpoint.', {path: '/v1/library', method: 'GET'}),
      gatedCard('Redeem points', 'pointRedemption', 'Spend vested artist points on a creator reward. The issuer rechecks price and spends atomically.', {path: '/v1/point-redemptions'}),
      gatedCard('Voluntary support', 'voluntarySupport', 'Tip an artist, gift an album or support a sponsor with an explicit amount.', {path: '/v1/support/intents'}),
      gatedCard('Privacy and complaints', 'privacy', 'Control profile visibility, file complaints and see moderation decisions about your account.', {path: '/v1/privacy', method: 'GET'}))];
}

function operatorView() {
  const box = resultBox();
  const tokenInput = input({type: 'password', autocomplete: 'off', 'aria-label': 'Operator token', value: state.operatorToken ?? ''});
  const call = async (path, body) => {
    state.operatorToken = tokenInput.value;
    const response = await fetch(path, {method: 'POST', headers: {authorization: `Bearer ${tokenInput.value}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    const data = await response.json().catch(() => null);
    show(box, response.ok ? JSON.stringify(data) : describe(response.status, data), response.ok ? 'success' : 'error');
  };
  const invRole = h('select', {'aria-label': 'Invitation role'}, h('option', {value: 'artist'}, 'Artist'), h('option', {value: 'label'}, 'Label'));
  const claimStation = input({'aria-label': 'Station ID', pattern: '[a-z0-9\\-]{3,80}', required: true}), claimOwner = input({'aria-label': 'Owner account reference', required: true});
  const grantSubject = input({'aria-label': 'Account reference', required: true});
  const grantRole = h('select', {'aria-label': 'Role'}, ['rights_reviewer', 'sponsor', 'moderator'].map(r => h('option', {value: r}, r)));
  const engineId = input({'aria-label': 'Engine ID', required: true}), engineStation = input({'aria-label': 'Engine station ID', required: true});
  const submit = (fn, ...inputs) => event => { event.preventDefault(); if (inputs.every(i => i.reportValidity())) fn(); };
  return [h('h1', {}, 'Operator console'), card('Operator token', h('p', {}, 'Provisioning needs the deployment operator token. It is kept in this page only and sent to /operator/v1 on this origin.'), field('Operator token', tokenInput)),
    card('Invitation', h('form', {onsubmit: submit(() => call('/operator/v1/invitations', {role: invRole.value}))}, field('Role', invRole), h('button', {type: 'submit'}, 'Create invitation'))),
    card('Station claim', h('p', {}, 'Verify station ownership out of band before provisioning.'), h('form', {onsubmit: submit(() => call('/operator/v1/station-claims', {stationId: claimStation.value.trim(), ownerSubject: claimOwner.value.trim()}), claimStation, claimOwner)},
      field('Station ID', claimStation), field('Owner account reference', claimOwner), h('button', {type: 'submit'}, 'Provision claim'))),
    card('Role grant', h('form', {onsubmit: submit(() => call('/operator/v1/grants', {subject: grantSubject.value.trim(), role: grantRole.value}), grantSubject)},
      field('Account reference', grantSubject), field('Role', grantRole), h('div', {class: 'row'}, h('button', {type: 'submit'}, 'Grant'),
        h('button', {type: 'button', class: 'secondary', onclick: () => grantSubject.reportValidity() && call('/operator/v1/grants/revoke', {subject: grantSubject.value.trim(), role: grantRole.value})}, 'Revoke')))),
    card('Station engine credential', h('form', {onsubmit: submit(() => call('/operator/v1/engine-credentials', {engineId: engineId.value.trim(), stationId: engineStation.value.trim()}), engineId, engineStation)},
      field('Engine ID', engineId), field('Station ID', engineStation), h('button', {type: 'submit'}, 'Issue credential'))),
    box];
}

// ---------------------------------------------------------------- router
const cleanups = [];
const routes = {'': homeView, discover: discoverView, account: accountView, studio: studioView, listen: listenView, review: reviewView, operator: operatorView};
const titles = {'': 'Home', discover: 'Discover', account: 'Account', studio: 'Studio', listen: 'Listen', review: 'Rights review', operator: 'Operator'};
let rendering = 0;
async function render() {
  const ticket = ++rendering;
  while (cleanups.length) { try { cleanups.pop()(); } catch {} }
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0]) || '';
  const view = routes[name] ?? homeView;
  for (const link of document.querySelectorAll('header.site nav a'))
    link.toggleAttribute('aria-current', link.getAttribute('href') === `#/${name}`) && link.setAttribute('aria-current', 'page');
  const content = await view();
  if (ticket !== rendering) return;
  main.replaceChildren(...[content].flat().filter(Boolean));
  document.title = `${titles[name] ?? 'Home'} · TrackZero`;
}
window.addEventListener('hashchange', async () => { await render(); main.focus(); });
await Promise.all([refreshSession(), refreshReadiness()]);
await render();
