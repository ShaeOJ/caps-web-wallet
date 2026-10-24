// wallet.js — all key material lives here and never leaves the browser.
//
// - BIP39 mnemonic -> BIP32 (BIP84 P2WPKH) with CAPS params
// - scrypt -> AES-GCM vault encryption (Web Crypto) for at-rest seed storage
// - client-side coin selection + tx build + sign (@scure/btc-signer)

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { pathFor } from './caps-net.js';

export const GAP_LIMIT = 20;
export const DUST_SATS = 294n; // p2wpkh dust floor

export function newMnemonic() {
  return bip39.generateMnemonic(wordlist, 128); // 12 words
}

export function isValidMnemonic(m) {
  return bip39.validateMnemonic(m.trim().replace(/\s+/g, ' '), wordlist);
}

// Build an address book + key lookup for a mnemonic on a given network.
// Returns derived receive/change addresses and a keyFor(address) -> privkey.
export function openWallet(mnemonic, net, count = GAP_LIMIT) {
  const seed = bip39.mnemonicToSeedSync(mnemonic.trim().replace(/\s+/g, ' '));
  const root = HDKey.fromMasterSeed(seed);

  const byAddress = new Map(); // address -> { priv, pub, chain, index }
  const receive = [];
  const change = [];

  for (const chain of [0, 1]) {
    for (let i = 0; i < count; i++) {
      const node = root.derive(pathFor(chain, i));
      const p2 = btc.p2wpkh(node.publicKey, net);
      const entry = { address: p2.address, script: p2.script, priv: node.privateKey, pub: node.publicKey, chain, index: i };
      byAddress.set(p2.address, entry);
      (chain === 0 ? receive : change).push(entry);
    }
  }
  return {
    net,
    receive,
    change,
    allAddresses: [...byAddress.keys()],
    keyFor: (addr) => byAddress.get(addr),
    scriptFor: (addr) => byAddress.get(addr)?.script,
  };
}

// ---- vault encryption ------------------------------------------------------

// Memory-hard KDF. scrypt (pure JS, audited) keeps CSP at `script-src 'self'`
// with no wasm/eval exceptions. N=2^17 ≈ 128 MB — OWASP-recommended work factor.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, dkLen: 32, maxmem: 256 * 1024 * 1024 };

async function deriveKey(password, salt, params = SCRYPT) {
  const pw = new TextEncoder().encode(password);
  const raw = await scryptAsync(pw, salt, params);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSeed(mnemonic, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, SCRYPT);
  const pt = new TextEncoder().encode(mnemonic.trim().replace(/\s+/g, ' '));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  // KDF params are stored so tuning them later never strands an existing vault.
  return {
    v: 2,
    kdf: { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, dkLen: SCRYPT.dkLen },
    salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct),
  };
}

export async function decryptSeed(vault, password) {
  const k = vault.kdf || {};
  // v1 vaults (pre-param-storage) used N=2^15; honour that for back-compat.
  const params = {
    N: k.N || 1 << 15, r: k.r || 8, p: k.p || 1, dkLen: k.dkLen || 32,
    maxmem: 256 * 1024 * 1024,
  };
  const key = await deriveKey(password, hexToBytes(vault.salt), params);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(vault.iv) },
    key,
    hexToBytes(vault.ct),
  );
  return new TextDecoder().decode(pt);
}

// ---- amounts ---------------------------------------------------------------

export function capsToSats(caps) {
  // string-safe conversion, 8 decimals
  const [whole, frac = ''] = String(caps).split('.');
  const fracPad = (frac + '00000000').slice(0, 8);
  return BigInt(whole || '0') * 100000000n + BigInt(fracPad || '0');
}

export function satsToCaps(sats) {
  const s = BigInt(sats);
  const whole = s / 100000000n;
  const frac = (s % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---- coin selection + sign -------------------------------------------------

// rough p2wpkh vsize estimate
function estVsize(nIn, nOut) {
  return 11 + nIn * 68 + nOut * 31;
}

// Defensive clamp: even if the server reports a pathological fee rate, never
// build a tx above this. The confirm screen also shows the fee to the user.
const MAX_FEERATE = 10000; // sat/vByte

// utxos: [{txid, vout, amount(float CAPS), address}]
// sendMax: ignore amountSats and sweep the whole balance (minus fee) to toAddress.
// Returns { hex, fee, change, inputs, withChange, sendSats } or throws.
export function buildTx({ wallet, utxos, toAddress, amountSats, feeRateSatPerVB, changeAddress, sendMax = false }) {
  const net = wallet.net;
  const spendable = utxos
    .map((u) => ({ ...u, sats: capsToSats(u.amount) }))
    .sort((a, b) => (a.sats < b.sats ? 1 : -1)); // largest first
  if (spendable.length === 0) throw new Error('no spendable funds');

  const feeRate = BigInt(Math.min(MAX_FEERATE, Math.max(1, Math.ceil(feeRateSatPerVB))));

  let chosen = [];
  let sum = 0n;
  let fee;
  let change = 0n;
  let withChange = false;
  let sendSats;

  if (sendMax) {
    chosen = spendable;
    sum = chosen.reduce((s, u) => s + u.sats, 0n);
    fee = feeRate * BigInt(estVsize(chosen.length, 1));
    sendSats = sum - fee;
    if (sendSats <= DUST_SATS) throw new Error('balance too low to cover the fee');
  } else {
    const target = BigInt(amountSats);
    if (target <= 0n) throw new Error('amount must be positive');
    for (const u of spendable) {
      chosen.push(u);
      sum += u.sats;
      if (sum >= target + feeRate * BigInt(estVsize(chosen.length, 2))) break;
    }
    fee = feeRate * BigInt(estVsize(chosen.length, 2));
    change = sum - target - fee;
    withChange = true;
    if (change < DUST_SATS) {
      // change would be dust — drop the change output, fold remainder into fee
      fee = feeRate * BigInt(estVsize(chosen.length, 1));
      change = 0n;
      withChange = false;
    }
    if (sum < target + fee) throw new Error('insufficient funds for amount + fee');
    sendSats = target;
  }

  // runaway-fee guard: refuse to pay more in fees than we are sending
  if (fee > sendSats) throw new Error('fee exceeds amount — aborting');

  const tx = new btc.Transaction();
  for (const u of chosen) {
    const entry = wallet.keyFor(u.address);
    if (!entry) throw new Error('no key for input ' + u.address);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: entry.script, amount: u.sats },
    });
  }
  tx.addOutputAddress(toAddress, sendSats, net);
  if (withChange) tx.addOutputAddress(changeAddress, change, net);

  // sign each input with its own key
  for (let i = 0; i < chosen.length; i++) {
    tx.signIdx(wallet.keyFor(chosen[i].address).priv, i);
  }
  tx.finalize();

  return { hex: tx.hex, fee, change, inputs: chosen.length, withChange, sendSats };
}

export { bytesToHex };
