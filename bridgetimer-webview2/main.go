package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

//go:embed timer.html
var timerHTML []byte

const (
	appTitle = "Bridge Timer"
	host = "127.0.0.1"
	port = 43831

	wsCaption = 0x00C00000
	wsThickFrame = 0x00040000
	wsMinimizeBox = 0x00020000
	wsMaximizeBox = 0x00010000
	wsSysMenu = 0x00080000

	monitorDefaultToNearest = 2
	swpNoSize = 0x0001
	swpNoMove = 0x0002
	swpNoZOrder = 0x0004
	swpFrameChanged = 0x0020
	swpNoOwnerZOrder = 0x0200
)

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type windowPlacement struct {
	Length uint32
	Flags uint32
	ShowCmd uint32
	PtMinPosition point
	PtMaxPosition point
	RcNormalPosition rect
}
type monitorInfo struct {
	CbSize uint32
	RcMonitor rect
	RcWork rect
	DwFlags uint32
}

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	getWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	setWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	getWindowPlacement = user32.NewProc("GetWindowPlacement")
	setWindowPlacement = user32.NewProc("SetWindowPlacement")
	monitorFromWindow = user32.NewProc("MonitorFromWindow")
	getMonitorInfoW = user32.NewProc("GetMonitorInfoW")
	setWindowPos = user32.NewProc("SetWindowPos")

	fullscreenMu sync.Mutex
	fullscreen bool
	savedStyle uintptr
	savedPlace windowPlacement
)

func appDataPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	p := filepath.Join(base, "BridgeTimerWebView2")
	_ = os.MkdirAll(p, 0700)
	return p
}

func toggleNativeFullscreen(hwnd uintptr) bool {
	fullscreenMu.Lock()
	defer fullscreenMu.Unlock()

	styleIndex := int32(-16)

	if !fullscreen {
		style, _, _ := getWindowLongPtrW.Call(hwnd, uintptr(styleIndex))
		savedStyle = style

		savedPlace = windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{}))}
		getWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&savedPlace)))

		mon, _, _ := monitorFromWindow.Call(hwnd, monitorDefaultToNearest)
		mi := monitorInfo{CbSize: uint32(unsafe.Sizeof(monitorInfo{}))}
		if mon == 0 {
			return false
		}
		ok, _, _ := getMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
		if ok == 0 {
			return false
		}

		newStyle := style &^ uintptr(wsCaption|wsThickFrame|wsMinimizeBox|wsMaximizeBox|wsSysMenu)
		setWindowLongPtrW.Call(hwnd, uintptr(styleIndex), newStyle)
		setWindowPos.Call(
			hwnd, 0,
			uintptr(mi.RcMonitor.Left), uintptr(mi.RcMonitor.Top),
			uintptr(mi.RcMonitor.Right-mi.RcMonitor.Left),
			uintptr(mi.RcMonitor.Bottom-mi.RcMonitor.Top),
			swpNoZOrder|swpNoOwnerZOrder|swpFrameChanged,
		)
		fullscreen = true
		return true
	}

	setWindowLongPtrW.Call(hwnd, uintptr(styleIndex), savedStyle)
	if savedPlace.Length != 0 {
		setWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&savedPlace)))
	}
	setWindowPos.Call(
		hwnd, 0, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoZOrder|swpNoOwnerZOrder|swpFrameChanged,
	)
	fullscreen = false
	return false
}

func startLocalServer() (*http.Server, string, error) {
	addr := fmt.Sprintf("%s:%d", host, port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, "", err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(timerHTML)
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("local server: %v", err)
		}
	}()
	return srv, "http://" + addr + "/", nil
}

func main() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	srv, url, err := startLocalServer()
	if err != nil {
		log.Printf("Bridge Timer local server: %v", err)
		return
	}
	defer srv.Shutdown(context.Background())

	dataPath := filepath.Join(appDataPath(), "WebView2Data")
	_ = os.MkdirAll(dataPath, 0700)

	w := webview.NewWithOptions(webview.WebViewOptions{
		Debug: false,
		DataPath: dataPath,
		AutoFocus: true,
		WindowOptions: webview.WindowOptions{
			Title: appTitle,
			Width: 1280,
			Height: 820,
			Center: true,
		},
	})
	if w == nil {
		log.Printf("WebView2 initialization failed")
		return
	}
	defer w.Destroy()

	hwnd := uintptr(w.Window())
	if err := w.Bind("nativeFullscreen", func() bool {
		return toggleNativeFullscreen(hwnd)
	}); err != nil {
		log.Printf("fullscreen bind: %v", err)
	}

	w.Navigate(url)
	w.Run()
}
