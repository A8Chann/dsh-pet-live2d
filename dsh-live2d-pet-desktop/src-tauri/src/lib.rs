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
///
/// 建窗口时也要用它（"她该出现在哪块屏上"由光标决定），所以是 `pub(crate)`。
#[cfg(windows)]
pub(crate) fn cursor_screen_pos() -> Option<(i32, i32)> {
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
pub(crate) fn cursor_screen_pos() -> Option<(i32, i32)> {
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
            // ⚠️ 这里**不要**按光标所在屏幕搬窗口。
            //
            // 试过：她于是"跟着鼠标所在的屏幕跑"（用户的原话是"宠物应该是在固定位置"）。
            // 她是桌面上的宠物，位置属于她自己 —— 指针移到别的屏时她待在原地，只是视线
            // 到屏幕边缘就贴边。换屏只有两个入口：启动时落到光标所在屏、用户在托盘里指定。
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

/// `--attach <url>`：**挂载模式** —— 窗口从 DSH 取页面、宠物数据与相位，本机不再自己
/// 扫宠物目录、不再自己发资产。
///
/// 这是"改 bug 只改一处"的落点：挂载时宿主半区只剩 `lib/index.js` 一份在干活，我们这边
/// 的 Rust 宿主一次都不参与。DSH 关掉就退回独立模式（`--attach` 只在启动时判定一次）。
fn resolve_attach() -> Option<String> {
    let raw = parse_arg("--attach")
        .or_else(|| std::env::var("PET_DESKTOP_ATTACH").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "none");
    raw.map(|value| {
        if value.starts_with("http://") || value.starts_with("https://") {
            value
        } else {
            format!("http://{value}")
        }
    })
}

/// `%DSH_HOME%`：`pets/` 与显示层偏好文件（`pet-desktop.json`）都在这里，与网页端插件同源。
fn resolve_home() -> std::path::PathBuf {
    std::env::var("DSH_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()))
                .join(".dsh")
        })
}

/// 显示层轮询：**刷新心跳**，并按"该不该显示"显示/隐藏窗口。
///
/// 每 1 秒一轮，比心跳 TTL（6 秒）密得多 —— 用户在设置里切到「页面内」之后，桌面这只
/// 一秒内就让位，不用等超时。
fn spawn_display_loop(app: AppHandle, shared: Arc<Mutex<Shared>>, home: std::path::PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        // 心跳：只要进程活着就一直刷（哪怕窗口是藏着的）—— 藏起来不等于退出，
        // 用户可能只是想暂时看页面里那只。
        if host::display::publish_heartbeat(&home).is_err() {
            continue;
        }
        let preference = host::display::read_preference(&home);
        let mode = host::display::normalise_mode(preference.get("mode"));
        let should_show = host::display::compute_owner(&mode, true) == "desktop";
        if let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) {
            match window.is_visible() {
                Ok(visible) if visible == should_show => {}
                _ => {
                    if should_show {
                        let _ = window.show();
                    } else {
                        let _ = window.hide();
                    }
                }
            }
        }
        let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
        guard.layer_mode = mode;
        guard.owner = if should_show { "desktop".to_string() } else { "inline".to_string() };
        guard.window_visible = should_show;
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active = parse_active();
    let attach = resolve_attach();
    // 页面模式也走环境变量：host 与页面读的是同一个值。
    if let Some(page) = parse_arg("--page") {
        std::env::set_var("PET_DESKTOP_PAGE", page);
    }
    // `--dsh inline`：把显示层偏好设成"页面内"再启动 —— 只给驱动用（桌面上那只必须让位，
    // 而"页面内"是它唯一不会自动退回的 mode）。普通用户不需要这个参数。
    if let Some(dsh) = parse_arg("--dsh") {
        if dsh == "inline" {
            let home = resolve_home();
            let _ = host::display::write_preference(
                &home,
                serde_json::json!({ "mode": "inline" }),
            );
            eprintln!("[shell] 显示层偏好已设为 inline（桌面端不让位）");
        } else {
            std::env::set_var("PET_DESKTOP_DSH", dsh);
        }
    }
    // 挂载模式下相位由上游直接推给页面（`/api/live2d-pet/events` 走转发），
    // 本机那条 DSH 桥就不需要了 —— 让它别去抢同一个上游。
    if attach.is_some() {
        std::env::set_var("PET_DESKTOP_DSH", "none");
    }
    let shared = Shared::new(active);

    tauri::Builder::default()
        .manage(shared.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let runtime = resolve_runtime_dir(&handle);
            let pets_root = resolve_pets_root();
            let home = resolve_home();
            eprintln!("[shell] 运行期目录：{}", runtime.display());
            eprintln!("[shell] DSH_HOME：{}", home.display());
            match &attach {
                Some(upstream) => eprintln!("[shell] **挂载模式**：宠物数据与相位都来自 {upstream}"),
                None => eprintln!("[shell] 独立模式：宠物目录 {}", pets_root.display()),
            }

            // 随包宠物只在独立模式下解包：挂载时宠物由 DSH 那边的插件负责，本机碰它
            // 没有意义（也不该在挂载时去写用户的宠物目录）。
            let plugin_root = runtime.join("plugin");
            if attach.is_none() && !host::embed::plugin_extracted(&plugin_root) {
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

            let host = host::serve(shared.clone(), pets_root, plugin_root, attach.clone(), home.clone())?;
            eprintln!("[shell] 宿主已就绪：{}", host.url);
            pet_window::create_pet_window(&handle, &host::page_url(&host))?;
            tray::setup(app)?;
            spawn_hover_loop(handle.clone(), shared.clone());

            // ---- 显示层：桌面端要不要显示、以及"我还活着"的心跳 ----
            //
            // 用户在 DSH 设置里选了「页面内」时，这个窗口必须让位（否则桌面上和页面里各
            // 一只）。判定读的是两端共用的偏好文件，规则在 `host::display` 里，有单元测试。
            host::display::publish_heartbeat(&home)?;
            spawn_display_loop(handle.clone(), shared.clone(), home.clone());

            // 相位桥：订阅运行中 DSH 的相位流。DSH 没开就只是 idle，宠物照样自己摸鱼。
            let dsh_base =
                std::env::var("PET_DESKTOP_DSH").unwrap_or_else(|_| "http://127.0.0.1:3080".to_string());
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
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                // 退出时清掉心跳：页面里那只**立刻**回来，不用等 6 秒超时。
                let home = resolve_home();
                host::display::clear_heartbeat(&home);
            }
        });
}
