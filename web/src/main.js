import qrcode from 'qrcode-generator';
import { initBgfx } from './bgfx.js';
import { initBetaNotice } from './beta-notice.js';
import { NETWORKS } from './caps-net.js';
import * as api from './api.js';
import * as store from './store.js';
import {
  newMnemonic, isValidMnemonic, openWallet, encryptSeed, decryptSeed,
  buildTx, capsToSats, satsToCaps,
} from './wallet.js';

const AUTO_LOCK_MS = 5 * 60 * 1000;

const state = {
  net: null,        // network params object
  vault: null,      // encrypted vault from IndexedDB
  session: null,    // { mnemonic, wallet } — in memory only
  utxos: [],
  balanceSats: 0n,
  recvIndex: 0,
  idleTimer: null,
  // Sends we broadcast this session but have not yet seen confirmed. The explorer
  // (and thus History/balance) only sees a tx once it's mined (~1 CAPS block),
  // so we surface these optimistically until they show up confirmed.
  pending: [],      // [{ txid, toAddr, amountCaps, feeCaps, at(unixSec) }]
  explorerUrl: '',  // public explorer base, learned from the history response
  contacts: [],     // address book: [{ address, label, created }]
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const app = () => document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, kind = 'info') {
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

function qrDataURL(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 8);
}

function lock() {
  state.session = null;
  state.utxos = [];
  state.balanceSats = 0n;
  clearTimeout(state.idleTimer);
  render();
}

function armIdle() {
  clearTimeout(state.idleTimer);
  if (state.session) state.idleTimer = setTimeout(lock, AUTO_LOCK_MS);
}
['click', 'keydown', 'mousemove', 'touchstart'].forEach((e) =>
  window.addEventListener(e, () => { if (state.session) armIdle(); }, { passive: true }));

// ---- boot ------------------------------------------------------------------

async function boot() {
  try {
    const n = await api.getNetwork();
    state.net = NETWORKS[n.network] || NETWORKS.main;
  } catch {
    state.net = NETWORKS.main;
  }
  state.vault = await store.loadVault();
  state.contacts = await store.loadAddressBook();
  render();
}

// ---- address book ----------------------------------------------------------

function contactFor(addr) {
  return state.contacts.find((c) => c.address === addr);
}

// A recipient shown as its label when saved, else a truncated address.
function addrLabel(addr) {
  const c = contactFor(addr);
  if (c) return esc(c.label);
  return `${esc(addr.slice(0, 10))}…${esc(addr.slice(-8))}`;
}

async function saveContact(address, label) {
  address = address.trim();
  label = (label || '').trim() || 'Unnamed';
  const existing = contactFor(address);
  if (existing) { existing.label = label; }
  else { state.contacts.unshift({ address, label, created: Date.now() }); }
  await store.saveAddressBook(state.contacts);
}

async function deleteContact(address) {
  state.contacts = state.contacts.filter((c) => c.address !== address);
  await store.saveAddressBook(state.contacts);
}

function render() {
  const root = app();
  root.innerHTML = '';
  if (!state.session && !state.vault) root.appendChild(viewOnboard());
  else if (!state.session) root.appendChild(viewLocked());
  else root.appendChild(viewDashboard());
}

// ---- onboarding ------------------------------------------------------------

function viewOnboard() {
  const v = el(`<div class="card hero-card">
    <img class="brand-logo" src="/caps-logo.png" alt="CAPS bottle-cap logo" width="132" height="132">
    <h1>CAPS Wallet</h1>
    <p class="catch">Not your keys, not your caps.</p>
    <p class="muted">A non-custodial wallet for the wasteland — your keys are generated and stored only on this device.</p>
    <div class="row">
      <button class="btn primary" data-act="create">Create new wallet</button>
      <button class="btn" data-act="restore">Restore from seed phrase</button>
    </div>
    <p class="net">network: <b>${esc(state.net.name)}</b></p>
  </div>`);
  v.addEventListener('click', (e) => {
    const a = e.target.dataset.act;
    if (a === 'create') app().replaceChildren(viewCreate());
    if (a === 'restore') app().replaceChildren(viewRestore());
  });
  return v;
}

