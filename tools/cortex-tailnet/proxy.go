package main

import (
	"crypto/subtle"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// TokenHeader carries the per-launch token; a request without it is refused before anything is sent on.
const TokenHeader = "X-Cortex-Tailnet"

// newProxy forwards every request to the one target it was made for, and nowhere else: the path and query
// come from the request, the scheme and the host never do. The Authorization header (the agent's key) passes
// through untouched; this program does not read or keep it. Answers are flushed as they come, so a stream of
// server-sent events reaches the app piece by piece.
func newProxy(target *url.URL, transport http.RoundTripper, token string) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = target.Host
			r.Out.Header.Del(TokenHeader)
			r.Out.Header.Del("X-Forwarded-For")
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "sunucuya ulaşılamıyor", http.StatusBadGateway)
		},
	}
	want := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get(TokenHeader))
		if len(want) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
			http.Error(w, "yetkisiz", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

// checkTarget accepts only http(s)://host[:port][/path] with no name, password, query or fragment.
func checkTarget(raw string) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || len(raw) > 300 {
		return nil, false
	}
	return u, true
}
