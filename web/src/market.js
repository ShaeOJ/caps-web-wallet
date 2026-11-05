/**
 * Wasteland Trading Post (CAPC P2P Exchange) Protocol Engine for Web Wallet.
 * Trustless atomic card swaps using SIGHASH_SINGLE | SIGHASH_ANYONECANPAY PSBTs.
 */

import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { capsToSats, satsToCaps } from './wallet.js';

export const CAPC_MAGIC = new Uint8Array([0x43, 0x41, 0x50, 0x43]); // 'CAPC'

export const OP_TRANSFER = 0x02; // Single-use seal card transfer
export const OP_FORGE = 0x04;    // Custom 1-of-1 cap minting (burn 50 BCAP)
export const OP_LIST = 0x06;     // P2P Marketplace listing announcement (burn 100 BCAP fee)
export const OP_CANCEL = 0x08;   // Listing cancellation signal

export const SATS_PER_COIN = 100_000_000n;
export const LISTING_FEE_SATS = 100n * SATS_PER_COIN;   // 100 BCAP listing fee
export const CARD_SEAL_DUST_SATS = 1000n;                // 0.00001000 BCAP dust carried by seal
export const MIN_FEE_SATS = 2500n;

/**
 * Encodes a 22-byte OP_LIST payload.
 * [0..4]:   "CAPC" (4 bytes)
 * [4]:      0x06 (OP_LIST)
 * [5..9]:   cardId (uint32 LE)
 * [9..13]:  serial (uint32 LE)
 * [13..21]: priceSats (uint64 LE)
 * [21]:     0x00 (flags)
 */
export function encodeOpList(cardId, serial, priceSats) {
  const buf = new Uint8Array(22);
  buf.set(CAPC_MAGIC, 0);
  buf[4] = OP_LIST;
  const view = new DataView(buf.buffer);
  view.setUint32(5, cardId, true);
  view.setUint32(9, serial, true);
  view.setBigUint64(13, BigInt(priceSats), true);
  buf[21] = 0x00;
  return buf;
}

/**
 * Decodes an OP_LIST payload.
 */
export function decodeOpList(bytes) {
  if (bytes.length < 22) return null;
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== CAPC_MAGIC[i]) return null;
  }
  if (bytes[4] !== OP_LIST) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cardId = view.getUint32(5, true);
  const serial = view.getUint32(9, true);
  const priceSats = view.getBigUint64(13, true);
  const flags = bytes[21];

  return { cardId, serial, priceSats, flags };
}

/**
 * Encodes a 14-byte OP_TRANSFER payload.
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
 * Seller Step 1: Builds and signs the on-chain 100 BCAP Listing Fee Transaction.
 * Spends 100 BCAP -> VOUT 0 OP_RETURN (OP_LIST) + VOUT 1 Change.
 * Burns/pays 100 BCAP to miners as anti-spam proof-of-stake.
 */
export function buildListingProofTx({
  wallet,
  utxos,
  cardId,
  serial,
  priceCaps,
  changeAddress,
  feeRateSatPerVB = 10,
}) {
  const net = wallet.net;
  const priceSats = capsToSats(priceCaps);
  const target = LISTING_FEE_SATS; // 100 BCAP listing fee
  const feeRate = BigInt(Math.max(1, Math.ceil(feeRateSatPerVB)));

  const spendable = utxos
    .map((u) => ({ ...u, sats: u.sats || capsToSats(u.amount) }))
    .sort((a, b) => (a.sats < b.sats ? 1 : -1));

  const chosen = [];
  let sum = 0n;

  for (const u of spendable) {
    chosen.push(u);
    sum += u.sats;
    const estFee = feeRate * BigInt(68 * chosen.length + 100);
    if (sum >= target + estFee) break;
  }

  const fee = feeRate * BigInt(68 * chosen.length + 100);
  if (sum < target + fee) {
    throw new Error(
      `Insufficient balance for 100 BCAP listing fee. Needed: ${(Number(target + fee) / 1e8).toFixed(4)} BCAP, available: ${(Number(sum) / 1e8).toFixed(4)} BCAP.`
    );
  }

  let change = sum - target - fee;
  let withChange = true;
  if (change < 1000n) {
    change = 0n;
    withChange = false;
  }

  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  for (const u of chosen) {
    const entry = wallet.keyFor(u.address);
    if (!entry) throw new Error(`Missing private key for address ${u.address}`);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: entry.script, amount: u.sats },
    });
  }

  // Output 0: OP_RETURN OP_LIST announcement (burning 100 BCAP)
  const opPayload = encodeOpList(cardId, serial, priceSats);
  const opScript = btc.Script.encode(['RETURN', opPayload]);
  tx.addOutput({ script: opScript, amount: 0n });

  // Output 1: Change
  if (withChange) {
    tx.addOutputAddress(changeAddress, change, net);
  }

  for (let i = 0; i < chosen.length; i++) {
    const entry = wallet.keyFor(chosen[i].address);
    tx.signIdx(entry.priv, i);
  }
  tx.finalize();

  return { hex: tx.hex, txid: tx.id, feeSats: fee };
}

/**
 * Seller Step 2: Builds and signs the Atomic Order Slip (Partial PSBT).
 * Input 0: Card Seal UTXO
 * Output 0: Seller payout address receiving 100% of priceSats.
 * Signed with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY.
 */
