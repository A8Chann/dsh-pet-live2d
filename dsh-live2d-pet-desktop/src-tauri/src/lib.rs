// 桌面端外壳（Tauri）的入口。
//
// **一次架构替换**：原来"壳 + Node sidecar（deno compile 出来的独立二进制）"那套，
// sidecar 被换成了同进程里的 Rust 宿主半区（`src/host/`）。动机只有一个字：体积 ——
// deno 那条路实测 exe 95MB（其中 86MB 是 V8 运行时，`deno compile` 没有 `--strip`、
// `llvm-strip` 也压不动），翻成 Rust 之后回到十几 MB。
//
// 现在的分工：
//
//   * **壳**：窗口（透明、置顶、不进任务栏）、穿透轮询、托盘；
//   * **host**：宠物目录扫描 → catalog、资产路由（引用闭包白名单）、相位流（SSE）、
//     页面分发，全部在同一个进程里，回环端口只给 WebView 用；
//   * **页面**：跑的还是 `lib/client.js`，一行没改 —— 它认的是
//     `/api/live2d-pet/*` 与 `/__desktop/*` 这两组路径，谁在背后答它并不关心。
//
// 进程内共享状态在 `host::Shared` 里（以前壳要把它写进 shell-state.json 让 sidecar 读，
// 现在直接读内存）。
// `pub` 是为了让诊断/对拍用的小工具（`src/bin/diag-catalog.rs`）能直接调宿主半区，
// 不用起窗口。发布产物不受影响（bin 不进最终 exe）。
pub mod host;
mod pet_window;
mod tray;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use host::shared::{Point, Shared};

/// 运行期目录：随包插件的解包处。
///
/// **便携优先**：exe 旁边可写就用 `.\DSH桌宠-data\`（U 盘、绿色版直接带着走）；
/// 不可写（放在 Program Files、只读盘）才退回 `%LOCALAPPDATA%\<identifier>\runtime\`。
/// 判据是**真的写一次试试**，不是猜路径权限。
pub fn resolve_runtime_dir(app: &AppHandle) -> std::path::PathBuf {
    let probe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("DSH桌宠-data")));
    if let Some(dir) = probe {
        if std::fs::create_dir_all(&dir).is_ok() {
            let test = dir.join(".writable");
            if std::fs::write(&test, b"1").is_ok() {
                let _ = std::fs::remove_file(&test);
                return dir;
            }
        }
    }
    let fallback = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("DSH桌宠"));
    let _ = std::fs::create_dir_all(fallback.join("runtime"));
    fallback.join("runtime")
}

/// 宠物根目录：`%DSH_HOME%\pets`（默认 `~/.dsh/pets`），与网页端插件同一份。
fn resolve_pets_root() -> std::path::PathBuf {
    host::http::default_pets_root()
}

/// `--active=false`：关掉穿透轮询，窗口一直吃事件。**A/B 对照用**——
/// "这层透明玻璃到底挡不挡桌面"这个问题只有对照组才回答得了。
fn parse_active() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--active=false") {
        return false;
    }
    match std::env::var("PET_DESKTOP_ACTIVE") {
        Ok(value) => value != "false",
        Err(_) => true,
    }
}

fn parse_arg(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == flag)?;
    args.get(at + 1).cloned()
}

/// 光标位置（屏幕物理像素）。非 Windows 上返回 None —— 只在 Windows 上验过。
#[cfg(windows)]
fn cursor_screen_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        None
    } else {
        Some((point.x, point.y))
    }
}

#[cfg(not(windows))]
fn cursor_screen_pos() -> Option<(i32, i32)> {
    None
}