function viewCreate() {
  const mnemonic = newMnemonic();
  const words = mnemonic.split(' ').map((w, i) => `<li><span>${i + 1}</span>${esc(w)}</li>`).join('');
  const v = el(`<div class="card">
    <h2>Your recovery phrase</h2>
    <p class="warn">Write these 12 words down in order and keep them offline. Anyone with them controls your funds. They are shown once.</p>
    <ol class="seed">${words}</ol>
    <label class="check"><input type="checkbox" id="saved"> I have written down my recovery phrase.</label>
    <div class="field"><label>Wallet password (encrypts the seed on this device)</label>
      <input type="password" id="pw" placeholder="password" autocomplete="new-password"></div>
    <div class="field"><label>Confirm password</label>
      <input type="password" id="pw2" placeholder="confirm" autocomplete="new-password"></div>
    <div class="row">
      <button class="btn" data-act="back">Back</button>
      <button class="btn primary" data-act="finish">Create wallet</button>
    </div>
  </div>`);
  v.addEventListener('click', async (e) => {
    const a = e.target.dataset.act;
    if (a === 'back') return render();
    if (a === 'finish') {
      if (!$('#saved', v).checked) return toast('Confirm you saved the phrase', 'err');
      const pw = $('#pw', v).value, pw2 = $('#pw2', v).value;
      if (pw.length < 8) return toast('Password must be at least 8 characters', 'err');
      if (pw !== pw2) return toast('Passwords do not match', 'err');
      await finalizeNew(mnemonic, pw);
    }
  });
  return v;
}

function viewRestore() {
  const v = el(`<div class="card">
    <h2>Restore wallet</h2>
    <div class="field"><label>Recovery phrase (12 or 24 words)</label>
      <textarea id="mn" rows="3" placeholder="word1 word2 ..." autocomplete="off" spellcheck="false"></textarea></div>
    <div class="field"><label>New wallet password</label>
      <input type="password" id="pw" autocomplete="new-password"></div>
    <div class="row">
      <button class="btn" data-act="back">Back</button>
      <button class="btn primary" data-act="finish">Restore</button>
    </div>
  </div>`);
  v.addEventListener('click', async (e) => {
    const a = e.target.dataset.act;
    if (a === 'back') return render();
    if (a === 'finish') {
      const mn = $('#mn', v).value.trim().replace(/\s+/g, ' ');
      const pw = $('#pw', v).value;
      if (!isValidMnemonic(mn)) return toast('Invalid recovery phrase', 'err');
      if (pw.length < 8) return toast('Password must be at least 8 characters', 'err');
      await finalizeNew(mn, pw);
    }
  });
  return v;
}

async function finalizeNew(mnemonic, password) {
  toast('Encrypting…');
  const enc = await encryptSeed(mnemonic, password);
  const vault = { ...enc, net: state.net.name, recvIndex: 0 };
  await store.saveVault(vault);
  state.vault = vault;
  state.session = { mnemonic, wallet: openWallet(mnemonic, state.net) };
  state.recvIndex = 0;
  armIdle();
  render();
  refresh();
}

// ---- locked ----------------------------------------------------------------

function viewLocked() {
  const v = el(`<div class="card hero-card">
    <img class="brand-logo" src="/caps-logo.png" alt="CAPS bottle-cap logo" width="96" height="96">
    <h1>CAPS Wallet</h1>
    <p class="catch">Welcome back to the wasteland.</p>
    <p class="muted">Enter your password to unlock.</p>
    <div class="field"><input type="password" id="pw" placeholder="password" autocomplete="current-password"></div>
    <div class="row">
      <button class="btn primary" data-act="unlock">Unlock</button>
    </div>
    <p class="net"><a href="#" data-act="forget">Forget wallet on this device</a></p>
  </div>`);
  const unlock = async () => {
    try {
      const mnemonic = await decryptSeed(state.vault, $('#pw', v).value);
      state.session = { mnemonic, wallet: openWallet(mnemonic, state.net) };
      state.recvIndex = state.vault.recvIndex || 0;
      armIdle();
      render();
      refresh();
    } catch {
      toast('Wrong password', 'err');
    }
  };
  v.addEventListener('click', async (e) => {
    const a = e.target.dataset.act;
    if (a === 'unlock') unlock();
    if (a === 'forget') {
      e.preventDefault();
      if (confirm('Erase the encrypted wallet from this device? You can only restore it with your recovery phrase.')) {
        await store.clearVault(); state.vault = null; render();
      }
    }
  });
  v.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  return v;
}

