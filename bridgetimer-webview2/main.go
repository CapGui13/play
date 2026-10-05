package main

import (
	"context"
	"encoding/json"
	_ "embed"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
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

	gwlpWndProc = ^uintptr(3) // -4
	wmActivate = 0x0006
	wmShowWindow = 0x0018
	wmThemeChanged = 0x031A
	wmClose = 0x0010
	wmAppDarkTitle = 0x8061
	waInactive = 0
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

type openFileNameW struct {
	LStructSize       uint32
	HwndOwner         uintptr
	HInstance         uintptr
	LpstrFilter       *uint16
	LpstrCustomFilter *uint16
	NMaxCustFilter    uint32
	NFilterIndex      uint32
	LpstrFile         *uint16
	NMaxFile          uint32
	LpstrFileTitle    *uint16
	NMaxFileTitle     uint32
	LpstrInitialDir   *uint16
	LpstrTitle        *uint16
	Flags             uint32
	NFileOffset       uint16
	NFileExtension    uint16
	LpstrDefExt       *uint16
	LCustData         uintptr
	LpfnHook          uintptr
	LpTemplateName    *uint16
	PvReserved        uintptr
	DwReserved        uint32
	FlagsEx           uint32
}


var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32 = syscall.NewLazyDLL("user32.dll")
	dwmapi = syscall.NewLazyDLL("dwmapi.dll")
	comdlg32 = syscall.NewLazyDLL("comdlg32.dll")
	getWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	setWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	getWindowPlacement = user32.NewProc("GetWindowPlacement")
	setWindowPlacement = user32.NewProc("SetWindowPlacement")
	monitorFromWindow = user32.NewProc("MonitorFromWindow")
	getMonitorInfoW = user32.NewProc("GetMonitorInfoW")
	setWindowPos = user32.NewProc("SetWindowPos")
	enumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	callWindowProcW = user32.NewProc("CallWindowProcW")
	postMessageW = user32.NewProc("PostMessageW")
	findWindowW = user32.NewProc("FindWindowW")
	showWindow = user32.NewProc("ShowWindow")
	setForegroundWindow = user32.NewProc("SetForegroundWindow")
	setProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	setProcessDPIAware = user32.NewProc("SetProcessDPIAware")
	monitorFromRect = user32.NewProc("MonitorFromRect")
	createMutexW = kernel32.NewProc("CreateMutexW")
	closeHandle = kernel32.NewProc("CloseHandle")
	dwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	getSaveFileNameW = comdlg32.NewProc("GetSaveFileNameW")
	getOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")

	fullscreenMu sync.Mutex
	fullscreen bool
	savedStyle uintptr
	savedPlace windowPlacement

	originalWndProc uintptr
	darkWndProcCallback uintptr

	monitorEnumCallback uintptr
	monitorScratch []uintptr
	selectedMonitor int
	instanceMutex uintptr
)

func enableNativeDPIAwareness() {
	// WebView2 must be created by a DPI-aware process. Otherwise Windows can
	// bitmap-scale the whole composition surface, which visibly stair-steps
	// the huge timer digits on 125%/150% displays.
	const perMonitorAwareV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	if err := setProcessDpiAwarenessContext.Find(); err == nil {
		if ok, _, _ := setProcessDpiAwarenessContext.Call(perMonitorAwareV2); ok != 0 {
			return
		}
	}
	// Fallback for older Windows.
	if err := setProcessDPIAware.Find(); err == nil {
		setProcessDPIAware.Call()
	}
}

func appDataPath() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	p := filepath.Join(base, "BridgeTimerWebView2")
	_ = os.MkdirAll(p, 0700)
	return p
}

func acquireSingleInstance() bool {
	name, _ := syscall.UTF16FromString("Local\\BridgeTimerWebView2")
	h, _, err := createMutexW.Call(0, 0, uintptr(unsafe.Pointer(&name[0])))
	if h == 0 {
		return true
	}
	if err == syscall.Errno(183) {
		title, _ := syscall.UTF16FromString(appTitle)
		wnd, _, _ := findWindowW.Call(0, uintptr(unsafe.Pointer(&title[0])))
		if wnd != 0 {
			showWindow.Call(wnd, 9) // SW_RESTORE
			setForegroundWindow.Call(wnd)
		}
		closeHandle.Call(h)
		return false
	}
	instanceMutex = h
	return true
}

func releaseSingleInstance() {
	if instanceMutex != 0 {
		closeHandle.Call(instanceMutex)
		instanceMutex = 0
	}
}

