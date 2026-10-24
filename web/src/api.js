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

export async function getHistory(address) {
  return get('/api/history?address=' + encodeURIComponent(address));
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
