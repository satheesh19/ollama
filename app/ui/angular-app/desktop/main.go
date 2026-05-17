package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

//go:embed dist/*
var embedFS embed.FS

// GPUInfo holds the response metadata
type GPUInfo struct {
	TotalMemoryBytes int64   `json:"total_memory_bytes"`
	TotalMemoryGB    float64 `json:"total_memory_gb"`
	GPUName          string  `json:"gpu_name"`
}

func getGPUInfo() GPUInfo {
	info := GPUInfo{
		TotalMemoryBytes: 8589934592, // Default fallback to 8GB
		TotalMemoryGB:    8.0,
		GPUName:          "Default Display Device",
	}

	if runtime.GOOS == "windows" {
		// Run powershell Win32_VideoController query to retrieve Name and VRAM Size
		cmd := exec.Command("powershell", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -Property Name, AdapterRAM | ConvertTo-Json")
		output, err := cmd.Output()
		if err == nil {
			var raw interface{}
			if err := json.Unmarshal(output, &raw); err == nil {
				switch v := raw.(type) {
				case map[string]interface{}:
					parseController(v, &info)
				case []interface{}:
					// Dual controller laptop configuration: choose the one with larger RAM (discrete card)
					for _, item := range v {
						if m, ok := item.(map[string]interface{}); ok {
							parseController(m, &info)
						}
					}
				}
			}
		}
	} else if runtime.GOOS == "darwin" {
		// On Apple Silicon macOS, retrieve unified host system memory
		cmd := exec.Command("sysctl", "-n", "hw.memsize")
		output, err := cmd.Output()
		if err == nil {
			bytesStr := strings.TrimSpace(string(output))
			bytes, err := strconv.ParseInt(bytesStr, 10, 64)
			if err == nil {
				info.TotalMemoryBytes = bytes
				info.TotalMemoryGB = float64(bytes) / (1024 * 1024 * 1024)
				info.GPUName = "Apple Silicon Unified Memory"
			}
		}
	} else {
		// Linux fallback: parse nvidia-smi controller query
		cmd := exec.Command("nvidia-smi", "--query-gpu=memory.total,name", "--format=csv,noheader,nounits")
		output, err := cmd.Output()
		if err == nil {
			parts := strings.Split(strings.TrimSpace(string(output)), ",")
			if len(parts) >= 1 {
				ramMB, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
				if err == nil {
					info.TotalMemoryBytes = ramMB * 1024 * 1024
					info.TotalMemoryGB = float64(info.TotalMemoryBytes) / (1024 * 1024 * 1024)
				}
				if len(parts) >= 2 {
					info.GPUName = strings.TrimSpace(parts[1])
				} else {
					info.GPUName = "NVIDIA System GPU"
				}
			}
		}
	}

	return info
}

func parseController(m map[string]interface{}, info *GPUInfo) {
	ramVal := m["AdapterRAM"]
	nameVal := m["Name"]
	if ramVal != nil {
		var ram int64
		switch r := ramVal.(type) {
		case float64:
			ram = int64(r)
		case string:
			ram, _ = strconv.ParseInt(r, 10, 64)
		}
		
		// Ensure it's a valid ram size
		if ram > info.TotalMemoryBytes {
			info.TotalMemoryBytes = ram
			info.TotalMemoryGB = float64(ram) / (1024 * 1024 * 1024)
		}
	}
	if nameVal != nil && (info.GPUName == "Default Display Device" || info.GPUName == "") {
		if nameStr, ok := nameVal.(string); ok && nameStr != "" {
			info.GPUName = nameStr
		}
	}
}

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
		// Handle dynamic GPU hardware lookup endpoint locally
		if r.URL.Path == "/api/system/gpu" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET")
			info := getGPUInfo()
			json.NewEncoder(w).Encode(info)
			return
		}

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