func windowStatePath() string {
	return filepath.Join(appDataPath(), "window.json")
}

func loadWindowState() (savedWindowState, bool) {
	var x savedWindowState
	b, err := os.ReadFile(windowStatePath())
	if err != nil || json.Unmarshal(b, &x) != nil {
		return x, false
	}
	if x.Right-x.Left < 640 || x.Bottom-x.Top < 480 {
		return x, false
	}
	r := rect{Left: x.Left, Top: x.Top, Right: x.Right, Bottom: x.Bottom}
	mon, _, _ := monitorFromRect.Call(uintptr(unsafe.Pointer(&r)), 0) // MONITOR_DEFAULTTONULL
	if mon == 0 {
		return x, false
	}
	return x, true
}

func restoreWindowState(hwnd uintptr) {
	x, ok := loadWindowState()
	if !ok {
		return
	}
	setWindowPos.Call(
		hwnd, 0,
		uintptr(x.Left), uintptr(x.Top),
		uintptr(x.Right-x.Left), uintptr(x.Bottom-x.Top),
		swpNoZOrder|swpNoOwnerZOrder|swpFrameChanged,
	)
	if x.ShowCmd == 3 {
		showWindow.Call(hwnd, 3) // SW_MAXIMIZE
	}
}

func saveWindowState(hwnd uintptr) {
	wp := windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{}))}
	ok, _, _ := getWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp)))
	if ok == 0 {
		return
	}
	x := savedWindowState{
		Left: wp.RcNormalPosition.Left, Top: wp.RcNormalPosition.Top,
		Right: wp.RcNormalPosition.Right, Bottom: wp.RcNormalPosition.Bottom,
		ShowCmd: wp.ShowCmd,
	}
	b, err := json.Marshal(x)
	if err == nil {
		_ = os.WriteFile(windowStatePath(), b, 0600)
	}
}

func applyDarkTitleBar(hwnd uintptr) {
	enabled := int32(1)
	for _, attr := range []uintptr{20, 19} {
		r, _, _ := dwmSetWindowAttribute.Call(hwnd, attr, uintptr(unsafe.Pointer(&enabled)), unsafe.Sizeof(enabled))
		if r == 0 {
			break
		}
	}
	caption := uint32(0x0025140D)
	text := uint32(0x00FCFAF8)
	border := uint32(0x00554433)
	dwmSetWindowAttribute.Call(hwnd, 35, uintptr(unsafe.Pointer(&caption)), unsafe.Sizeof(caption))
	dwmSetWindowAttribute.Call(hwnd, 36, uintptr(unsafe.Pointer(&text)), unsafe.Sizeof(text))
	dwmSetWindowAttribute.Call(hwnd, 34, uintptr(unsafe.Pointer(&border)), unsafe.Sizeof(border))
	setWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpNoOwnerZOrder|swpFrameChanged)
}

func darkTitleWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmClose:
		saveWindowState(hwnd)
	case wmActivate:
		if wp&0xFFFF != waInactive {
			postMessageW.Call(hwnd, wmAppDarkTitle, 0, 0)
		}
	case wmShowWindow, wmThemeChanged:
		postMessageW.Call(hwnd, wmAppDarkTitle, 0, 0)
	case wmAppDarkTitle:
		applyDarkTitleBar(hwnd)
	}
	if originalWndProc != 0 {
		r, _, _ := callWindowProcW.Call(originalWndProc, hwnd, msg, wp, lp)
		return r
	}
	return 0
}

func installDarkTitleHook(hwnd uintptr) {
	if darkWndProcCallback == 0 {
		darkWndProcCallback = syscall.NewCallback(darkTitleWndProc)
	}
	if originalWndProc == 0 {
		prev, _, _ := setWindowLongPtrW.Call(hwnd, gwlpWndProc, darkWndProcCallback)
		originalWndProc = prev
	}
	// Queue one repaint after the subclass is installed. From then on,
	// WM_ACTIVATE/WM_SHOWWINDOW keep the non-client frame correct.
	postMessageW.Call(hwnd, wmAppDarkTitle, 0, 0)
}
type savedWindowState struct {
	Left    int32 `json:"left"`
	Top     int32 `json:"top"`
	Right   int32 `json:"right"`
	Bottom  int32 `json:"bottom"`
	ShowCmd uint32 `json:"show_cmd"`
}

type nativeMonitorStatus struct {
	Selected int `json:"selected"`
	Count    int `json:"count"`
}

