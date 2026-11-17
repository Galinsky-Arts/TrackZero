// Transactional email through the Resend HTTP API. OFF unless both
// RESEND_API_KEY and TZ_MAIL_FROM are set; the key is never echoed or logged.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const ADDRESS = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,63}$/;

export function createMailer({apiKey, from} = {}, {fetchImpl = fetch, timeoutMs = 10_000} = {}) {
  const configured = Boolean(apiKey && from);
  const missing = [!apiKey && 'RESEND_API_KEY', !from && 'TZ_MAIL_FROM'].filter(Boolean);
  return {
    configured,
    snapshot() {
      return configured ? {state: 'configured', provider: 'resend'}
        : {state: 'not_configured', needs: `set ${missing.join(' and ')} to enable email`};
    },
    async send({to, subject, text, html}) {
      if (!configured) throw new Error('MAIL_NOT_CONFIGURED');
      if (typeof to !== 'string' || !ADDRESS.test(to)) throw new Error('INVALID_RECIPIENT');
      const response = await fetchImpl(RESEND_ENDPOINT, {method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: {authorization: `Bearer ${apiKey}`, 'content-type': 'application/json'},
        body: JSON.stringify({from, to: [to], subject, text, ...(html ? {html} : {})})});
      if (!response.ok) throw new Error(`MAIL_SEND_FAILED_${response.status}`);
      return true;
    }
  };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

/** Reset link points at the web UI's hash route, so the token never reaches
 * server logs or Referer headers; the UI posts it to /api/auth/reset-password. */
export function passwordResetMessage({origin, token, minutes}) {
  const link = `${origin}/#/reset/${encodeURIComponent(token)}`;
  const text = `Someone asked to reset the password of your TrackZero account.\n\n` +
    `Open this link within ${minutes} minutes to choose a new password:\n${link}\n\n` +
    `If you did not ask for this, ignore this email; your password stays the same. ` +
    `Resetting signs out every existing session.`;
  const html = `<p>Someone asked to reset the password of your TrackZero account.</p>` +
    `<p><a href="${escapeHtml(link)}">Choose a new password</a> (valid for ${minutes} minutes).</p>` +
    `<p>If you did not ask for this, ignore this email; your password stays the same. Resetting signs out every existing session.</p>`;
  return {subject: 'Reset your TrackZero password', text, html};
}
