/**
 * Unit & Integration Test for Bottlecaps (CAPC) Web Wallet features.
 * Tests wire codec, recipe hashing, transfer tx building, and forge burn tx building.
 */

import assert from 'node:assert';
import * as btc from '@scure/btc-signer';
import { NETWORKS } from './src/caps-net.js';
import { openWallet, newMnemonic } from './src/wallet.js';
import {
  CAPC_MAGIC,
  OP_TRANSFER,
  OP_FORGE,
  FORGE_FEE_SATS,
  encodeOpTransfer,
  encodeOpForge,
  computeRecipeHash,
  buildTransferCardTx,
  buildForgeCapTx,
} from './src/capc.js';

console.log('=== TEST 1: Binary Wire Encoding ===');
const transferPayload = encodeOpTransfer(1, 101);
assert.strictEqual(transferPayload.length, 14, 'OP_TRANSFER must be 14 bytes');
assert.strictEqual(Buffer.from(transferPayload.slice(0, 4)).toString('ascii'), 'CAPC');
assert.strictEqual(transferPayload[4], OP_TRANSFER);
const view = new DataView(transferPayload.buffer);
assert.strictEqual(view.getUint32(5, true), 1);
assert.strictEqual(view.getUint32(9, true), 101);
assert.strictEqual(transferPayload[13], 0);
console.log('[PASS] encodeOpTransfer verified.');

const dummyRecipeHash = new Uint8Array(32).fill(0xaa);
const forgePayload = encodeOpForge(0, 12345, dummyRecipeHash);
assert.strictEqual(forgePayload.length, 43, 'OP_FORGE must be 43 bytes');
assert.strictEqual(Buffer.from(forgePayload.slice(0, 4)).toString('ascii'), 'CAPC');
assert.strictEqual(forgePayload[4], OP_FORGE);
console.log('[PASS] encodeOpForge verified.');

console.log('\n=== TEST 2: Canonical Recipe Hashing ===');
const recipe = {
  version: 1,
  title: 'Mojave Outpost VIP',
  tier: 4,
  traits: {
    base_metal: 'gilded_gold',
    flutes: 'classic_21',
    emblem: 'vault_door',
    wear: 'mint',
    glow: 'glow_gold'
  }
};
const { hashBytes, hashHex } = computeRecipeHash(recipe);
assert.strictEqual(hashBytes.length, 32, 'Recipe hash must be 32 bytes');
assert.strictEqual(hashHex.length, 64, 'Recipe hash hex must be 64 characters');
console.log('[PASS] computeRecipeHash deterministic hex:', hashHex);

console.log('\n=== TEST 3: Card Transfer Transaction Building ===');
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = openWallet(mnemonic, NETWORKS.regtest);
const aliceAddr = wallet.receive[0].address;
const bobAddr = 'btlcaprt1qrwlw0anjjluypf6ul399wjyrux3d77af0e40ev';

const cardUtxo = {
  txid: '1111111111111111111111111111111111111111111111111111111111111111',
  vout: 0,
  amount: 0.00001000, // 1000 sats card seal
  address: aliceAddr
};

const fundingUtxo = {
  txid: '2222222222222222222222222222222222222222222222222222222222222222',
  vout: 1,
  amount: 1.00000000, // 1 BCAP funding for fees
  address: aliceAddr
};

const card = {
  card_id: 1,
  serial: 101,
  tier: 3,
  utxo: `${cardUtxo.txid}:${cardUtxo.vout}`,
  recipe_hash: hashHex
};

const transferTx = buildTransferCardTx({
  wallet,
  card,
  utxos: [cardUtxo, fundingUtxo],
  toAddress: bobAddr,
  changeAddress: aliceAddr,
  feeRateSatPerVB: 5
});

assert.ok(transferTx.hex.length > 200, 'Signed transfer tx hex must be non-empty');
assert.strictEqual(transferTx.cardId, 1);
assert.strictEqual(transferTx.serial, 101);
console.log('[PASS] buildTransferCardTx generated signed hex (bytes:', transferTx.hex.length / 2, ')');

console.log('\n=== TEST 4: 500 BCAP Forge Burn Transaction Building ===');
const bigFundingUtxo = {
  txid: '3333333333333333333333333333333333333333333333333333333333333333',
  vout: 0,
  amount: 550.00000000, // 550 BCAP
  address: aliceAddr
};

const forgeTx = buildForgeCapTx({
  wallet,
  utxos: [bigFundingUtxo],
  creatorAddress: aliceAddr,
  changeAddress: aliceAddr,
  recipe,
  feeRateSatPerVB: 5
});

assert.ok(forgeTx.hex.length > 200, 'Signed forge tx hex must be non-empty');
assert.strictEqual(forgeTx.recipeHash, hashHex);
assert.ok(forgeTx.change > 0n, 'Change output should return surplus funds');
console.log('[PASS] buildForgeCapTx generated signed hex (bytes:', forgeTx.hex.length / 2, ')');

console.log('\n>>> ALL 4 WEB WALLET CAPC TESTS PASSED! <<<');