// ---- dashboard -------------------------------------------------------------

function viewDashboard() {
  const v = el(`<div class="dash">
    <header>
      <div class="brand"><img class="brand-mini" src="/caps-logo.png" alt="" width="26" height="26">CAPS <span class="badge">${esc(state.net.name)}</span></div>
      <button class="btn small" data-act="lock">Lock</button>
    </header>
    <div class="balance">
      <div class="amt"><span id="bal">—</span> <b>CAPS</b></div>
      <button class="btn small" data-act="refresh">Refresh</button>
    </div>
    <nav class="tabs">
      <button class="tab active" data-tab="receive">Receive</button>
      <button class="tab" data-tab="send">Send</button>
      <button class="tab" data-tab="history">History</button>
      <button class="tab" data-tab="addresses">Addresses</button>
    </nav>
    <div id="panel"></div>
  </div>`);
  v.addEventListener('click', (e) => {
    const a = e.target.dataset.act, tab = e.target.dataset.tab;
    if (a === 'lock') return lock();
    if (a === 'refresh') return refresh();
    if (tab) {
      v.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
      showPanel(tab);
    }
  });
  queueMicrotask(() => { showPanel('receive'); updateBalanceUI(); });
  return v;
}

function updateBalanceUI() {
  const b = $('#bal'); if (b) b.textContent = satsToCaps(state.balanceSats);
}

async function refresh() {
  try {
    const r = await api.getUtxos(state.session.wallet.allAddresses);
    state.utxos = r.utxos;
    state.balanceSats = r.utxos.reduce((s, u) => s + capsToSats(u.amount), 0n);
    updateBalanceUI();
  } catch (e) { toast(e.message, 'err'); }
}

function showPanel(tab) {
  const p = $('#panel'); if (!p) return;
  if (tab === 'receive') p.replaceChildren(panelReceive());
  if (tab === 'send') p.replaceChildren(panelSend());
  if (tab === 'history') p.replaceChildren(panelHistory());
  if (tab === 'addresses') p.replaceChildren(panelAddresses());
}

function currentReceiveAddr() {
  const list = state.session.wallet.receive;
  return list[Math.min(state.recvIndex, list.length - 1)].address;
}

function panelReceive() {
  const addr = currentReceiveAddr();
  const p = el(`<div class="panel">
    <img class="qr" alt="address QR" src="${qrDataURL(addr)}">
    <div class="addr" id="addr">${esc(addr)}</div>
    <div class="row">
      <button class="btn small" data-act="copy">Copy address</button>
      <button class="btn small" data-act="new">New address</button>
    </div>
    <p class="muted">Share this address to receive CAPS.</p>
  </div>`);
  p.addEventListener('click', async (e) => {
    const a = e.target.dataset.act;
    if (a === 'copy') { await navigator.clipboard.writeText(addr).catch(() => {}); toast('Address copied'); }
    if (a === 'new') {
      state.recvIndex = Math.min(state.recvIndex + 1, state.session.wallet.receive.length - 1);
      state.vault.recvIndex = state.recvIndex; await store.saveVault(state.vault);
      showPanel('receive');
    }
  });
  return p;
}

