import qrcode from 'qrcode-generator';
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
  render();
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
  const p = el(`<div class="panel">
    <div class="field"><label>Recipient address</label>
      <input id="to" placeholder="${esc(state.net.bech32)}1…" autocomplete="off" spellcheck="false"></div>
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
    if (a === 'max') {
      p.dataset.sendmax = '1';
      $('#amt', p).value = satsToCaps(state.balanceSats);
    }
    if (a === 'review') await doReview(p);
    if (a === 'confirm') await doSend(p, e.target);
  });
  // editing the amount cancels send-max mode
  p.addEventListener('input', (e) => { if (e.target.id === 'amt') delete p.dataset.sendmax; });
  return p;
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
    <div class="line"><span>To</span><b>${esc(to.slice(0, 10))}…${esc(to.slice(-8))}</b></div>
    <div class="line"><span>Amount</span><b>${esc(satsToCaps(built.sendSats))} CAPS</b></div>
    <div class="line"><span>Network fee</span><b>${esc(satsToCaps(built.fee))} CAPS</b></div>
    <div class="line"><span>Inputs</span><b>${built.inputs}</b></div>
    <button class="btn primary" data-act="confirm">Confirm & send</button>
  </div>`));
  rv.dataset.hex = built.hex;
}

async function doSend(p, btn) {
  const hex = $('#review', p).dataset.hex;
  if (!hex) return;
  btn.disabled = true; btn.textContent = 'Broadcasting…';
  try {
    const { txid } = await api.broadcast(hex);
    toast('Sent! txid ' + txid.slice(0, 12) + '…', 'ok');
    $('#review', p).replaceChildren(el(`<div class="review ok">
      <div class="line"><span>Broadcast</span><b>${esc(txid)}</b></div></div>`));
    $('#to', p).value = ''; $('#amt', p).value = '';
    setTimeout(refresh, 800);
  } catch (e) {
    toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Confirm & send';
  }
}

function panelHistory() {
  const p = el(`<div class="panel"><p class="muted">Loading history…</p></div>`);
  (async () => {
    try {
      const addr = currentReceiveAddr();
      const h = await api.getHistory(addr);
      const txs = (h.last_txs || h.txs || []);
      if (!txs.length) { p.replaceChildren(el('<div class="panel"><p class="muted">No transactions for this address yet.</p></div>')); return; }
      const rows = txs.slice(0, 25).map((t) => `<li><a class="mono" title="${esc(t.addresses || t.txid || '')}">${esc((t.addresses || t.txid || '').slice(0, 20))}…</a>
        <span>${esc(satsToCaps(BigInt(Math.round((t.amount || 0)))))}</span></li>`).join('');
      p.replaceChildren(el(`<div class="panel"><ul class="hist">${rows}</ul>
        <p class="muted">Showing activity for the current receive address.</p></div>`));
    } catch (e) {
      p.replaceChildren(el(`<div class="panel"><p class="muted">History unavailable (${esc(e.message)}).</p></div>`));
    }
  })();
  return p;
}

boot();
