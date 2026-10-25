// api.js — thin client for the stateless relay. Same-origin only (CSP connect-src 'self').

async function get(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
}

export async function getNetwork() {
  return get('/api/network');
}

export async function getUtxos(addresses) {
  return get('/api/utxos?addresses=' + encodeURIComponent(addresses.join(',')));
}

export async function getFeerate() {
  return get('/api/feerate');
}

// History for the whole wallet, not just one address — the server resolves each
// transaction's direction and amount so the client never has to fan out.
export async function getHistory(addresses) {
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return get('/api/history?addresses=' + encodeURIComponent(list.join(',')));
}

export async function broadcast(hex) {
  const r = await fetch('/api/broadcast', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hex }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `broadcast failed (${r.status})`);
  return j; // { txid }
}