/// 穿透轮询：读光标 → 问页面（经 host 的内存任务）→ 切窗口的忽略状态 → 写回状态。
///
/// 为什么轮询而不是听事件：窗口一旦忽略光标事件，Windows 就把命中测试交给下层窗口，
/// **页面收不到鼠标移动**。所以"该不该忽略"这个判断本身成了鸡生蛋问题 —— 只能自己问
/// 操作系统光标在哪（`GetCursorPos`），这与窗口吃不吃事件无关。
fn spawn_hover_loop(app: AppHandle, shared: Arc<Mutex<Shared>>) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) else {
                continue;
            };
            if !shared.lock().unwrap_or_else(|p| p.into_inner()).active {
                continue;
            }
            let Some((cx, cy)) = cursor_screen_pos() else {
                continue;
            };
            let (origin, size, scale) = {
                let position = window.outer_position().ok().map(|p| (p.x as f64, p.y as f64));
                let size = window.inner_size().ok().map(|s| (s.width, s.height));
                let scale = window.scale_factor().unwrap_or(1.0);
                (position, size, scale)
            };
            let (Some((ox, oy)), Some((w, h))) = (origin, size) else {
                continue;
            };
            let scale = if scale > 0.0 { scale } else { 1.0 };
            let local_x = (cx as f64 - ox) / scale;
            let local_y = (cy as f64 - oy) / scale;

            let inside = local_x >= 0.0 && local_y >= 0.0 && local_x < w as f64 && local_y < h as f64;
            let (interactive, reason, answered) = if inside {
                match host::http::probe_now(&shared, Point { x: local_x, y: local_y }) {
                    Some((interactive, reason)) => (interactive, reason, true),
                    None => (false, "probe-timeout".to_string(), false),
                }
            } else {
                (false, "outside".to_string(), true)
            };

            // 桌面 → 忽略光标事件（点下去穿到下层窗口）；她 → 吃事件。
            let ignore = !interactive;
            if last != Some(interactive) {
                last = Some(interactive);
                let _ = window.set_ignore_cursor_events(ignore);
            }

            let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
            if !answered {
                guard.probe_errors += 1;
            }
            guard.report_hover(
                (cx, cy),
                (local_x.round() as i32, local_y.round() as i32),
                (ox, oy),
                (w, h),
                scale,
                interactive,
                reason,
            );
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active = parse_active();
    // 页面模式也走环境变量：host 与页面读的是同一个值。
    if let Some(page) = parse_arg("--page") {
        std::env::set_var("PET_DESKTOP_PAGE", page);
    }
    if let Some(dsh) = parse_arg("--dsh") {
        std::env::set_var("PET_DESKTOP_DSH", dsh);
    }
    let shared = Shared::new(active);

    tauri::Builder::default()
        .manage(shared.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let runtime = resolve_runtime_dir(&handle);
            let pets_root = resolve_pets_root();
            eprintln!("[shell] 运行期目录：{}", runtime.display());
            eprintln!("[shell] 宠物目录：{}", pets_root.display());

            // 随包宠物解包到运行期目录：升级判定要算它们的 `pet.json` 指纹（宿主半区
            // 扫描用户宠物目录前会用它决定"要不要装/要不要更新"）。
            let plugin_root = runtime.join("plugin");
            if !host::embed::plugin_extracted(&plugin_root) {
                std::fs::create_dir_all(&plugin_root)?;
                match host::catalog::materialize_bundled_pets(&plugin_root) {
                    Ok(count) => eprintln!(
                        "[shell] 已解包随包宠物：{count} 个文件 → {}",
                        plugin_root.display()
                    ),
                    Err(error) => eprintln!("[shell] 解包随包宠物失败：{error}"),
                }
            }
            let (files, bytes) = host::embed::totals();
            eprintln!(
                "[shell] 内嵌资源：{files} 个文件（{:.2} MB）",
                bytes as f64 / 1024.0 / 1024.0
            );

            let host = host::serve(shared.clone(), pets_root, plugin_root)?;
            eprintln!("[shell] 宿主已就绪：{}", host.url);
            pet_window::create_pet_window(&handle, &host::page_url(&host))?;
            tray::setup(app)?;
            spawn_hover_loop(handle.clone(), shared.clone());

            // 相位桥：订阅运行中 DSH 的相位流。DSH 没开就只是 idle，宠物照样自己摸鱼。
            let dsh_base = std::env::var("PET_DESKTOP_DSH").unwrap_or_else(|_| "http://127.0.0.1:3080".to_string());
            if dsh_base != "none" {
                host::dsh_link::spawn(dsh_base, shared.clone());
            } else {
                let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
                guard.dsh = serde_json::json!({ "connected": false, "disabled": true });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用初始化失败")
        .run(|_app, _event| {});
}
