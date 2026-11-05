// caps-wallet server — a stateless, non-custodial relay for the CAPS web wallet.
//
// It NEVER sees private keys or seeds. It only:
//   - discovers UTXOs for an address (scantxoutset — no address index needed)
//   - reports balance / history (history proxied from the eiquidus explorer)
//   - reports a fee rate
//   - broadcasts a client-signed raw transaction
//   - serves the SPA with strict security headers
//
// Config via env (defaults target the Phase 0 regtest node):
//
//	CAPS_RPC_URL   http://127.0.0.1:13667
//	CAPS_RPC_USER  rt
//	CAPS_RPC_PASS  rt
//	EXPLORER_URL          http://127.0.0.1:3001  (eiquidus; "" disables /history)
//	EXPLORER_PUBLIC_URL   https://caps.undergroundroots.ca (used for browser links)
//	WEB_DIR        ../web/dist                        ("" disables static serving)
//	LISTEN_ADDR    127.0.0.1:8470
//	NETWORK        regtest | main                     (reported to the client)
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	rpcURL, rpcUser, rpcPass string
	sidechainRPCURL          string
	sidechainRPCUser         string
	sidechainRPCPass         string
	explorerURL              string
	explorerPublicURL        string
	webDir                   string
	listenAddr               string
	network                  string
	recipesDir               string
	marketDir                string
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	rDir := envOr("RECIPES_DIR", "")
	if rDir == "" {
		if _, err := os.Stat("/root/caps-wallet"); err == nil {
			rDir = "/root/caps-wallet/recipes"
		} else {
			rDir = "./recipes"
		}
	}
	_ = os.MkdirAll(rDir, 0755)

	mDir := envOr("MARKET_DIR", "")
	if mDir == "" {
		if _, err := os.Stat("/root/caps-wallet"); err == nil {
			mDir = "/root/caps-wallet/market"
		} else {
			mDir = "./market"
		}
	}
	_ = os.MkdirAll(mDir, 0755)

	return config{
		rpcURL:           envOr("CAPS_RPC_URL", "http://127.0.0.1:13667"),
		rpcUser:          envOr("CAPS_RPC_USER", "rt"),
		rpcPass:          envOr("CAPS_RPC_PASS", "rt"),
		sidechainRPCURL:  envOr("SIDECHAIN_RPC_URL", "http://127.0.0.1:14668"),
		sidechainRPCUser: envOr("SIDECHAIN_RPC_USER", "bcaprpc"),
		sidechainRPCPass: envOr("SIDECHAIN_RPC_PASS", "bcappass123"),
		explorerURL:      strings.TrimRight(envOr("EXPLORER_URL", ""), "/"),
		// The browser cannot reach EXPLORER_URL when it is a loopback address,
		// so links out are built from the public one.
		explorerPublicURL: strings.TrimRight(envOr("EXPLORER_PUBLIC_URL", "https://caps.undergroundroots.ca"), "/"),
		webDir:            envOr("WEB_DIR", ""),
		listenAddr:        envOr("LISTEN_ADDR", "127.0.0.1:8470"),
		network:           envOr("NETWORK", "regtest"),
		recipesDir:        rDir,
		marketDir:         mDir,
	}
}

// ---- JSON-RPC client -------------------------------------------------------

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResp struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

var rpcClient = &http.Client{Timeout: 30 * time.Second}

func (c config) rpc(ctx context.Context, method string, params ...any) (json.RawMessage, error) {
	if params == nil {
		params = []any{}
	}
	body, _ := json.Marshal(rpcReq{JSONRPC: "1.0", ID: "caps-wallet", Method: method, Params: params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.rpcURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.rpcUser, c.rpcPass)
	req.Header.Set("Content-Type", "application/json")
	resp, err := rpcClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var r rpcResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("rpc %s: bad response (http %d)", method, resp.StatusCode)
	}
	if r.Error != nil {
		return nil, fmt.Errorf("rpc %s: %s (code %d)", method, r.Error.Message, r.Error.Code)
	}
	return r.Result, nil
}

func (c config) sidechainRPC(ctx context.Context, method string, params ...any) (json.RawMessage, error) {
	if params == nil {
		params = []any{}
	}
	body, _ := json.Marshal(rpcReq{JSONRPC: "1.0", ID: "caps-wallet-aux", Method: method, Params: params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sidechainRPCURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.sidechainRPCUser, c.sidechainRPCPass)
	req.Header.Set("Content-Type", "application/json")
	resp, err := rpcClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var r rpcResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("sidechain rpc %s: bad response (http %d)", method, resp.StatusCode)
	}
	if r.Error != nil {
		return nil, fmt.Errorf("sidechain rpc %s: %s (code %d)", method, r.Error.Message, r.Error.Code)
	}
	return r.Result, nil
}

func (c config) checkUTXOUnspent(ctx context.Context, txid string, vout uint32) (bool, error) {
	raw, err := c.rpc(ctx, "gettxout", txid, vout, true)
	if err != nil {
		return false, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return false, nil
	}
	return true, nil
}

