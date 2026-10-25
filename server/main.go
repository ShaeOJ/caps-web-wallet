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
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	rpcURL, rpcUser, rpcPass string
	explorerURL              string
	explorerPublicURL        string
	webDir                   string
	listenAddr               string
	network                  string
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	return config{
		rpcURL:      envOr("CAPS_RPC_URL", "http://127.0.0.1:13667"),
		rpcUser:     envOr("CAPS_RPC_USER", "rt"),
		rpcPass:     envOr("CAPS_RPC_PASS", "rt"),
		explorerURL: strings.TrimRight(envOr("EXPLORER_URL", ""), "/"),
		// The browser cannot reach EXPLORER_URL when it is a loopback address,
		// so links out are built from the public one.
		explorerPublicURL: strings.TrimRight(envOr("EXPLORER_PUBLIC_URL", "https://caps.undergroundroots.ca"), "/"),
		webDir:            envOr("WEB_DIR", ""),
		listenAddr:        envOr("LISTEN_ADDR", "127.0.0.1:8470"),
		network:           envOr("NETWORK", "regtest"),
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

// CAPS addresses: bech32 (caps1/capsrt1/tcaps1) or base58 (C.../legacy). Keep
// the allowed charset tight — this string goes into a scantxoutset descriptor.
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
	raw, err := s.cfg.rpc(r.Context(), "sendrawtransaction", hex)
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
const maxHistoryTxs = 40

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

	// Collect candidate txids across every address the wallet owns, newest
	// first. The explorer returns each address's list newest-first already.
	var order []string
	seen := map[string]bool{}
	for _, a := range addrs {
		var ar struct {
			LastTxs []struct {
				Addresses string `json:"addresses"` // actually the txid
			} `json:"last_txs"`
		}
		if err := s.explorerGet(r.Context(), "/ext/getaddress/"+a, &ar); err != nil {
			continue // an address with no history 404s; that is not fatal
		}
		for _, t := range ar.LastTxs {
			if t.Addresses != "" && !seen[t.Addresses] {
				seen[t.Addresses] = true
				order = append(order, t.Addresses)
			}
		}
	}
	if len(order) > maxHistoryTxs {
		order = order[:maxHistoryTxs]
	}

	out := make([]historyEntry, 0, len(order))
	for _, txid := range order {
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
			continue
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
		out = append(out, e)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"txs":         out,
		"explorerUrl": s.cfg.explorerPublicURL,
	})
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
