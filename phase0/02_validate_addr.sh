set -e
cd /root/caps-wallet/phase0
command -v jq >/dev/null || { apt-get install -y jq >/dev/null 2>&1; }
JS=$(node derive.mjs)
PUB=$(echo "$JS" | jq -r .pubkey)
ADDR=$(echo "$JS" | jq -r .address)
WIF=$(echo "$JS" | jq -r .wif)
CLI="/root/caps-core/src/caps-cli -datadir=/root/.caps-regtest -rpcport=13667 -rpcuser=rt -rpcpassword=rt"
DESC_PUB=$($CLI getdescriptorinfo "wpkh($PUB)" | jq -r .descriptor)
DESC_WIF=$($CLI getdescriptorinfo "wpkh($WIF)" | jq -r .descriptor)
NODE_PUB_ADDR=$($CLI deriveaddresses "$DESC_PUB" | jq -r '.[0]')
NODE_WIF_ADDR=$($CLI deriveaddresses "$DESC_WIF" | jq -r '.[0]')
echo "JS addr      =$ADDR"
echo "NODE(pubkey) =$NODE_PUB_ADDR"
echo "NODE(wif)    =$NODE_WIF_ADDR"
if [ "$NODE_PUB_ADDR" = "$ADDR" ] && [ "$NODE_WIF_ADDR" = "$ADDR" ]; then echo "RESULT: MATCH ✅"; else echo "RESULT: MISMATCH ❌"; fi