func (c config) verifyListingTx(ctx context.Context, txid string) (bool, error) {
	raw, err := c.rpc(ctx, "getrawtransaction", txid, true)
	if err != nil {
		return false, err
	}
	var tx struct {
		Vout []struct {
			ScriptPubKey struct {
				Hex string `json:"hex"`
				Asm string `json:"asm"`
			} `json:"scriptPubKey"`
		} `json:"vout"`
	}
	if err := json.Unmarshal(raw, &tx); err != nil {
		return false, err
	}
	for _, out := range tx.Vout {
		h := strings.ToLower(out.ScriptPubKey.Hex)
		if strings.Contains(h, "4341504306") {
			return true, nil
		}
	}
	return false, nil
}

// ---- helpers ---------------------------------------------------------------

// scantxoutset is a single global scan on the node, so serialize callers and
// cache briefly to avoid hammering it.
var scanMu sync.Mutex

type cachedScan struct {
	at  time.Time
	raw json.RawMessage
}

var (
	scanCache   = map[string]cachedScan{}
	scanCacheMu sync.Mutex
)

const scanTTL = 10 * time.Second
const maxScanCacheEntries = 512

// BTLCAP addresses: bech32 (btlcap1/btlcaprt1/tbtlcap1) or base58 (B.../legacy).
// Keep the allowed charset tight — this string goes into a scantxoutset descriptor.
var addrRe = regexp.MustCompile(`^[a-zA-Z0-9]{20,110}$`)

func validAddr(a string) bool { return addrRe.MatchString(a) }

// addr(<address>)#cksum  — recover the address a scantxoutset unspent came from.
var descAddrRe = regexp.MustCompile(`addr\(([^)]+)\)`)

func addrFromDesc(desc string) string {
	if m := descAddrRe.FindStringSubmatch(desc); m != nil {
		return m[1]
	}
	return ""
}

const maxScanAddrs = 100

// parseAddrs accepts a single ?address= or a comma-separated ?addresses= list.
func parseAddrs(r *http.Request) ([]string, bool) {
	raw := r.URL.Query().Get("addresses")
	if raw == "" {
		raw = r.URL.Query().Get("address")
	}
	if raw == "" {
		return nil, false
	}
	var out []string
	for _, a := range strings.Split(raw, ",") {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if !validAddr(a) {
			return nil, false
		}
		out = append(out, a)
	}
	if len(out) == 0 || len(out) > maxScanAddrs {
		return nil, false
	}
	return out, true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// ---- handlers --------------------------------------------------------------

type server struct{ cfg config }

type utxo struct {
	TxID    string  `json:"txid"`
	Vout    uint32  `json:"vout"`
	Amount  float64 `json:"amount"` // CAPS
	Height  int64   `json:"height"`
	Script  string  `json:"scriptPubKey"`
	Desc    string  `json:"desc"`
	Address string  `json:"address"` // filled in from Desc
}

type scanResult struct {
	TotalAmount float64 `json:"total_amount"`
	Unspents    []utxo  `json:"unspents"`
}

// scan runs a single scantxoutset over all given addresses (one global scan for
// the whole HD set), serialized and briefly cached.
func (s *server) scan(ctx context.Context, addrs []string) (scanResult, error) {
	key := strings.Join(addrs, ",")

	scanCacheMu.Lock()
	if c, ok := scanCache[key]; ok && time.Since(c.at) < scanTTL {
		scanCacheMu.Unlock()
		return decodeScan(c.raw)
	}
	scanCacheMu.Unlock()

	scanMu.Lock()
	defer scanMu.Unlock()
	scanCacheMu.Lock()
	if c, ok := scanCache[key]; ok && time.Since(c.at) < scanTTL {
		scanCacheMu.Unlock()
		return decodeScan(c.raw)
	}
	scanCacheMu.Unlock()

	descs := make([]any, len(addrs))
	for i, a := range addrs {
		descs[i] = "addr(" + a + ")"
	}
	raw, err := s.cfg.rpc(ctx, "scantxoutset", "start", descs)
	if err != nil {
		return scanResult{}, err
	}
	scanCacheMu.Lock()
	// bound memory: distinct address-sets could otherwise grow the map without
	// limit. Entries are short-lived (scanTTL) so a hard reset at the cap is fine.
	if len(scanCache) >= maxScanCacheEntries {
		scanCache = map[string]cachedScan{}
	}
	scanCache[key] = cachedScan{at: time.Now(), raw: raw}
	scanCacheMu.Unlock()
	return decodeScan(raw)
}

func decodeScan(raw json.RawMessage) (scanResult, error) {
	var sr scanResult
	if err := json.Unmarshal(raw, &sr); err != nil {
		return sr, errors.New("unparseable scan result")
	}
	for i := range sr.Unspents {
		sr.Unspents[i].Address = addrFromDesc(sr.Unspents[i].Desc)
	}
	if sr.Unspents == nil {
		sr.Unspents = []utxo{}
	}
	return sr, nil
}

func (s *server) handleUTXOs(w http.ResponseWriter, r *http.Request) {
	addrs, ok := parseAddrs(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid or missing address(es)")
		return
	}
	sr, err := s.scan(r.Context(), addrs)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"balance": sr.TotalAmount,
		"utxos":   sr.Unspents,
	})
}

