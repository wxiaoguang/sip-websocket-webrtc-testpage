package main

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// OpenURL opens the given URL in the user's default web browser.
// It supports macOS, Linux (including WSL), and Windows.
// The call returns once the OS has started the associated browser process.
func OpenURL(url string) error {
	if url == "" {
		return errors.New("openurl: empty URL")
	}

	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()

	case "windows":
		// Using rundll32 avoids quoting headaches with "start".
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()

	default:
		// Linux and other Unix-like systems
		candidates := make([]string, 0, 5)
		if isWSL() {
			// wslview opens the URL in the Windows default browser from WSL if available.
			candidates = append(candidates, "wslview")
		}
		candidates = append(candidates, "xdg-open", "gio", "gnome-open", "kde-open")

		var lastErr error
		for _, name := range candidates {
			if path, err := exec.LookPath(name); err == nil {
				if err := exec.Command(path, url).Start(); err == nil {
					return nil
				} else {
					lastErr = err
				}
			}
		}
		if lastErr == nil {
			lastErr = errors.New("no opener command found")
		}
		return fmt.Errorf("openurl: failed to open URL using candidates %v: %w", candidates, lastErr)
	}
}

func isWSL() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	// Common indicators for WSL
	if _, ok := os.LookupEnv("WSL_DISTRO_NAME"); ok {
		return true
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if bytes.Contains(bytes.ToLower(b), []byte("microsoft")) {
			return true
		}
	}
	if b, err := os.ReadFile("/proc/version"); err == nil {
		if bytes.Contains(bytes.ToLower(b), []byte("microsoft")) {
			return true
		}
	}
	return false
}

func GetExecutableDir() string {
	exePath, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return filepath.Dir(exePath)
}

func GetSourceRootDir() string {
	_, filename, _, ok := runtime.Caller(1)
	if !ok {
		panic("runtime.Caller() failed")
	}
	return filepath.Dir(filename)
}

func main() {
	args := os.Args[1:]
	if len(args) != 1 {
		fmt.Fprintf(os.Stderr, "Usage: ./testpage <port>\n")
		os.Exit(1)
	}

	webrootDir := ""
	for _, dir := range []string{
		filepath.Join(GetExecutableDir(), "webroot"),
		filepath.Join(GetSourceRootDir(), "webroot"),
	} {
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			webrootDir = dir
			break
		}
	}
	if webrootDir == "" {
		fmt.Fprintf(os.Stderr, "Failed to find webroot directory\n")
		os.Exit(1)
	}
	port := args[0]
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(webrootDir)))
	httpServer := &http.Server{Handler: mux}
	httpListener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Printf("Failed to start HTTP listener: %v\n", err)
	}
	fmt.Printf("Serving files from %s\n", webrootDir)
	fmt.Printf("Use browser to open http://localhost:%s\n", port)
	fmt.Println(`You must disable "Anonymize local IPs exposed by WebRTC" flag in Chrome-based browsers: chrome://flags/#enable-webrtc-hide-local-ips-with-mdns`)

	_ = OpenURL("http://localhost:" + port)
	_ = httpServer.Serve(httpListener)
}