function panelSend() {
  const chips = state.contacts.length
    ? `<div class="chips" aria-label="Saved addresses">${state.contacts
        .map((c) => `<button class="chip" data-addr="${esc(c.address)}" title="${esc(c.address)}">${esc(c.label)}</button>`)
        .join('')}</div>`
    : '';
  const p = el(`<div class="panel">
    <div class="field"><label>Recipient address</label>
      <input id="to" placeholder="${esc(state.net.bech32)}1…" autocomplete="off" spellcheck="false">
      ${chips}</div>
    <div class="field"><label>Amount (CAPS)</label>
      <input id="amt" inputmode="decimal" placeholder="0.00000000"></div>
    <div class="row">
      <button class="btn small" data-act="max">Max</button>
      <button class="btn primary" data-act="review">Review</button>
    </div>
    <div id="review"></div>
  </div>`);
  p.addEventListener('click', async (e) => {
    const a = e.target.dataset.act;
    if (e.target.dataset.addr) { $('#to', p).value = e.target.dataset.addr; return; }
    if (a === 'max') {
      p.dataset.sendmax = '1';
      $('#amt', p).value = satsToCaps(state.balanceSats);
    }
    if (a === 'review') await doReview(p);
    if (a === 'confirm') await doSend(p, e.target);
    if (a === 'save-recipient') await saveRecipientFromSend(p);
  });
  // editing the amount cancels send-max mode
  p.addEventListener('input', (e) => { if (e.target.id === 'amt') delete p.dataset.sendmax; });
  return p;
}

// Called from the post-send card: saves the just-sent recipient with a label.
async function saveRecipientFromSend(p) {
  const wrap = $('#save-contact', p);
  if (!wrap) return;
  const addr = wrap.dataset.addr;
  const label = $('#save-label', p).value.trim();
  if (!label) return toast('Enter a name for this address', 'err');
  await saveContact(addr, label);
  toast('Saved to address book', 'ok');
  wrap.replaceChildren(el(`<p class="muted">Saved as “${esc(label)}”.</p>`));
}

function looksLikeAddr(a) {
  return a.startsWith(state.net.bech32 + '1') || /^[C1-9A-HJ-NP-Za-km-z]{25,40}$/.test(a);
}

async function doReview(p) {
  const to = $('#to', p).value.trim();
  const sendMax = p.dataset.sendmax === '1';
  if (!looksLikeAddr(to)) return toast('Recipient does not look like a CAPS address', 'err');

  let amountSats = 0n;
  if (!sendMax) {
    try { amountSats = capsToSats($('#amt', p).value.trim()); } catch { return toast('Invalid amount', 'err'); }
    if (amountSats <= 0n) return toast('Amount must be positive', 'err');
  }

  let feeRate = 1;
  try { feeRate = (await api.getFeerate()).sat_per_vbyte; } catch {}
  await refresh();

  const wallet = state.session.wallet;
  const changeAddress = wallet.change[0].address;
  let built;
  try {
    built = buildTx({ wallet, utxos: state.utxos, toAddress: to, amountSats, feeRateSatPerVB: feeRate, changeAddress, sendMax });
  } catch (e) { return toast(e.message, 'err'); }

  const rv = $('#review', p);
  rv.replaceChildren(el(`<div class="review">
    <div class="line"><span>To</span><b>${addrLabel(to)}</b></div>
    <div class="line"><span>Amount</span><b>${esc(satsToCaps(built.sendSats))} CAPS</b></div>
    <div class="line"><span>Network fee</span><b>${esc(satsToCaps(built.fee))} CAPS</b></div>
    <div class="line"><span>Inputs</span><b>${built.inputs}</b></div>
    <button class="btn primary" data-act="confirm">Confirm & send</button>
  </div>`));
  rv.dataset.hex = built.hex;
  rv.dataset.to = to;
  rv.dataset.sendcaps = satsToCaps(built.sendSats);
  rv.dataset.feecaps = satsToCaps(built.fee);
}