func (s *server) handleBalance(w http.ResponseWriter, r *http.Request) {
	addrs, ok := parseAddrs(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid or missing address(es)")
		return
	}
	sr, err := s.scan(r.Context(), addrs)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": sr.TotalAmount})
}

func (s *server) handleFeerate(w http.ResponseWriter, r *http.Request) {
	const fallback = 0.00001000 // CAPS/kvB
	raw, err := s.cfg.rpc(r.Context(), "estimatesmartfee", 6)
	rate := fallback
	if err == nil {
		var est struct {
			FeeRate float64 `json:"feerate"`
		}
		if json.Unmarshal(raw, &est) == nil && est.FeeRate > 0 {
			rate = est.FeeRate
		}
	}
	// sats/vByte = CAPS/kvB * 1e8 / 1000
	satsPerVB := rate * 1e8 / 1000
	if satsPerVB < 1 {
		satsPerVB = 1
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"feerate_caps_per_kvb": rate,
		"sat_per_vbyte":        satsPerVB,
	})
}

func (s *server) handleBroadcast(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Hex string `json:"hex"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	hex := strings.TrimSpace(body.Hex)
	if hex == "" || len(hex)%2 != 0 || !isHex(hex) {
		writeErr(w, http.StatusBadRequest, "invalid raw tx hex")
		return
	}
	// Pass maxfeerate=0 to accept raw burn transactions (e.g. 500 BCAP for custom forge)
	raw, err := s.cfg.rpc(r.Context(), "sendrawtransaction", hex, 0)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var txid string
	_ = json.Unmarshal(raw, &txid)
	// a successful broadcast changes UTXO state; drop cache
	scanCacheMu.Lock()
	scanCache = map[string]cachedScan{}
	scanCacheMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"txid": txid})
}

// explorerGet fetches and decodes a JSON document from the explorer.
func (s *server) explorerGet(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.explorerURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := rpcClient.Do(req)
	if err != nil {
		return errors.New("explorer unreachable")
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("explorer returned %d", resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

// historyEntry is one transaction as the wallet wants to display it: which way
// the value moved for *this* wallet, how much, and enough context to link out.
type historyEntry struct {
	TxID      string  `json:"txid"`
	Direction string  `json:"direction"` // "receive" | "send" | "self"
	Amount    float64 `json:"amount"`    // CAPS, net change across the wallet's addresses
	Fee       float64 `json:"fee"`       // CAPS, only meaningful on sends we fully fund
	Height    int64   `json:"height"`
	Timestamp int64   `json:"timestamp"`
	Coinbase  bool    `json:"coinbase"`
	Peer      string  `json:"peer"` // counterparty address, best effort
}

// maxHistoryTxs caps how many transactions we enrich per request. Each one is a
// separate explorer round-trip, so this bounds both latency and load on the
// explorer — which runs on the same box as the node and the wallet backend.
const maxHistoryTxs = 50

// maxHistoryScan bounds how many candidate txids we enrich (one explorer
// round-trip each) before ranking by recency and trimming to maxHistoryTxs. It
// must be comfortably larger than maxHistoryTxs so that sends — which live on
// change addresses collected after a busy receive address — are not truncated
// before we ever get to rank them.
const maxHistoryScan = 120

// sats parses an explorer amount. They arrive as strings holding a satoshi
// count, sometimes with a trailing ".00000000"; an unparseable one counts as 0
// rather than failing the whole transaction.
func sats(v string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil {
		return 0
	}
	return f
}

// caps converts satoshis to CAPS, rounded to the 8 decimals the chain uses so
// float division cannot leak 0.30000000000000004 into the JSON.
func caps(s float64) float64 {
	return math.Round(s) / 1e8
}

// handleHistory returns decoded, direction-aware history for the caller's
// addresses. The raw explorer feed is not enough on its own: its per-address
// list reports a "type" of vin/vout but no amount, and names the txid field
// "addresses", so the client cannot tell a send from a receive or say how much
// moved. Resolving that here keeps the key-handling client simple and means one
// request instead of N+1 from the browser.
func (s *server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if s.cfg.explorerURL == "" {
		writeErr(w, http.StatusNotImplemented, "explorer not configured")
		return
	}
	addrs, ok := parseAddrs(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid or missing address(es)")
		return
	}
	mine := make(map[string]bool, len(addrs))
	for _, a := range addrs {
		mine[a] = true
	}

	// Collect each address's txids (the explorer returns them newest-first), then
	// merge round-robin: one tx from each address, then the next from each, and so
	// on. A naive "all of address 0, then address 1, …" pass lets a single busy
	// receive address fill the whole budget, truncating away the change addresses
	// where a wallet's *sends* live — which is exactly why sent history went
	// missing. Round-robin guarantees every address is represented before any one
	// address's deeper history is taken.
	lists := make([][]string, 0, len(addrs))
	for _, a := range addrs {
		var ar struct {
			LastTxs []struct {
				Addresses string `json:"addresses"` // actually the txid
			} `json:"last_txs"`
		}
		if err := s.explorerGet(r.Context(), "/ext/getaddress/"+a, &ar); err != nil {
			continue // an address with no history 404s; that is not fatal
		}
		l := make([]string, 0, len(ar.LastTxs))
		for _, t := range ar.LastTxs {
			if t.Addresses != "" {
				l = append(l, t.Addresses)
			}
		}
		if len(l) > 0 {
			lists = append(lists, l)
		}
	}
	var order []string
	seen := map[string]bool{}
	for depth := 0; len(order) < maxHistoryScan; depth++ {
		progressed := false
		for _, l := range lists {
			if depth >= len(l) {
				continue
			}
			progressed = true
			if tx := l[depth]; !seen[tx] {
				seen[tx] = true
				order = append(order, tx)
				if len(order) >= maxHistoryScan {
					break
				}
			}
		}
		if !progressed {
			break
		}
	}

	// Enrich each candidate (one gettx explorer round-trip apiece) concurrently —
	// a busy wallet can have ~100 of these, and doing them serially blew past the
	// request timeout. A small worker pool keeps the explorer from being hammered.
	out := make([]historyEntry, 0, len(order))
	var histMu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, txid := range order {
		wg.Add(1)
		sem <- struct{}{}
		go func(txid string) {
			defer wg.Done()
			defer func() { <-sem }()
			// Two shapes to respect here, both easy to get wrong silently:
			// gettx nests the transaction under a "tx" key, and every amount is a
			// JSON *string*. Decoding a flat struct, or an amount as a number,
			// yields zeroes with no error at all.
			var resp struct {
				Tx struct {
					TxID string `json:"txid"`
					Vin  []struct {
						Addresses string `json:"addresses"`
						Amount    string `json:"amount"`
					} `json:"vin"`
					Vout []struct {
						Addresses string `json:"addresses"`
						Amount    string `json:"amount"`
					} `json:"vout"`
					Timestamp  int64 `json:"timestamp"`
					BlockIndex int64 `json:"blockindex"`
				} `json:"tx"`
			}
			if err := s.explorerGet(r.Context(), "/ext/gettx/"+txid, &resp); err != nil {
				return
			}
			tx := resp.Tx

			// Explorer amounts are satoshis (despite the decimal formatting).
			var inMine, outMine, inTotal, outTotal float64
			coinbase := false
			peerIn, peerOut := "", ""
			for _, v := range tx.Vin {
				amt := sats(v.Amount)
				inTotal += amt
				if v.Addresses == "coinbase" {
					coinbase = true
				}
				if mine[v.Addresses] {
					inMine += amt
				} else if peerIn == "" {
					peerIn = v.Addresses
				}
			}
			for _, v := range tx.Vout {
				amt := sats(v.Amount)
				outTotal += amt
				if mine[v.Addresses] {
					outMine += amt
				} else if peerOut == "" {
					peerOut = v.Addresses
				}
			}

			e := historyEntry{
				TxID: txid, Height: tx.BlockIndex, Timestamp: tx.Timestamp, Coinbase: coinbase,
			}
			net := outMine - inMine // >0 the wallet gained, <0 it spent
			switch {
			case inMine == 0:
				e.Direction, e.Amount, e.Peer = "receive", caps(outMine), peerIn
			case net > 0:
				e.Direction, e.Amount, e.Peer = "receive", caps(net), peerIn
			case net < 0:
				e.Direction, e.Amount, e.Peer = "send", caps(-net), peerOut
				// Fee is only knowable when the wallet funded every input.
				if inMine == inTotal && !coinbase {
					e.Fee = caps(inTotal - outTotal)
					// What the recipient got; the fee is listed separately. Round
					// again so the subtraction cannot reintroduce float noise.
					e.Amount = caps(-net - (inTotal - outTotal))
				}
			default:
				// Everything came back to the wallet: a consolidation or self-send.
				e.Direction, e.Amount = "self", caps(outMine)
				if inMine == inTotal && !coinbase {
					e.Fee = caps(inTotal - outTotal)
				}
			}
			histMu.Lock()
			out = append(out, e)
			histMu.Unlock()
		}(txid)
	}
	wg.Wait()

	// Newest first across every address (round-robin collection mixed directions
	// and addresses together), then return at most maxHistoryTxs.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Height != out[j].Height {
			return out[i].Height > out[j].Height
		}
		return out[i].Timestamp > out[j].Timestamp
	})
	if len(out) > maxHistoryTxs {
		out = out[:maxHistoryTxs]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"txs":         out,
		"explorerUrl": s.cfg.explorerPublicURL,
	})
}

var (
	forgedCardsMu        sync.RWMutex
	forgedCardsCache     = make(map[string]map[string]any)
	lastForgedScanHeight int64 = 5290
)

func (s *server) syncMainnetForgedCards(ctx context.Context) {
	forgedCardsMu.Lock()
	defer forgedCardsMu.Unlock()

	rawTip, err := s.cfg.rpc(ctx, "getblockcount")
	if err != nil {
		return
	}
	var tip int64
	if err := json.Unmarshal(rawTip, &tip); err != nil {
		return
	}

	if lastForgedScanHeight <= tip {
		start := lastForgedScanHeight
		for h := start; h <= tip; h++ {
			rawHash, err := s.cfg.rpc(ctx, "getblockhash", h)
			if err != nil {
				break
			}
			var bhash string
			if err := json.Unmarshal(rawHash, &bhash); err != nil {
				break
			}
			rawBlock, err := s.cfg.rpc(ctx, "getblock", bhash, 2)
			if err != nil {
				break
			}
			var block struct {
				Tx []struct {
					TxID string `json:"txid"`
					Vout []struct {
						Value        float64 `json:"value"`
						ScriptPubKey struct {
							Hex     string `json:"hex"`
							Address string `json:"address"`
						} `json:"scriptPubKey"`
					} `json:"vout"`
				} `json:"tx"`
			}
			if err := json.Unmarshal(rawBlock, &block); err != nil {
				break
			}

			for _, tx := range block.Tx {
				if len(tx.Vout) < 2 {
					continue
				}
				spk0 := tx.Vout[0].ScriptPubKey.Hex
				idx := strings.Index(spk0, "4341504304")
				if idx == -1 {
					continue
				}
				payloadHex := spk0[idx:]
				if len(payloadHex) < 86 {
					continue
				}
				recipeHash := strings.ToLower(payloadHex[22:86])
				owner := tx.Vout[1].ScriptPubKey.Address
				utxo := fmt.Sprintf("%s:1", tx.TxID)

				cid := 9000 + len(forgedCardsCache) + 1
				if old, exists := forgedCardsCache[utxo]; exists {
					if oldID, ok := old["card_id"].(int); ok && oldID > 0 {
						cid = oldID
					}
				}

				serial := h*100 + int64(len(forgedCardsCache)+1)
				card := map[string]any{
					"card_id":       cid,
					"serial":        serial,
					"tier":          4,
					"recipe_hash":   recipeHash,
					"owner":         owner,
					"mainnet_owner": owner,
					"utxo":          utxo,
					"status":        "ACTIVE",
					"mint_block":    h,
					"mint_txid":     tx.TxID,
					"traits": map[string]any{
						"base_metal": "gilded_gold",
						"flutes":     "classic_21",
						"emblem":     "custom",
						"wear":       "mint",
						"glow":       "glow_gold",
					},
					"transfers": []any{},
				}
				forgedCardsCache[utxo] = card
			}
			lastForgedScanHeight = h + 1
		}
	}

	// Mempool scan for unconfirmed forged cards so users see them immediately
	rawMempool, err := s.cfg.rpc(ctx, "getrawmempool")
	if err == nil {
		var mempoolTxIDs []string
		if err := json.Unmarshal(rawMempool, &mempoolTxIDs); err == nil {
			mempoolSet := make(map[string]bool)
			for _, txid := range mempoolTxIDs {
				mempoolSet[txid] = true
				utxo := fmt.Sprintf("%s:1", txid)
				if _, exists := forgedCardsCache[utxo]; exists {
					continue
				}
				rawTx, err := s.cfg.rpc(ctx, "getrawtransaction", txid, 1)
				if err != nil {
					continue
				}
				var tx struct {
					TxID string `json:"txid"`
					Vout []struct {
						Value        float64 `json:"value"`
						ScriptPubKey struct {
							Hex     string `json:"hex"`
							Address string `json:"address"`
						} `json:"scriptPubKey"`
					} `json:"vout"`
				}
				if err := json.Unmarshal(rawTx, &tx); err != nil {
					continue
				}
				if len(tx.Vout) < 2 {
					continue
				}
				spk0 := tx.Vout[0].ScriptPubKey.Hex
				idx := strings.Index(spk0, "4341504304")
				if idx == -1 {
					continue
				}
				payloadHex := spk0[idx:]
				if len(payloadHex) < 86 {
					continue
				}
				recipeHash := strings.ToLower(payloadHex[22:86])
				owner := tx.Vout[1].ScriptPubKey.Address

				card := map[string]any{
					"card_id":       9000 + len(forgedCardsCache) + 1,
					"serial":        (tip+1)*100 + int64(len(forgedCardsCache)+1),
					"tier":          4,
					"recipe_hash":   recipeHash,
					"owner":         owner,
					"mainnet_owner": owner,
					"utxo":          utxo,
					"status":        "ACTIVE",
					"mint_block":    tip + 1,
					"mint_txid":     tx.TxID,
					"pending":       true,
					"traits": map[string]any{
						"base_metal": "gilded_gold",
						"flutes":     "classic_21",
						"emblem":     "custom",
						"wear":       "mint",
						"glow":       "glow_gold",
					},
					"transfers": []any{},
				}
				forgedCardsCache[utxo] = card
			}

			// Clean up any pending cards that are no longer in the mempool
			for utxo, card := range forgedCardsCache {
				if p, ok := card["pending"].(bool); ok && p {
					txid, _ := card["mint_txid"].(string)
					if !mempoolSet[txid] {
						delete(forgedCardsCache, utxo)
					}
				}
			}
		}
	}
}

func (s *server) handleCards(w http.ResponseWriter, r *http.Request) {
	addrsParam := r.URL.Query().Get("addresses")
	var addrs []string
	if addrsParam != "" {
		for _, a := range strings.Split(addrsParam, ",") {
			a = strings.TrimSpace(a)
			if validAddr(a) {
				addrs = append(addrs, a)
			}
		}
	}

	// 1. Sync mainnet forged cards
	s.syncMainnetForgedCards(r.Context())

	// 2. Fetch sidechain AuxPoW mined drops
	var cards []map[string]any
	res, err := s.cfg.sidechainRPC(r.Context(), "getcards", addrs)
	if err == nil {
		var data struct {
			Cards []map[string]any `json:"cards"`
		}
		if err := json.Unmarshal(res, &data); err == nil {
			cards = data.Cards
		}
	}

	// 3. Append matching mainnet forged cards
	filterMap := make(map[string]bool)
	for _, a := range addrs {
		filterMap[strings.ToLower(a)] = true
	}

	forgedCardsMu.RLock()
	for _, fc := range forgedCardsCache {
		owner, _ := fc["owner"].(string)
		mOwner, _ := fc["mainnet_owner"].(string)
		if len(addrs) > 0 {
			if !filterMap[strings.ToLower(owner)] && !filterMap[strings.ToLower(mOwner)] {
				continue
			}
		}
		// Avoid duplicate by UTXO
		found := false
		for _, c := range cards {
			if c["utxo"] == fc["utxo"] {
				found = true
				break
			}
		}
		if !found {
			cloned := make(map[string]any)
			for k, v := range fc {
				cloned[k] = v
			}
			cards = append(cards, cloned)
		}
	}
	forgedCardsMu.RUnlock()

	// 4. Enrich all cards with custom recipe artwork if available on disk
	for _, card := range cards {
		rHash, ok := card["recipe_hash"].(string)
		if !ok || len(rHash) != 64 {
			continue
		}
		path := filepath.Join(s.cfg.recipesDir, strings.ToLower(rHash)+".json")
		if b, err := os.ReadFile(path); err == nil {
			var rec struct {
				Title  string         `json:"title"`
				Tier   int            `json:"tier"`
				Traits map[string]any `json:"traits"`
			}
			if err := json.Unmarshal(b, &rec); err == nil {
				if rec.Title != "" {
					card["title"] = rec.Title
				}
				if rec.Tier > 0 {
					card["tier"] = rec.Tier
				}
				if rec.Traits != nil {
					cTraits, _ := card["traits"].(map[string]any)
					if cTraits == nil {
						cTraits = map[string]any{}
					}
					for k, v := range rec.Traits {
						cTraits[k] = v
					}
					card["traits"] = cTraits
				}
			}
		}
	}

	// 5. Sort newest first by serial
	sort.Slice(cards, func(i, j int) bool {
		var si, sj int64
		switch v := cards[i]["serial"].(type) {
		case int64:
			si = v
		case int:
			si = int64(v)
		case float64:
			si = int64(v)
		}
		switch v := cards[j]["serial"].(type) {
		case int64:
			sj = v
		case int:
			sj = int64(v)
		case float64:
			sj = int64(v)
		}
		return si > sj
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"cards":     cards,
		"total":     len(cards),
		"forge_fee": 50.0,
		"online":    true,
	})
}

func (s *server) handleSaveRecipe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RecipeHash string         `json:"recipe_hash"`
		Recipe     map[string]any `json:"recipe"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 5<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	hash := strings.ToLower(strings.TrimSpace(body.RecipeHash))
	if len(hash) != 64 || !isHex(hash) {
		writeErr(w, http.StatusBadRequest, "invalid recipe_hash (must be 64-char hex)")
		return
	}
	if body.Recipe == nil {
		writeErr(w, http.StatusBadRequest, "missing recipe payload")
		return
	}

	_ = os.MkdirAll(s.cfg.recipesDir, 0755)
	filePath := filepath.Join(s.cfg.recipesDir, hash+".json")
	data, err := json.Marshal(body.Recipe)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed to serialize recipe")
		return
	}
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to persist recipe")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "recipe_hash": hash})
}

