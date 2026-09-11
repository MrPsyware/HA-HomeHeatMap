package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var assets embed.FS

type application struct {
	mu      sync.RWMutex
	layout  Layout
	dir     string
	ha      *HA
	ingress bool
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	addr := flag.String("listen", env("LISTEN_ADDR", "127.0.0.1:8099"), "HTTP listen address")
	dir := flag.String("data", env("DATA_DIR", "data"), "persistent data directory")
	flag.Parse()
	base, token := os.Getenv("HA_URL"), os.Getenv("HA_TOKEN")
	ingress := os.Getenv("SUPERVISOR_TOKEN") != ""
	if ingress {
		base, token = "http://supervisor/core", os.Getenv("SUPERVISOR_TOKEN")
	}
	ha, err := NewHA(base, token)
	if err != nil {
		log.Fatal(err)
	}
	if err := ha.TrustCA(os.Getenv("HA_CA_FILE")); err != nil {
		log.Fatal(err)
	}
	a, err := newApplication(*dir, ha, ingress)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: *addr, Handler: a.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("Home Heat Map listening on %s (HA configured: %t)", *addr, ha.configured())
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func newApplication(dir string, ha *HA, ingress bool) (*application, error) {
	if err := os.MkdirAll(filepath.Join(dir, "images"), 0700); err != nil {
		return nil, err
	}
	a := &application{dir: dir, ha: ha, ingress: ingress, layout: Layout{Version: 1, Floors: []Floor{}, Ignored: []string{}}}
	data, err := os.ReadFile(filepath.Join(dir, "layout.json"))
	if err == nil {
		if err = json.Unmarshal(data, &a.layout); err != nil {
			return nil, fmt.Errorf("read layout: %w", err)
		}
		if err = a.layout.Validate(); err != nil {
			return nil, fmt.Errorf("invalid saved layout: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return a, nil
}

func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func problem(w http.ResponseWriter, status int, err error) {
	respond(w, status, map[string]string{"error": err.Error()})
}

func (a *application) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"configured": a.ha.configured(), "ingress": a.ingress})
	})
	mux.HandleFunc("GET /api/layout", func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		defer a.mu.RUnlock()
		respond(w, 200, a.layout)
	})
	mux.HandleFunc("PUT /api/layout", a.saveLayout)
	mux.HandleFunc("POST /api/images", a.upload)
	mux.HandleFunc("GET /api/catalog", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ha.Catalog(r.Context())
		if err != nil {
			problem(w, 502, err)
			return
		}
		respond(w, 200, v)
	})
	mux.HandleFunc("GET /api/live", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ha.Sensors(r.Context())
		if err != nil {
			problem(w, 502, err)
			return
		}
		respond(w, 200, v)
	})
	mux.HandleFunc("GET /api/history", a.history)
	mux.Handle("GET /images/", http.StripPrefix("/images/", http.FileServer(http.Dir(filepath.Join(a.dir, "images")))))
	static, _ := fs.Sub(assets, "web")
	mux.Handle("GET /", http.FileServer(http.FS(static)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.ingress {
			host, _, _ := net.SplitHostPort(r.RemoteAddr)
			if host != "172.30.32.2" {
				http.Error(w, "Ingress access only", 403)
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				expected := r.Host
				if a.ingress && r.Header.Get("X-Forwarded-Host") != "" {
					expected = r.Header.Get("X-Forwarded-Host")
				}
				if err != nil || u.Host != expected {
					problem(w, 403, errors.New("cross-origin write rejected"))
					return
				}
			}
			if r.Header.Get("X-Heatmap-Request") != "1" {
				problem(w, 403, errors.New("missing request header"))
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *application) saveLayout(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	var next Layout
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&next); err != nil {
		problem(w, 400, err)
		return
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		problem(w, 400, errors.New("expected one JSON object"))
		return
	}
	if err := next.Validate(); err != nil {
		problem(w, 400, err)
		return
	}
	for _, f := range next.Floors {
		if _, err := os.Stat(filepath.Join(a.dir, filepath.FromSlash(f.Image))); err != nil {
			problem(w, 400, errors.New("floor image is missing"))
			return
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if next.Revision != a.layout.Revision {
		problem(w, 409, errors.New("layout changed in another tab; reload before saving"))
		return
	}
	next.Revision++
	data, err := json.MarshalIndent(next, "", "  ")
	if err == nil {
		err = atomicWrite(filepath.Join(a.dir, "layout.json"), data)
	}
	if err != nil {
		problem(w, 500, err)
		return
	}
	a.layout = next
	respond(w, 200, next)
}

func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".layout-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