async function doSend(p, btn) {
  const rv = $('#review', p);
  const hex = rv.dataset.hex;
  if (!hex) return;
  btn.disabled = true; btn.textContent = 'Broadcasting…';
  try {
    const { txid } = await api.broadcast(hex);
    const amountCaps = rv.dataset.sendcaps || '';
    const feeCaps = rv.dataset.feecaps || '';
    const toAddr = rv.dataset.to || '';
    // Remember it so History shows it as pending until the explorer sees it mined.
    state.pending.unshift({ txid, toAddr, amountCaps, feeCaps, at: Math.floor(Date.now() / 1000) });
    toast('Sent! Awaiting confirmation', 'ok');
    const saveForm = contactFor(toAddr) ? '' : `<div id="save-contact" data-addr="${esc(toAddr)}" class="save-contact">
        <input id="save-label" class="save-label" placeholder="Save this address as…" autocomplete="off" maxlength="40">
        <button class="btn small" data-act="save-recipient">Save</button>
      </div>`;
    rv.replaceChildren(el(`<div class="review pending-card">
      <div class="pc-head"><span class="pc-spin" aria-hidden="true">◴</span> Sent — awaiting confirmation</div>
      <div class="line"><span>Amount</span><b>${esc(amountCaps)} CAPS</b></div>
      <div class="line"><span>To</span><b>${addrLabel(toAddr)}</b></div>
      <div class="line"><span>Network fee</span><b>${esc(feeCaps)} CAPS</b></div>
      <div class="line"><span>Transaction</span><span class="pc-tx">${txidHtml(txid)}</span></div>
      ${saveForm}
      <p class="muted pc-eta">CAPS blocks target <b>~5 minutes</b>. Your balance updates and this moves to History once it's mined — you can safely leave this page.</p>
    </div>`));
    $('#to', p).value = ''; $('#amt', p).value = '';
    delete p.dataset.sendmax;
    setTimeout(refresh, 800);
  } catch (e) {
    toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Confirm & send';
  }
}

// "3 minutes ago" / "2 days ago" — absolute timestamps are in the title.
function timeAgo(unixSec) {
  if (!unixSec) return 'pending';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return 'just now';
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, size] of units) {
    if (s >= size) return `${Math.floor(s / size)}${label} ago`;
  }
  return 'just now';
}

// A txid as an explorer link when we know the public base, else plain monospace.
function txidHtml(txid) {
  const label = `${esc(txid.slice(0, 10))}…${esc(txid.slice(-8))}`;
  const base = state.explorerUrl;
  return base
    ? `<a href="${esc(base)}/tx/${encodeURIComponent(txid)}" target="_blank" rel="noopener">${label} ↗</a>`
    : `<span class="mono">${label}</span>`;
}

// A just-broadcast send, shown in History until the explorer reports it confirmed.
function renderPendingRow(pt) {
  const to = pt.toAddr
    ? `<div class="h-peer" title="${esc(pt.toAddr)}">to ${addrLabel(pt.toAddr)}</div>`
    : '';
  return `<li class="h-row send pending">
    <div class="h-icon" aria-hidden="true">◴</div>
    <div class="h-mid">
      <div class="h-top"><span class="h-label">Sending</span>
        <span class="h-time pending-badge">pending · ~5 min</span></div>
      ${to}
      <div class="h-tx">${txidHtml(pt.txid)}</div>
    </div>
    <div class="h-amt send">−${esc(pt.amountCaps)}<small>CAPS</small>
      <div class="h-fee">awaiting confirmation</div></div>
  </li>`;
}