func (s *server) handleGetRecipe(w http.ResponseWriter, r *http.Request) {
	hash := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("hash")))
	if len(hash) != 64 || !isHex(hash) {
		writeErr(w, http.StatusBadRequest, "invalid recipe_hash")
		return
	}
	filePath := filepath.Join(s.cfg.recipesDir, hash+".json")
	data, err := os.ReadFile(filePath)
	if err != nil {
		writeErr(w, http.StatusNotFound, "recipe not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

var marketMu sync.RWMutex

type MarketOrder struct {
	OrderID       string         `json:"order_id"`
	CardID        int64          `json:"card_id"`
	Serial        int64          `json:"serial"`
	Tier          int            `json:"tier"`
	Title         string         `json:"title"`
	RecipeHash    string         `json:"recipe_hash,omitempty"`
	Traits        map[string]any `json:"traits,omitempty"`
	PriceCaps     float64        `json:"price_caps"`
	PriceSats     int64          `json:"price_sats"`
	SellerAddress string         `json:"seller_address"`
	CardUTXO      string         `json:"card_utxo"` // txid:vout
	ListingTxID   string         `json:"listing_txid"`
	OrderSlipPSBT string         `json:"order_slip_psbt"`
	CreatedAt     int64          `json:"created_at"`
	Status        string         `json:"status"` // "active", "sold", "cancelled"
}

func (s *server) handleGetMarketOrders(w http.ResponseWriter, r *http.Request) {
	marketMu.RLock()
	files, err := os.ReadDir(s.cfg.marketDir)
	marketMu.RUnlock()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"orders": []any{}, "total": 0})
		return
	}

	activeOrders := []MarketOrder{}
	var dirtyListings []string

	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		path := filepath.Join(s.cfg.marketDir, f.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var ord MarketOrder
		if err := json.Unmarshal(data, &ord); err != nil {
			continue
		}

		if ord.Status != "active" {
			continue
		}

		// Verify card UTXO is still unspent
		parts := strings.Split(ord.CardUTXO, ":")
		if len(parts) == 2 {
			vout, err := strconv.ParseUint(parts[1], 10, 32)
			if err == nil {
				unspent, err := s.cfg.checkUTXOUnspent(r.Context(), parts[0], uint32(vout))
				if err == nil && !unspent {
					ord.Status = "sold"
					dirtyListings = append(dirtyListings, ord.OrderID)
					continue
				}
			}
		}

		// Enrich with recipe metadata if custom card
		if ord.RecipeHash != "" && len(ord.RecipeHash) == 64 {
			recPath := filepath.Join(s.cfg.recipesDir, strings.ToLower(ord.RecipeHash)+".json")
			if rb, err := os.ReadFile(recPath); err == nil {
				var rec struct {
					Title  string         `json:"title"`
					Tier   int            `json:"tier"`
					Traits map[string]any `json:"traits"`
				}
				if err := json.Unmarshal(rb, &rec); err == nil {
					if rec.Title != "" {
						ord.Title = rec.Title
					}
					if rec.Tier > 0 {
						ord.Tier = rec.Tier
					}
					if rec.Traits != nil {
						if ord.Traits == nil {
							ord.Traits = make(map[string]any)
						}
						for k, v := range rec.Traits {
							ord.Traits[k] = v
						}
					}
				}
			}
		}

		activeOrders = append(activeOrders, ord)
	}

	if len(dirtyListings) > 0 {
		go func(orders []string) {
			marketMu.Lock()
			defer marketMu.Unlock()
			for _, id := range orders {
				p := filepath.Join(s.cfg.marketDir, id+".json")
				_ = os.Remove(p)
			}
		}(dirtyListings)
	}

	sort.Slice(activeOrders, func(i, j int) bool {
		return activeOrders[i].CreatedAt > activeOrders[j].CreatedAt
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"orders": activeOrders,
		"total":  len(activeOrders),
	})
}

