// Planning HTTP transport. Callers supply CSRF and Idempotency-Key headers;
// this module only normalizes responses and error messages.
async function api(path, init = {}) { const r = await fetch(path, { ...init, headers: { 'Accept': 'application/json', ...init.headers } }); if (r.redirected) throw new Error('Session expired. Reload the page to sign in.'); if (r.status === 204) return null; let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); } if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`); return data; }
function requestKey() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }

export {api, requestKey};
