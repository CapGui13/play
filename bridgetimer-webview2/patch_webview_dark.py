from pathlib import Path
import subprocess
import os
import stat

cache = Path(subprocess.check_output(['go','env','GOMODCACHE'], text=True).strip())
roots = list((cache / 'github.com' / 'jchv').glob('go-webview2@*'))
if not roots:
    raise SystemExit('go-webview2 module not found')
p = roots[0] / 'webview.go'
os.chmod(p, stat.S_IWRITE)
src = p.read_text(encoding='utf-8')

create_marker = 'func (w *webview) CreateWithOptions(opts WindowOptions) bool {'
show_marker = '_, _, _ = w32.User32ShowWindow.Call(w.hwnd, w32.SWShow)'
if create_marker not in src or show_marker not in src:
    raise SystemExit('go-webview2 markers not found')

helper = r'''func applyBridgeTimerDarkBeforeShow(hwnd uintptr) {
    dll := windows.NewLazySystemDLL("dwmapi.dll")
    proc := dll.NewProc("DwmSetWindowAttribute")
    enabled := int32(1)
    _, _, _ = proc.Call(hwnd, 20, uintptr(unsafe.Pointer(&enabled)), unsafe.Sizeof(enabled))
    caption := uint32(0x0025140D)
    text := uint32(0x00FCFAF8)
    border := uint32(0x00554433)
    _, _, _ = proc.Call(hwnd, 35, uintptr(unsafe.Pointer(&caption)), unsafe.Sizeof(caption))
    _, _, _ = proc.Call(hwnd, 36, uintptr(unsafe.Pointer(&text)), unsafe.Sizeof(text))
    _, _, _ = proc.Call(hwnd, 34, uintptr(unsafe.Pointer(&border)), unsafe.Sizeof(border))
}

'''

if 'func applyBridgeTimerDarkBeforeShow' not in src:
    src = src.replace(create_marker, helper + create_marker, 1)
src = src.replace(show_marker, 'applyBridgeTimerDarkBeforeShow(w.hwnd)\n\t' + show_marker, 1)
p.write_text(src, encoding='utf-8')
print('Patched:', p)