type nativeMonitor struct {
	Handle  uintptr
	Rect    rect
	Primary bool
}

func enumMonitorProc(hmon, hdc, lprc, data uintptr) uintptr {
	monitorScratch = append(monitorScratch, hmon)
	return 1
}

func enumerateMonitors() []nativeMonitor {
	if monitorEnumCallback == 0 {
		monitorEnumCallback = syscall.NewCallback(enumMonitorProc)
	}
	monitorScratch = monitorScratch[:0]
	enumDisplayMonitors.Call(0, 0, monitorEnumCallback, 0)

	out := make([]nativeMonitor, 0, len(monitorScratch))
	for _, h := range monitorScratch {
		mi := monitorInfo{CbSize: uint32(unsafe.Sizeof(monitorInfo{}))}
		ok, _, _ := getMonitorInfoW.Call(h, uintptr(unsafe.Pointer(&mi)))
		if ok != 0 {
			out = append(out, nativeMonitor{
				Handle: h,
				Rect: mi.RcMonitor,
				Primary: mi.DwFlags&1 != 0,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Primary != out[j].Primary {
			return out[i].Primary
		}
		if out[i].Rect.Top != out[j].Rect.Top {
			return out[i].Rect.Top < out[j].Rect.Top
		}
		return out[i].Rect.Left < out[j].Rect.Left
	})
	return out
}

func monitorStatusLocked() nativeMonitorStatus {
	mons := enumerateMonitors()
	if len(mons) == 0 {
		selectedMonitor = 0
		return nativeMonitorStatus{Selected: 1, Count: 1}
	}
	if selectedMonitor < 0 || selectedMonitor >= len(mons) {
		selectedMonitor = 0
	}
	return nativeMonitorStatus{Selected: selectedMonitor + 1, Count: len(mons)}
}

func moveFullscreenToSelectedLocked(hwnd uintptr) {
	mons := enumerateMonitors()
	if len(mons) == 0 {
		return
	}
	if selectedMonitor < 0 || selectedMonitor >= len(mons) {
		selectedMonitor = 0
	}
	r := mons[selectedMonitor].Rect
	setWindowPos.Call(
		hwnd, 0,
		uintptr(r.Left), uintptr(r.Top),
		uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top),
		swpNoZOrder|swpNoOwnerZOrder|swpFrameChanged,
	)
}

func setProjectionMonitor(hwnd uintptr, requested int) nativeMonitorStatus {
	fullscreenMu.Lock()
	defer fullscreenMu.Unlock()

	mons := enumerateMonitors()
	if len(mons) == 0 {
		selectedMonitor = 0
		return nativeMonitorStatus{Selected: 1, Count: 1}
	}
	if requested < 1 {
		requested = 1
	}
	if requested > len(mons) {
		requested = len(mons)
	}
	selectedMonitor = requested - 1
	if fullscreen {
		moveFullscreenToSelectedLocked(hwnd)
	}
	return nativeMonitorStatus{Selected: selectedMonitor + 1, Count: len(mons)}
}

func cycleProjectionMonitor(hwnd uintptr) nativeMonitorStatus {
	fullscreenMu.Lock()
	defer fullscreenMu.Unlock()

	mons := enumerateMonitors()
	if len(mons) == 0 {
		selectedMonitor = 0
		return nativeMonitorStatus{Selected: 1, Count: 1}
	}
	selectedMonitor = (selectedMonitor + 1) % len(mons)
	if fullscreen {
		moveFullscreenToSelectedLocked(hwnd)
	}
	return nativeMonitorStatus{Selected: selectedMonitor + 1, Count: len(mons)}
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

		newStyle := style &^ uintptr(wsCaption|wsThickFrame|wsMinimizeBox|wsMaximizeBox|wsSysMenu)
		setWindowLongPtrW.Call(hwnd, uintptr(styleIndex), newStyle)

		mons := enumerateMonitors()
		if len(mons) == 0 {
			mon, _, _ := monitorFromWindow.Call(hwnd, monitorDefaultToNearest)
			mi := monitorInfo{CbSize: uint32(unsafe.Sizeof(monitorInfo{}))}
			if mon == 0 {
				return false
			}
			ok, _, _ := getMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
			if ok == 0 {
				return false
			}
			setWindowPos.Call(
				hwnd, 0,
				uintptr(mi.RcMonitor.Left), uintptr(mi.RcMonitor.Top),
				uintptr(mi.RcMonitor.Right-mi.RcMonitor.Left),
				uintptr(mi.RcMonitor.Bottom-mi.RcMonitor.Top),
				swpNoZOrder|swpNoOwnerZOrder|swpFrameChanged,
			)
		} else {
			moveFullscreenToSelectedLocked(hwnd)
		}
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
	applyDarkTitleBar(hwnd)
	return false
}


func utf16Multi(s string) []uint16 {
	out := utf16.Encode([]rune(s))
	return append(out, 0)
}

func bridgeTimerDialogFilter() []uint16 {
	return utf16Multi("Fichier Bridge Timer (*.bridge-timer)\x00*.bridge-timer\x00Tous les fichiers (*.*)\x00*.*\x00")
}

func exportBridgeTimerFile(hwnd uintptr, payload string) bool {
	buf := make([]uint16, 1024)
	defaultName, _ := syscall.UTF16FromString("BridgeTimer.bridge-timer")
	copy(buf, defaultName)
	filter := bridgeTimerDialogFilter()
	title, _ := syscall.UTF16FromString("Exporter la configuration Bridge Timer")
	defExt, _ := syscall.UTF16FromString("bridge-timer")

	ofn := openFileNameW{
		LStructSize:  uint32(unsafe.Sizeof(openFileNameW{})),
		HwndOwner:    hwnd,
		LpstrFilter:  &filter[0],
		NFilterIndex: 1,
		LpstrFile:    &buf[0],
		NMaxFile:     uint32(len(buf)),
		LpstrTitle:   &title[0],
		LpstrDefExt:  &defExt[0],
		Flags:        0x00000002 | 0x00000008 | 0x00000800 | 0x00080000, // overwrite/nochangedir/pathmustexist/explorer
	}
	ok, _, _ := getSaveFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ok == 0 {
		return false
	}
	path := syscall.UTF16ToString(buf)
	if filepath.Ext(path) == "" {
		path += ".bridge-timer"
	}
	if err := os.WriteFile(path, []byte(payload), 0600); err != nil {
		log.Printf("export config: %v", err)
		return false
	}
	return true
}

func importBridgeTimerFile(hwnd uintptr) string {
	buf := make([]uint16, 1024)
	filter := bridgeTimerDialogFilter()
	title, _ := syscall.UTF16FromString("Importer une configuration Bridge Timer")

	ofn := openFileNameW{
		LStructSize:  uint32(unsafe.Sizeof(openFileNameW{})),
		HwndOwner:    hwnd,
		LpstrFilter:  &filter[0],
		NFilterIndex: 1,
		LpstrFile:    &buf[0],
		NMaxFile:     uint32(len(buf)),
		LpstrTitle:   &title[0],
		Flags:        0x00000008 | 0x00000800 | 0x00001000 | 0x00080000, // nochangedir/pathmustexist/filemustexist/explorer
	}
	ok, _, _ := getOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ok == 0 {
		return ""
	}
	path := syscall.UTF16ToString(buf)
	fi, err := os.Stat(path)
	if err != nil || fi.Size() > 8*1024*1024 {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("import config: %v", err)
		return ""
	}
	return string(b)
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

	enableNativeDPIAwareness()

	if !acquireSingleInstance() {
		return
	}
	defer releaseSingleInstance()

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
	restoreWindowState(hwnd)
	applyDarkTitleBar(hwnd)
	installDarkTitleHook(hwnd)
	if err := w.Bind("nativeFullscreen", func() bool {
		return toggleNativeFullscreen(hwnd)
	}); err != nil {
		log.Printf("fullscreen bind: %v", err)
	}
	if err := w.Bind("nativeSetMonitor", func(index int) nativeMonitorStatus {
		return setProjectionMonitor(hwnd, index)
	}); err != nil {
		log.Printf("monitor select bind: %v", err)
	}
	if err := w.Bind("nativeCycleMonitor", func() nativeMonitorStatus {
		return cycleProjectionMonitor(hwnd)
	}); err != nil {
		log.Printf("monitor cycle bind: %v", err)
	}
	if err := w.Bind("nativeExportConfig", func(payload string) bool {
		return exportBridgeTimerFile(hwnd, payload)
	}); err != nil {
		log.Printf("export config bind: %v", err)
	}
	if err := w.Bind("nativeImportConfig", func() string {
		return importBridgeTimerFile(hwnd)
	}); err != nil {
		log.Printf("import config bind: %v", err)
	}

	w.Navigate(url)
	w.Run()
}
