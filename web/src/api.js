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

export async function getCards(addresses) {
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return get('/api/cards?addresses=' + encodeURIComponent(list.join(',')));
}

export async function getSidechainInfo() {
  return get('/api/sidechain/info');
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

export async function saveRecipe(recipeHash, recipe) {
  const r = await fetch('/api/cards/recipe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe_hash: recipeHash, recipe }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `save recipe failed (${r.status})`);
  return j;
}

export async function getRecipe(recipeHash) {
  return get('/api/cards/recipe?hash=' + encodeURIComponent(recipeHash));
}

export async function getMarketOrders() {
  return get('/api/market/orders');
}

export async function postMarketOrder(order) {
  const r = await fetch('/api/market/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `post market order failed (${r.status})`);
  return j;
}

export async function deleteMarketOrder(orderId) {
  const r = await fetch('/api/market/orders?order_id=' + encodeURIComponent(orderId), {
    method: 'DELETE',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `cancel order failed (${r.status})`);
  return j;
}
