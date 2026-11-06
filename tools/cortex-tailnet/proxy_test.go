package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func backend(t *testing.T, h http.HandlerFunc) *url.URL {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL + "/p/pyn")
	return u
}

func TestTokenRequired(t *testing.T) {
	called := false
	target := backend(t, func(w http.ResponseWriter, r *http.Request) { called = true })
	front := httptest.NewServer(newProxy(target, http.DefaultTransport, "gizli"))
	defer front.Close()
	for _, token := range []string{"", "yanlis", "gizl"} {
		req, _ := http.NewRequest("GET", front.URL+"/api/sessions", nil)
		if token != "" {
			req.Header.Set(TokenHeader, token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("jeton %q: durum %d, 403 bekleniyordu", token, res.StatusCode)
		}
	}
	if called {
		t.Fatal("jetonsuz istek hedefe ulaştı")
	}
}

func TestEmptyTokenNeverMatches(t *testing.T) {
	target := backend(t, func(w http.ResponseWriter, r *http.Request) {})
	front := httptest.NewServer(newProxy(target, http.DefaultTransport, ""))
	defer front.Close()
	req, _ := http.NewRequest("GET", front.URL+"/x", nil)
	req.Header.Set(TokenHeader, "")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("boş jeton kabul edildi: %d", res.StatusCode)
	}
}

func TestForwardsToTheOneTarget(t *testing.T) {
	var seen *http.Request
	target := backend(t, func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(r.Context())
		fmt.Fprint(w, "tamam")
	})
	front := httptest.NewServer(newProxy(target, http.DefaultTransport, "gizli"))
	defer front.Close()
	req, _ := http.NewRequest("GET", front.URL+"/api/sessions?limit=20", nil)
	req.Header.Set(TokenHeader, "gizli")
	req.Header.Set("Authorization", "Bearer hermes-anahtari")
	req.Host = "baska-bir-yer.example"
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "tamam" || seen == nil {
		t.Fatalf("cevap %q", body)
	}
	if seen.URL.Path != "/p/pyn/api/sessions" || seen.URL.RawQuery != "limit=20" {
		t.Fatalf("yol %q sorgu %q", seen.URL.Path, seen.URL.RawQuery)
	}
	if seen.Host != target.Host {
		t.Fatalf("Host %q, hedef %q olmalı", seen.Host, target.Host)
	}
	if seen.Header.Get(TokenHeader) != "" {
		t.Fatal("yerel jeton hedefe gitti")
	}
	if seen.Header.Get("Authorization") != "Bearer hermes-anahtari" {
		t.Fatal("Authorization geçmedi")
	}
}

func TestStreamsPieceByPiece(t *testing.T) {
	// text/event-stream is flushed by the standard library anyway; the other type checks the proxy's own FlushInterval.
	for _, kind := range []string{"text/event-stream", "application/x-ndjson"} {
		t.Run(kind, func(t *testing.T) { streamsPieceByPiece(t, kind) })
	}
}

func streamsPieceByPiece(t *testing.T, kind string) {
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	target := backend(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", kind)
		fmt.Fprint(w, "event: assistant.delta\ndata: {\"delta\":\"bir\"}\n\n")
		w.(http.Flusher).Flush()
		<-release
		fmt.Fprint(w, "event: assistant.completed\ndata: {}\n\n")
	})
	front := httptest.NewServer(newProxy(target, http.DefaultTransport, "gizli"))
	defer front.Close()
	req, _ := http.NewRequest("POST", front.URL+"/api/sessions/x/chat/stream", strings.NewReader(`{"input":"selam"}`))
	req.Header.Set(TokenHeader, "gizli")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	lines := make(chan string, 8)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	select {
	case line := <-lines:
		if line != "event: assistant.delta" {
			t.Fatalf("ilk satır %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ilk olay akış bitmeden gelmedi (vekil tamponluyor)")
	}
}

func TestUnreachableTargetIsOneSentence(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:1")
	front := httptest.NewServer(newProxy(target, http.DefaultTransport, "gizli"))
	defer front.Close()
	req, _ := http.NewRequest("GET", front.URL+"/v1/health", nil)
	req.Header.Set(TokenHeader, "gizli")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusBadGateway || strings.TrimSpace(string(body)) != "sunucuya ulaşılamıyor" {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
}

func TestCheckTarget(t *testing.T) {
	good := []string{"https://host.tailnet.ts.net:8642", "http://100.64.0.1:8642/p/pyn"}
	bad := []string{"", "ftp://x", "https://kullanici:parola@host", "https://host?x=1", "https://host#a", "host:8642",
		"https://" + strings.Repeat("a", 300)}
	for _, s := range good {
		if _, ok := checkTarget(s); !ok {
			t.Errorf("reddedildi: %q", s)
		}
	}
	for _, s := range bad {
		if _, ok := checkTarget(s); ok {
			t.Errorf("kabul edildi: %q", s)
		}
	}
}
