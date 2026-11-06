// cortex-tailnet: Cortex's own small tailnet node (design: docs/superpowers/specs/2026-11-06-gomulu-tailscale-eslestirme-design.md).
//
// The desktop app starts it so the person never installs Tailscale: it joins the person's tailnet as its own
// device through tsnet (a userspace network stack; no administrator, no system service, no change to the
// computer's network) and opens one local proxy to one server.
//
//	cortex-tailnet up       join (an auth key on the first line of stdin, empty once joined) and serve the proxy
//	cortex-tailnet logout   leave the tailnet; the app then deletes the state folder
//
// Settings come from the environment, never argv (a key in argv is visible to every process):
//
//	CORTEX_TAILNET_DIR       the node's state folder (its node key lives there; the app keeps it user-only)
//	CORTEX_TAILNET_HOSTNAME  the device's name in the tailnet
//	CORTEX_TAILNET_TARGET    the one server the proxy reaches, e.g. https://host.tailnet.ts.net:8642
//
// stdout carries exactly one JSON line: {"ready":true,"port":N,"token":"…"} or {"error":"<code>","message":"…"}.
// The proxy lives until stdin closes: the app that started it is gone, so it goes too.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

const joinTimeout = 90 * time.Second

func main() {
	if len(os.Args) != 2 {
		fail("kullanim", "kullanım: cortex-tailnet up|logout")
	}
	switch os.Args[1] {
	case "up":
		up()
	case "logout":
		logout()
	default:
		fail("kullanim", "kullanım: cortex-tailnet up|logout")
	}
}

func say(v any) {
	line, _ := json.Marshal(v)
	fmt.Println(string(line))
}

func fail(code, message string) {
	say(map[string]string{"error": code, "message": message})
	os.Exit(1)
}

func server(authKey string) *tsnet.Server {
	dir := os.Getenv("CORTEX_TAILNET_DIR")
	if dir == "" {
		fail("ayar", "CORTEX_TAILNET_DIR verilmedi")
	}
	name := os.Getenv("CORTEX_TAILNET_HOSTNAME")
	if name == "" {
		name = "cortex"
	}
	return &tsnet.Server{
		Dir:       dir,
		Hostname:  name,
		AuthKey:   authKey,
		Ephemeral: false,
		// tsnet is talkative; what it says goes to stderr, which the app keeps in its log. No key is in it.
		Logf:     func(string, ...any) {},
		UserLogf: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) },
	}
}

func up() {
	target, ok := checkTarget(os.Getenv("CORTEX_TAILNET_TARGET"))
	if !ok {
		fail("hedef", "CORTEX_TAILNET_TARGET geçerli bir http(s) adresi değil")
	}
	in := bufio.NewReader(os.Stdin)
	first, err := in.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		fail("girdi", "anahtar okunamadı")
	}
	srv := server(strings.TrimSpace(first))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), joinTimeout)
	defer cancel()
	if _, err := srv.Up(ctx); err != nil {
		if ctx.Err() != nil {
			fail("baglanamadi", "tailnet'e katılınamadı (süre doldu); kod kullanılmış ya da geçersiz olabilir")
		}
		fail("baglanamadi", "tailnet'e katılınamadı: "+err.Error())
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail("dinleme", "yerel port açılamadı")
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		fail("rastgele", "jeton üretilemedi")
	}
	token := hex.EncodeToString(secret)
	go func() {
		_ = (&http.Server{Handler: newProxy(target, srv.HTTPClient().Transport, token), ReadHeaderTimeout: 30 * time.Second}).Serve(listener)
	}()
	say(map[string]any{"ready": true, "port": listener.Addr().(*net.TCPAddr).Port, "token": token})

	_, _ = io.Copy(io.Discard, in) // until the app closes our stdin
}

func logout() {
	srv := server("")
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Start(); err != nil {
		fail("baglanamadi", err.Error())
	}
	lc, err := srv.LocalClient()
	if err != nil {
		fail("baglanamadi", err.Error())
	}
	if err := lc.Logout(ctx); err != nil {
		fail("cikis", "tailnet'ten çıkılamadı: "+err.Error())
	}
	say(map[string]bool{"ok": true})
}
