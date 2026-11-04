/**
 * CAPC Wire Codec & Transaction Builder for Web Wallet.
 * Builds single-use-seal card transfers and 500 BCAP forge burn transactions client-side.
 */

import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { capsToSats, DUST_SATS } from './wallet.js';

export const CAPC_MAGIC = new Uint8Array([0x43, 0x41, 0x50, 0x43]); // 'CAPC'
export const OP_TRANSFER = 0x02;
export const OP_FORGE = 0x04;
export const FORGE_FEE_SATS = 50000000000n; // 500 BCAP in satoshis

/**
 * Encodes a 14-byte OP_TRANSFER payload.
 * [0..4]: "CAPC"
 * [4]:    0x02
 * [5..9]: cardId (uint32 LE)
 * [9..13]: serial (uint32 LE)
 * [13]:   0x00
 */
export function encodeOpTransfer(cardId, serial) {
  const buf = new Uint8Array(14);
  buf.set(CAPC_MAGIC, 0);
  buf[4] = OP_TRANSFER;
  const view = new DataView(buf.buffer);
  view.setUint32(5, cardId, true);
  view.setUint32(9, serial, true);
  buf[13] = 0x00;
  return buf;
}

/**
 * Encodes a 43-byte OP_FORGE payload.
 * [0..4]: "CAPC"
 * [4]:    0x04
 * [5..7]: collectionId (uint16 LE)
 * [7..11]: nonce (uint32 LE)
 * [11..43]: recipeHash (32 bytes)
 */
export function encodeOpForge(collectionId, nonce, recipeHashBytes) {
  const buf = new Uint8Array(43);
  buf.set(CAPC_MAGIC, 0);
  buf[4] = OP_FORGE;
  const view = new DataView(buf.buffer);
  view.setUint16(5, collectionId, true);
  view.setUint32(7, nonce, true);
  buf.set(recipeHashBytes, 11);
  return buf;
}

/**
 * Computes canonical SHA-256 hash of custom design recipe JSON.
 */
export function computeRecipeHash(recipe) {
  // Sort keys alphabetically and stringify with no whitespace
  const sorted = {};
  Object.keys(recipe).sort().forEach((k) => {
    sorted[k] = recipe[k];
  });
  const canonicalJson = JSON.stringify(sorted);
  const hashBytes = sha256(new TextEncoder().encode(canonicalJson));
  return { hashBytes, hashHex: bytesToHex(hashBytes) };
}

/**
 * Builds and signs a card transfer transaction.
 * Spends cardUtxo -> VOUT 0 to new owner + VOUT 1 OP_RETURN (OP_TRANSFER) + VOUT 2 change.
 */
export function buildTransferCardTx({
  wallet,
  card,
  utxos,
  toAddress,
  changeAddress,
  feeRateSatPerVB = 10
}) {
  const net = wallet.net;
  const [cardTxid, cardVoutStr] = card.utxo.split(':');
  const cardVout = parseInt(cardVoutStr, 10);

  // Find the specific UTXO holding the card seal
  const cardUtxo = utxos.find((u) => u.txid === cardTxid && u.vout === cardVout);
  if (!cardUtxo) {
    throw new Error(`Card UTXO ${card.utxo} not found in available wallet funds.`);
  }

  const cardKey = wallet.keyFor(cardUtxo.address);
  if (!cardKey) {
    throw new Error(`No private key for card address ${cardUtxo.address}`);
  }

  const cardSats = capsToSats(cardUtxo.amount);
  const cardTransferDust = 1000n; // 1000 sats carried by card seal

  // Collect funding inputs
  const chosen = [{ ...cardUtxo, sats: cardSats, isCard: true }];
  let sum = cardSats;

  // Estimate fee: 1 card in + N fund in, 3 out (to, op_return, change)
  const feeRate = BigInt(Math.max(1, Math.ceil(feeRateSatPerVB)));
  let fee = feeRate * 180n; // baseline ~180 vB

  if (sum < cardTransferDust + fee) {
    // Add additional wallet UTXOs to cover fee
    for (const u of utxos) {
      if (u.txid === cardTxid && u.vout === cardVout) continue;
      const uSats = capsToSats(u.amount);
      chosen.push({ ...u, sats: uSats, isCard: false });
      sum += uSats;
      fee = feeRate * BigInt(68 * chosen.length + 100);
      if (sum >= cardTransferDust + fee) break;
    }
  }

  if (sum < cardTransferDust + fee) {
    throw new Error(`Insufficient balance to cover transfer fee (${fee} sats required).`);
  }

  let change = sum - cardTransferDust - fee;
  let withChange = true;
  if (change < DUST_SATS) {
    fee += change;
    change = 0n;
    withChange = false;
  }

  // Allow OP_RETURN output
  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  // Add inputs
  for (const u of chosen) {
    const entry = wallet.keyFor(u.address);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: entry.script, amount: u.sats },
    });
  }

  // Output 0: Transferred card UTXO to recipient
  tx.addOutputAddress(toAddress, cardTransferDust, net);

  // Output 1: OP_RETURN OP_TRANSFER payload
  const opPayload = encodeOpTransfer(card.card_id, card.serial);
  const opScript = btc.Script.encode(['RETURN', opPayload]);
  tx.addOutput({ script: opScript, amount: 0n });

  // Output 2: Change output
  if (withChange) {
    tx.addOutputAddress(changeAddress, change, net);
  }

  // Sign all inputs
  for (let i = 0; i < chosen.length; i++) {
    tx.signIdx(wallet.keyFor(chosen[i].address).priv, i);
  }
  tx.finalize();

  return { hex: tx.hex, fee, change, toAddress, cardId: card.card_id, serial: card.serial };
}

