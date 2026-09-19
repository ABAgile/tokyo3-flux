// Planning HTTP transport. Callers supply CSRF and Idempotency-Key headers;
// this module only normalizes responses and error messages.
async function api(path, init = {}) { const r = await fetch(path, { ...init, headers: { 'Accept': 'application/json', ...init.headers } }); if (r.redirected) throw new Error('Session expired. Reload the page to sign in.'); if (r.status === 204) return null; let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); } if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`); return data; }
// Conditional read. Planning responses are no-store, so the browser never
// revalidates on its own; the caller keeps the last ETag and passes it back,
// and an unchanged resource answers with an empty 304.
async function apiRevalidated(path, etag = '') {
 const headers = {'Accept': 'application/json'}; if (etag) headers['If-None-Match'] = etag;
 const r = await fetch(path, {headers});
 if (r.redirected) throw new Error('Session expired. Reload the page to sign in.');
 if (r.status === 304) return {modified: false, etag: r.headers.get('ETag') || etag, data: undefined};
 let data; try { data = await r.json(); } catch { throw new Error('Planning service unavailable. Refresh to retry.'); }
 if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
 return {modified: true, etag: r.headers.get('ETag') || '', data};
}
function requestKey() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }

export {api, apiRevalidated, requestKey};