func (s *server) handlePostMarketOrder(w http.ResponseWriter, r *http.Request) {
	var body MarketOrder
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	body.SellerAddress = strings.TrimSpace(body.SellerAddress)
	if !validAddr(body.SellerAddress) {
		writeErr(w, http.StatusBadRequest, "invalid seller_address")
		return
	}

	body.CardUTXO = strings.TrimSpace(body.CardUTXO)
	parts := strings.Split(body.CardUTXO, ":")
	if len(parts) != 2 || len(parts[0]) != 64 || !isHex(parts[0]) {
		writeErr(w, http.StatusBadRequest, "invalid card_utxo (must be txid:vout)")
		return
	}
	vout, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid card_utxo vout")
		return
	}

	if body.PriceCaps <= 0 {
		writeErr(w, http.StatusBadRequest, "price_caps must be greater than 0")
		return
	}
	body.PriceSats = int64(math.Round(body.PriceCaps * 1e8))

	if strings.TrimSpace(body.OrderSlipPSBT) == "" {
		writeErr(w, http.StatusBadRequest, "missing order_slip_psbt")
		return
	}

	unspent, err := s.cfg.checkUTXOUnspent(r.Context(), parts[0], uint32(vout))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "failed to verify card utxo: "+err.Error())
		return
	}
	if !unspent {
		writeErr(w, http.StatusBadRequest, "card utxo is already spent")
		return
	}

	body.ListingTxID = strings.TrimSpace(body.ListingTxID)
	if body.ListingTxID != "" {
		if len(body.ListingTxID) != 64 || !isHex(body.ListingTxID) {
			writeErr(w, http.StatusBadRequest, "invalid listing_txid")
			return
		}
		hasOpList, err := s.cfg.verifyListingTx(r.Context(), body.ListingTxID)
		if err != nil {
			log.Printf("listing tx verification notice: %v", err)
		} else if !hasOpList {
			writeErr(w, http.StatusBadRequest, "listing_txid does not contain valid OP_LIST")
			return
		}
	}

	body.OrderID = fmt.Sprintf("ord_%s_%d", parts[0][:16], vout)
	body.CreatedAt = time.Now().Unix()
	body.Status = "active"

	marketMu.Lock()
	defer marketMu.Unlock()

	_ = os.MkdirAll(s.cfg.marketDir, 0755)
	filePath := filepath.Join(s.cfg.marketDir, body.OrderID+".json")
	data, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to serialize order")
		return
	}
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to persist order")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"order": body,
	})
}

