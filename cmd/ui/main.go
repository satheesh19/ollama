package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

//go:embed dist/*
var embedFS embed.FS

func main() {
	// 1. Get Ollama Daemon target host. Default to localhost:11434.
	ollamaHost := os.Getenv("OLLAMA_HOST")
	if ollamaHost == "" {
		ollamaHost = "http://localhost:11434"
	}
	
	// Normalize ollamaHost
	if !strings.HasPrefix(ollamaHost, "http://") && !strings.HasPrefix(ollamaHost, "https://") {
		ollamaHost = "http://" + ollamaHost
	}

	targetURL, err := url.Parse(ollamaHost)
	if err != nil {
		log.Fatalf("Invalid OLLAMA_HOST: %v", err)
	}

	// 2. Setup Reverse Proxy for Ollama to eliminate CORS issues entirely
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Adjust proxy director to set proper headers for Ollama
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Header.Set("X-Forwarded-Host", req.Header.Get("Host"))
		req.Header.Set("Host", targetURL.Host)
		req.Origin = targetURL.String()
	}

	// 3. Extract the embedded Angular build assets
	distFS, err := fs.Sub(embedFS, "dist")
	if err != nil {
		log.Fatalf("Failed to extract embedded assets: %v", err)
	}
	fileServer := http.FileServer(http.FS(distFS))

	// 4. Register unified handler for both static routing and proxying
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Forward any request to /api/* directly to the local Ollama daemon
		if strings.HasPrefix(r.URL.Path, "/api") {
			log.Printf("[Proxy] Forwarding %s %s to Ollama", r.Method, r.URL.Path)
			proxy.ServeHTTP(w, r)
			return
		}

		// Handle Angular client-side SPA routing fallback
		path := r.URL.Path
		if path == "/" {
			fileServer.ServeHTTP(w, r)
			return
		}

		// Check if file exists in embedded assets
		_, err := distFS.Open(strings.TrimPrefix(path, "/"))
		if err != nil {
			// File doesn't exist (e.g. /settings or /c/chat_123). Serve index.html so Angular router can mount it.
			log.Printf("[SPA Router] Redirecting %s to index.html", path)
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})

	// 5. Determine UI Server Port
	port := os.Getenv("OLLAMA_UI_PORT")
	if port == "" {
		port = "9090"
	}

	log.Printf("=========================================================")
	log.Printf("  Standalone Ollama Web UI (Installable CLI Wrapper)      ")
	log.Printf("=========================================================")
	log.Printf("  Server Address : http://localhost:%s", port)
	log.Printf("  Ollama Target  : %s", ollamaHost)
	log.Printf("=========================================================")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