function panelHistory() {
  const p = el(`<div class="panel"><p class="muted">Loading history…</p></div>`);
  (async () => {
    try {
      // Whole wallet, not just the address currently on the Receive tab —
      // otherwise change and older receive addresses are invisible.
      const h = await api.getHistory(state.session.wallet.allAddresses);
      state.explorerUrl = h.explorerUrl || state.explorerUrl;
      const txs = h.txs || [];
      // A pending send that now appears in confirmed history can be retired.
      const confirmed = new Set(txs.map((t) => t.txid));
      state.pending = state.pending.filter((pt) => !confirmed.has(pt.txid));
      const pendingRows = state.pending.map(renderPendingRow).join('');
      const base = state.explorerUrl || '';
      const rows = txs.map((t) => {
        const recv = t.direction === 'receive';
        const self = t.direction === 'self';
        const label = t.coinbase ? 'Mined' : self ? 'Sent to self' : recv ? 'Received' : 'Sent';
        const sign = self ? '' : recv ? '+' : '−';
        const when = timeAgo(t.timestamp);
        const whenTitle = t.timestamp ? new Date(t.timestamp * 1000).toLocaleString() : '';
        const link = base ? `${base}/tx/${encodeURIComponent(t.txid)}` : '';
        const feeLine = t.fee > 0 ? `<div class="h-fee">fee ${esc(String(t.fee))} CAPS</div>` : '';
        const peer = t.peer && !t.coinbase
          ? `<div class="h-peer" title="${esc(t.peer)}">${recv ? 'from' : 'to'} ${addrLabel(t.peer)}</div>`
          : (t.coinbase ? '<div class="h-peer">block reward</div>' : '');
        return `<li class="h-row ${esc(t.direction)}">
          <div class="h-icon" aria-hidden="true">${t.coinbase ? '⛏' : recv ? '↓' : self ? '↻' : '↑'}</div>
          <div class="h-mid">
            <div class="h-top"><span class="h-label">${esc(label)}</span>
              <span class="h-time" title="${esc(whenTitle)}">${esc(when)}</span></div>
            ${peer}
            <div class="h-tx">${link
              ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(t.txid.slice(0, 10))}…${esc(t.txid.slice(-8))} ↗</a>`
              : `<span class="mono">${esc(t.txid.slice(0, 10))}…</span>`}
              ${t.height ? `<span class="h-height">block ${esc(String(t.height))}</span>` : ''}</div>
          </div>
          <div class="h-amt ${esc(t.direction)}">${sign}${esc(String(t.amount))}<small>CAPS</small>${feeLine}</div>
        </li>`;
      }).join('');
      if (!pendingRows && !rows) {
        p.replaceChildren(el('<div class="panel"><p class="muted">No transactions yet. Mine some CAPS or receive a payment and it will show up here.</p></div>'));
        return;
      }
      p.replaceChildren(el(`<div class="panel"><ul class="hist">${pendingRows}${rows}</ul>
        <p class="muted">Across all ${state.session.wallet.allAddresses.length} wallet addresses. Tap a transaction to open it in the explorer.</p></div>`));
    } catch (e) {
      p.replaceChildren(el(`<div class="panel"><p class="muted">History unavailable (${esc(e.message)}).</p></div>`));
    }
  })();
  return p;
}

function panelAddresses() {
  const rows = state.contacts.length
    ? state.contacts.map((c) => `<li class="ab-row" data-addr="${esc(c.address)}">
        <div class="ab-mid">
          <div class="ab-label">${esc(c.label)}</div>
          <div class="ab-addr mono" title="${esc(c.address)}">${esc(c.address.slice(0, 14))}…${esc(c.address.slice(-10))}</div>
        </div>
        <div class="ab-actions">
          <button class="btn small" data-act="ab-send">Send</button>
          <button class="btn small" data-act="ab-copy">Copy</button>
          <button class="btn small danger" data-act="ab-del">Delete</button>
        </div>
      </li>`).join('')
    : '<li class="ab-empty muted">No saved addresses yet. Add one below, or save a recipient after you send.</li>';
  const p = el(`<div class="panel">
    <ul class="abook">${rows}</ul>
    <div class="ab-add">
      <div class="field"><label>New address</label>
        <input id="ab-new-addr" placeholder="${esc(state.net.bech32)}1…" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label>Name / tag</label>
        <input id="ab-new-label" placeholder="e.g. Cold storage" autocomplete="off" maxlength="40"></div>
      <button class="btn primary" data-act="ab-add">Add to address book</button>
    </div>
  </div>`);
  p.addEventListener('click', async (e) => {
    const a = e.target.dataset.act;
    const row = e.target.closest('.ab-row');
    const addr = row && row.dataset.addr;
    if (a === 'ab-add') {
      const na = $('#ab-new-addr', p).value.trim();
      const nl = $('#ab-new-label', p).value.trim();
      if (!looksLikeAddr(na)) return toast('That does not look like a CAPS address', 'err');
      if (!nl) return toast('Give the address a name', 'err');
      await saveContact(na, nl);
      toast('Added to address book', 'ok');
      showPanel('addresses');
    }
    if (a === 'ab-copy' && addr) { await navigator.clipboard.writeText(addr).catch(() => {}); toast('Address copied'); }
    if (a === 'ab-del' && addr) { await deleteContact(addr); toast('Removed'); showPanel('addresses'); }
    if (a === 'ab-send' && addr) {
      const sendTab = document.querySelector('.tab[data-tab="send"]');
      if (sendTab) sendTab.click();
      queueMicrotask(() => { const to = $('#to'); if (to) to.value = addr; });
    }
  });
  return p;
}

initBgfx();
initBetaNotice();
boot();