func (s *server) handleDeleteMarketOrder(w http.ResponseWriter, r *http.Request) {
	orderID := strings.TrimSpace(r.URL.Query().Get("order_id"))
	if orderID == "" {
		var body struct {
			OrderID string `json:"order_id"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body)
		orderID = strings.TrimSpace(body.OrderID)
	}
	if orderID == "" {
		writeErr(w, http.StatusBadRequest, "missing order_id")
		return
	}

	if strings.Contains(orderID, "/") || strings.Contains(orderID, "\\") || strings.Contains(orderID, "..") {
		writeErr(w, http.StatusBadRequest, "invalid order_id")
		return
	}

	marketMu.Lock()
	defer marketMu.Unlock()

	filePath := filepath.Join(s.cfg.marketDir, orderID+".json")
	if err := os.Remove(filePath); err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "order not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "failed to delete order")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *server) handleSidechainInfo(w http.ResponseWriter, r *http.Request) {
	res, err := s.cfg.sidechainRPC(r.Context(), "getsidechaininfo")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"online": false,
			"error":  err.Error(),
		})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(res)
}

func (s *server) handleNetwork(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"network": s.cfg.network})
}

func isHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// ---- security headers + static ---------------------------------------------

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Always revalidate: a wallet must never run stale (possibly pre-audit)
		// code. Files carry Last-Modified/ETag, so unchanged assets return 304.
		h.Set("Cache-Control", "no-cache")
		h.Set("Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self'; "+
				"img-src 'self' data:; connect-src 'self'; font-src 'self'; "+
				"base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		// HSTS is set by the TLS-terminating nginx in production; harmless over http.
		next.ServeHTTP(w, r)
	})
}

func main() {
	cfg := loadConfig()
	s := &server{cfg: cfg}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/utxos", s.handleUTXOs)
	mux.HandleFunc("GET /api/balance", s.handleBalance)
	mux.HandleFunc("GET /api/history", s.handleHistory)
	mux.HandleFunc("GET /api/feerate", s.handleFeerate)
	mux.HandleFunc("POST /api/broadcast", s.handleBroadcast)
	mux.HandleFunc("GET /api/network", s.handleNetwork)
	mux.HandleFunc("GET /api/cards", s.handleCards)
	mux.HandleFunc("POST /api/cards/recipe", s.handleSaveRecipe)
	mux.HandleFunc("GET /api/cards/recipe", s.handleGetRecipe)
	mux.HandleFunc("GET /api/market/orders", s.handleGetMarketOrders)
	mux.HandleFunc("POST /api/market/orders", s.handlePostMarketOrder)
	mux.HandleFunc("DELETE /api/market/orders", s.handleDeleteMarketOrder)
	mux.HandleFunc("GET /api/sidechain/info", s.handleSidechainInfo)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if _, err := cfg.rpc(r.Context(), "getblockcount"); err != nil {
			writeErr(w, http.StatusBadGateway, "node unreachable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	if cfg.webDir != "" {
		mux.Handle("GET /", http.FileServer(http.Dir(cfg.webDir)))
	}

	handler := securityHeaders(mux)
	srv := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      40 * time.Second, // scantxoutset can be slow
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16,
	}
	log.Printf("caps-wallet server: listening on %s (network=%s, rpc=%s, explorer=%q, web=%q)",
		cfg.listenAddr, cfg.network, cfg.rpcURL, cfg.explorerURL, cfg.webDir)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