export function buildOrderSlip({
  cardUtxo,
  cardKey,
  sellerAddress,
  priceCaps,
  net,
}) {
  const priceSats = capsToSats(priceCaps);
  const sealSats = cardUtxo.amountSats || CARD_SEAL_DUST_SATS;

  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  // Input 0: Card Seal UTXO
  tx.addInput({
    txid: cardUtxo.txid,
    index: cardUtxo.vout,
    witnessUtxo: { script: cardKey.script, amount: sealSats },
    sighashType: btc.SigHash.SINGLE_ANYONECANPAY,
  });

  // Output 0: Seller payout address receiving exactly priceSats (100% to Lister)
  tx.addOutputAddress(sellerAddress, priceSats, net);

  // Sign Input 0 with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY
  tx.signIdx(cardKey.priv, 0, [btc.SigHash.SINGLE_ANYONECANPAY]);

  // Export to Base64 PSBT
  const psbtBytes = tx.toPSBT();
  const psbtBase64 = base64.encode(psbtBytes);

  return { psbtBase64, priceSats };
}

/**
 * Verifies an incoming Order Slip PSBT before display or fulfillment.
 */
export function verifyOrderSlip({
  psbtBase64,
  expectedCardUtxo,
  expectedSellerAddress,
  expectedPriceSats,
}) {
  try {
    const psbtBytes = base64.decode(psbtBase64);
    const tx = btc.Transaction.fromPSBT(psbtBytes, { allowUnknownOutputs: true });

    if (tx.inputsLength !== 1) {
      return { valid: false, error: 'Order slip must contain exactly 1 input (card UTXO).' };
    }
    if (tx.outputsLength < 1) {
      return { valid: false, error: 'Order slip must contain Output 0 for seller payment.' };
    }

    const [cardTxid, cardVoutStr] = expectedCardUtxo.split(':');
    const cardVout = parseInt(cardVoutStr, 10);
    const in0 = tx.getInput(0);

    const in0Txid = in0.txid ? (typeof in0.txid === 'string' ? in0.txid : bytesToHex(in0.txid)) : '';
    if (in0Txid !== cardTxid || in0.index !== cardVout) {
      return { valid: false, error: 'Order slip input does not match expected card UTXO.' };
    }

    const out0 = tx.getOutput(0);
    if (out0.amount !== expectedPriceSats) {
      return {
        valid: false,
        error: `Order slip output 0 amount ${out0.amount} does not match expected price ${expectedPriceSats}.`,
      };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Buyer Step 3: Fulfills the Order Slip atomically.
 * Takes the seller's PSBT, appends buyer funding inputs (paying priceSats + fee),
 * appends OP_TRANSFER + Card Seal to Buyer + Buyer Change, signs, and finalizes.
 */
export function fulfillOrderSlip({
  psbtBase64,
  cardId,
  serial,
  buyerAddress,
  buyerUtxos,
  wallet,
  changeAddress,
  feeRateSatPerVB = 10,
}) {
  const net = wallet.net;
  const psbtBytes = base64.decode(psbtBase64);
  const tx = btc.Transaction.fromPSBT(psbtBytes, { allowUnknownOutputs: true });

  const priceSats = tx.getOutput(0).amount;
  if (!priceSats || priceSats <= 0n) {
    throw new Error('Invalid order slip: Output 0 price amount missing.');
  }

  const feeRate = BigInt(Math.max(1, Math.ceil(feeRateSatPerVB)));
  const targetFunds = priceSats + CARD_SEAL_DUST_SATS; // Price + 1000 sats seal

  // Select buyer UTXOs to fund the purchase
  const spendable = buyerUtxos
    .map((u) => ({ ...u, sats: u.sats || capsToSats(u.amount) }))
    .sort((a, b) => (a.sats < b.sats ? 1 : -1));

  const chosenBuyerUtxos = [];
  let sumBuyer = 0n;

  for (const u of spendable) {
    chosenBuyerUtxos.push(u);
    sumBuyer += u.sats;
    const estFee = feeRate * BigInt(68 * (chosenBuyerUtxos.length + 1) + 160);
    if (sumBuyer >= targetFunds + estFee) break;
  }

  const fee = feeRate * BigInt(68 * (chosenBuyerUtxos.length + 1) + 160);
  if (sumBuyer < targetFunds + fee) {
    throw new Error(
      `Insufficient funds to buy card. Needed: ${(Number(targetFunds + fee) / 1e8).toFixed(4)} BCAP, available: ${(Number(sumBuyer) / 1e8).toFixed(4)} BCAP.`
    );
  }

  let change = sumBuyer - targetFunds - fee;
  let withChange = true;
  if (change < 1000n) {
    change = 0n;
    withChange = false;
  }

  // Append buyer funding inputs (Input 1..N)
  for (const u of chosenBuyerUtxos) {
    const entry = wallet.keyFor(u.address);
    if (!entry) throw new Error(`Missing buyer private key for address ${u.address}`);
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: entry.script, amount: u.sats },
    });
  }

  // Output 1: OP_RETURN OP_TRANSFER payload
  const opPayload = encodeOpTransfer(cardId, serial);
  const opScript = btc.Script.encode(['RETURN', opPayload]);
  tx.addOutput({ script: opScript, amount: 0n });

  // Output 2: Transferred Card Seal to Buyer
  tx.addOutputAddress(buyerAddress, CARD_SEAL_DUST_SATS, net);

  // Output 3: Buyer Change
  if (withChange) {
    tx.addOutputAddress(changeAddress, change, net);
  }

  // Sign all buyer inputs (Input 1 to inputsLength - 1)
  for (let i = 1; i < tx.inputsLength; i++) {
    const inUtxo = chosenBuyerUtxos[i - 1];
    const entry = wallet.keyFor(inUtxo.address);
    tx.signIdx(entry.priv, i);
  }

  // Finalize full atomic transaction
  tx.finalize();

  return {
    txHex: tx.hex,
    txid: tx.id,
    totalPaidSats: priceSats + fee + CARD_SEAL_DUST_SATS,
  };
}