/**
 * Builds and signs a 500 BCAP burn transaction to forge a custom cap.
 * VOUT 0 OP_RETURN (OP_FORGE) + VOUT 1 new card UTXO + VOUT 2 change.
 */
export function buildForgeCapTx({
  wallet,
  utxos,
  creatorAddress,
  changeAddress,
  recipe,
  feeRateSatPerVB = 10
}) {
  const net = wallet.net;
  const feeRate = BigInt(Math.max(1, Math.ceil(feeRateSatPerVB)));
  const { hashBytes, hashHex } = computeRecipeHash(recipe);

  // Gather UTXOs to cover 500 BCAP + dust + fee
  const spendable = utxos
    .map((u) => ({ ...u, sats: capsToSats(u.amount) }))
    .sort((a, b) => (a.sats < b.sats ? 1 : -1));

  const chosen = [];
  let sum = 0n;
  const target = FORGE_FEE_SATS + 1000n; // 500 BCAP burn + 1000 sats card seal

  for (const u of spendable) {
    chosen.push(u);
    sum += u.sats;
    const estFee = feeRate * BigInt(68 * chosen.length + 120);
    if (sum >= target + estFee) break;
  }

  const fee = feeRate * BigInt(68 * chosen.length + 120);
  if (sum < target + fee) {
    throw new Error(`Insufficient funds to forge cap. 500 BCAP + fee required, available: ${(Number(sum) / 1e8).toFixed(4)} BCAP.`);
  }

  let change = sum - target - fee;
  let withChange = true;
  if (change < DUST_SATS) {
    change = 0n;
    withChange = false;
  }

  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  for (const u of chosen) {
    const entry = wallet.keyFor(u.address);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: entry.script, amount: u.sats },
    });
  }

  // Output 0: OP_RETURN OP_FORGE payload (burning 500 BCAP)
  const nonce = Math.floor(Math.random() * 0xffffffff);
  const opPayload = encodeOpForge(0, nonce, hashBytes);
  const opScript = btc.Script.encode(['RETURN', opPayload]);
  tx.addOutput({ script: opScript, amount: 0n });

  // Output 1: Minted 1-of-1 Card UTXO to creator
  tx.addOutputAddress(creatorAddress, 1000n, net);

  // Output 2: Change
  if (withChange) {
    tx.addOutputAddress(changeAddress, change, net);
  }

  for (let i = 0; i < chosen.length; i++) {
    tx.signIdx(wallet.keyFor(chosen[i].address).priv, i);
  }
  tx.finalize();

  return {
    hex: tx.hex,
    fee,
    change,
    recipeHash: hashHex,
    creatorAddress,
    recipe
  };
}
