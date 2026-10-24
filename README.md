# CAPS Web Wallet

A **non-custodial** browser wallet for [CAPS](https://caps.undergroundroots.ca) — a SHA256d
Bitcoin fork (bech32 `caps1…`, legacy `C…`, P2P 12566 / RPC 12567).

> Mine it. Own it. Trade it. — self-custody for the wasteland.

## Security model

Private keys and the BIP39 seed are generated, stored, and used **only in the browser**.
The server never sees them. The server is a stateless data/broadcast relay that talks to a
local `capsd` JSON-RPC and proxies the explorer.

- BIP39 mnemonic → BIP32 HD (BIP84, P2WPKH) with CAPS network params
- Audited minimal libs: `@scure/bip39`, `@scure/bip32`, `@noble/secp256k1`, `@scure/btc-signer`
- Seed encrypted at rest (scrypt N=2^15 → AES-GCM, Web Crypto) in IndexedDB; mnemonic shown once
- Tx build + sign 100% client-side; server only broadcasts the raw hex
- Strict CSP (`script-src 'self'`, no inline/eval), self-hosted JS, HSTS/TLS

## Verify what you're running

The served bundle is reproducible from this repo. Don't trust it — check it:

```sh
git clone https://github.com/ShaeOJ/caps-web-wallet && cd caps-web-wallet/web
npm ci && npm run build          # npm ci enforces package-lock.json exactly
sha256sum dist/app.js
curl -s https://wallet.undergroundroots.ca/app.js | sha256sum   # must match
```

Dependencies are pinned with integrity hashes in `package-lock.json`; always
build with `npm ci` (never `npm install`) so a rebuild can't silently pull a
different version of a crypto library.

## Layout

- `phase0/` — regtest validation harness (de-risk). Proves JS-derived addresses match the
  node and that a client-signed tx is accepted. **Passing as of 2026-10-24.**
- `server/` — stateless Go relay (`/api/utxos`, `/balance`, `/history`, `/feerate`,
  `/broadcast`, `/network`) + static SPA host with CSP.
- `web/` — self-hosted SPA (no CDN).

## Network params (`src/kernel/chainparams.cpp`)

| param        | mainnet      | regtest      |
|--------------|--------------|--------------|
| bech32 HRP   | `caps`       | `capsrt`     |
| P2PKH ver    | `0x1c` (`C`) | `0x6f` (111) |
| P2SH ver     | `0x1d`       | `0xc4` (196) |
| WIF byte     | `0x9c`       | `0xef` (239) |
| BIP32 xprv/xpub | `0x0488ade4` / `0x0488b21e` | testnet `0x04358394` / `0x043587cf` |
| P2P / RPC    | 12566 / 12567 | (regtest 13766 / 13667 in harness) |

Derivation path: `m/84'/0'/0'/0/i` (node is path-agnostic; this is the wallet's internal convention).
