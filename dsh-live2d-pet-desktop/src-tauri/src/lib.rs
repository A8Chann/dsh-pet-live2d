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
mod logbook;
mod pet_window;
mod tray;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use host::shared::{Point, Shared};

/// 运行期目录：随包插件的解包处。
///
/// **便携优先**：可执行文件旁边可写就用 `.\DSH桌宠-data\`（U 盘、绿色版直接带着走）；
/// 不可写（放在 Program Files、只读盘）才退回系统给的应用数据目录。判据是**真的写一次
/// 试试**，不是猜路径权限。
///
/// macOS 的 `.app` 是例外：包里的可执行文件**旁边**也能写（`Contents/MacOS/` 属于用户），
/// 但往包里写会当场破坏代码签名（下次启动 Gatekeeper 就拒），而且"便携"对 .app 本来
/// 就不成立 —— 包是只读分发物，数据该进 `~/Library/Application Support/`。见
/// [`inside_app_bundle`]。
pub fn resolve_runtime_dir(app: &AppHandle) -> std::path::PathBuf {
    let probe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("DSH桌宠-data")))
        .filter(|_| !inside_app_bundle());
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

/// 可执行文件是不是在一个 `.app` 包里（`….app/Contents/MacOS/<exe>`）。
///
/// Windows / Linux 上永远是 `false`（那里没有 `.app` 这种包，也不会有人把目录叫这名）。
fn inside_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent()          // …/Contents/MacOS
                .and_then(|dir| dir.parent())   // …/Contents
                .and_then(|dir| dir.parent())   // …/X.app
                .map(std::path::Path::to_path_buf)
        })
        .and_then(|bundle| bundle.extension().map(|ext| ext == "app"))
        .unwrap_or(false)
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

/// 这一份是不是**插件拉起的**（`--from-plugin` / `PET_DESKTOP_FROM_PLUGIN`）。
///
/// 用途只有一个：区分"用户手动启动"与"插件按设置拉起" —— 前者遇到「页面内」偏好要改写成
/// 「桌面」，后者要严格尊重用户的选择。见 `host::display::manual_launch_overrides_inline`。
fn launched_by_plugin() -> bool {
    if let Some(value) = parse_arg("--from-plugin") {
        // 允许 `--from-plugin=false` 这种写法（插件那边可能按开关传值）。
        return value != "false" && value != "0";
    }
    std::env::var("PET_DESKTOP_FROM_PLUGIN")
        .map(|value| value != "false" && value != "0")
        .unwrap_or(false)
}

/// 装一个 panic 钩子：**GUI 程序没有控制台，panic 默认谁都看不到**。
///
/// `main.rs` 上是 `windows_subsystem = "windows"`（release 双击不弹黑框），代价是启动失败
/// 只表现为"什么都没发生"。用户 2026-09 报的"直接跑 Release 里的 exe，桌宠没显示出来"
/// 与"建窗被拒"这类问题，都因此查了很久。
///
/// 钩子里做两件事：写 `%DSH_HOME%\pet-desktop.log`；Windows 上再弹一个消息框（双击场景里
/// 唯一看得见的出口）。原来的钩子照旧调一次，开发时 `RUST_BACKTRACE=1` 还是老样子。
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let home = resolve_home();
        // 日志**写不进去也要说**：用户 2026-09 第二次报的那次，弹框指的日志文件压根没生成
        // （那个进程写不进 %DSH_HOME%），而我们把失败吞掉了 —— 于是连"为什么没日志"都查不到。
        let journal = match logbook::log(&home, &format!("[shell] **起不来**：{info}")) {
            Ok(path) => {
                let _ = logbook::log(&home, &format!("[shell] 完整日志：{}", path.display()));
                format!("完整日志：\n{}", path.display())
            }
            Err(error) => format!("（日志也没写进去：{error}）"),
        };
        // 带上**是哪个文件**：同一台机器上可能有 Release 下的、dist/ 里刚构建的、
        // 插件管的那份 —— 不写清楚就得靠猜（这一次就猜了很久）。
        #[cfg(windows)]
        {
            let exe = std::env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "(拿不到 exe 路径)".to_string());
            show_error_box(
                "DSH 桌宠没能启动",
                &format!("{info}\n\n程序：{exe}\n{journal}"),
            );
        }
        previous(info);
    }));
}

/// 「已经有一只了」的提示框（不是错误，别用红色图标吓人）。
#[cfg(windows)]
fn show_info_box(title: &str, body: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONINFORMATION, MB_OK, MB_TOPMOST};
    message_box(title, body, MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
}

/// 一只只能跑一份 —— 已经有另一只在跑吗？返回那一只的 pid。
///
/// WebView2 的 user-data-dir 是**独占**的，第二个实例只会撞上
/// `0x800700AA 请求的资源在使用中`。以前那个错误被 panic 成"起不来"，用户看到的是
/// 一个报错的框，而真正该说的是"她已经在了"。判据用**心跳**（pid 会被系统重用，
/// 不能只看 pid 在不在 —— 这条规则两端共用，见 `host::display`）。
fn another_instance_running(home: &std::path::Path) -> Option<u64> {
    let preference = host::display::read_preference(home);
    let pid = preference
        .get("desktopPid")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if pid == 0 || pid == std::process::id() as u64 {
        return None;
    }
    if host::display::heartbeat_fresh(&preference, host::display::now_ms()) {
        Some(pid)
    } else {
        None
    }
}

/// Windows 上的致命错误弹窗。用系统的 `MessageBoxW`（不引额外依赖）—— 双击场景里，
/// 这是唯一能把"为什么没反应"告诉用户的地方。
#[cfg(windows)]
fn show_error_box(title: &str, body: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST};
    message_box(title, body, MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
}

#[cfg(windows)]
fn message_box(title: &str, body: &str, flags: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
    let title = wide(title);
    let body = wide(body);
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), flags);
    }
}

/// 全局光标在哪（**本平台原生口径**）。
///
/// * **Windows**：物理像素（`GetCursorPos`），原点 = 主屏左上角；
/// * **macOS**：逻辑点（`CGEventGetLocation`），原点同样是主屏左上角 —— CoreGraphics
///   的"全局显示坐标"就是这么定义的，与 `CGDisplayBounds` 同一套（tao 的屏幕框也是
///   从那儿乘上缩放来的）；
/// * **其它**（Linux/Wayland 等）：`None`。
///
/// ⚠️ "读不到" 与 "指针不在她身上" 是**两件事**：前者会让整套穿透判定失效（窗口会一直
/// 保持建窗时那个"忽略光标事件"的状态 = 她永远点不到）。所以调用方必须单独处理 `None`，
/// 不能当成 `(0, 0)`。
#[cfg(windows)]
pub(crate) fn cursor_screen_pos() -> Option<(f64, f64)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        None
    } else {
        Some((point.x as f64, point.y as f64))
    }
}

/// macOS：`CGEventCreate(NULL)` 拿到"当前鼠标"事件，再问它坐标。
///
/// **为什么不用 NSEvent**（tao 内部读光标就是用它）：那是 AppKit，而穿透轮询跑在**后台
/// 线程**上 —— AppKit 只保证主线程安全，CoreGraphics 没有这条约束。
/// 也**不需要**辅助功能/录屏权限：这里只读当前指针位置，不装事件监听。
///
/// `CGPoint` 在 64 位下就是两个 `CGFloat` = 两个 `f64`，`#[repr(C)]` 手工声明即可，
/// 不必为此引 objc2/core-graphics 依赖（那两样在 Windows 上编译不了，本地就没法检查）。
#[cfg(target_os = "macos")]
pub(crate) fn cursor_screen_pos() -> Option<(f64, f64)> {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }
    unsafe {
        // `CGEventCreate(NULL)` = "当前鼠标状态"那个事件，所有权归我们（Create 规则）。
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event as *const std::ffi::c_void);
        Some((point.x, point.y))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn cursor_screen_pos() -> Option<(f64, f64)> {
    None
}

/// 原生光标是不是"逻辑点"。只有 macOS 是。
///
/// 唯一用途：换算成窗口本地坐标时，逻辑点要先乘窗口缩放还原成物理像素 —— 见
/// [`pointer_local`]。这个分支判据只有一个地方，就是为了不让"单位"散落在各处。
pub(crate) const CURSOR_IS_LOGICAL: bool = cfg!(target_os = "macos");

/// 把全局光标换算成**窗口本地 CSS 像素**（也就是窗口本地物理像素 ÷ 缩放）。
///
/// 一条公式同时管两个平台 —— 差别只在 `k`：
///   * Windows：光标与窗口原点本来就都是物理像素、同原点 → `k = 1`；
///   * macOS：光标是逻辑点、窗口原点是物理像素 → `k = 缩放`，乘完两边同口径再相减。
///
/// 拆出 `logical` 参数只为一件事：**让两个分支都能在 Windows 上跑单元测试**
/// （否则 macOS 那一支直到 CI 才有第二次编译机会）。
pub(crate) fn pointer_local_with(
    cursor: (f64, f64),
    window_origin: (f64, f64),
    scale: f64,
    logical: bool,
) -> (f64, f64) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let k = if logical { scale } else { 1.0 };
    (
        (cursor.0 * k - window_origin.0) / scale,
        (cursor.1 * k - window_origin.1) / scale,
    )
}

/// 本平台口径下的 [`pointer_local_with`]。
pub(crate) fn pointer_local(cursor: (f64, f64), window_origin: (f64, f64), scale: f64) -> (f64, f64) {
    pointer_local_with(cursor, window_origin, scale, CURSOR_IS_LOGICAL)
}

/// 穿透轮询：读光标 → 问页面（经 host 的内存任务）→ 切窗口的忽略状态 → 写回状态。
///
/// 为什么轮询而不是听事件：窗口一旦忽略光标事件，Windows 就把命中测试交给下层窗口，
/// **页面收不到鼠标移动**。所以"该不该忽略"这个判断本身成了鸡生蛋问题 —— 只能自己问
/// 操作系统光标在哪（`GetCursorPos`），这与窗口吃不吃事件无关。
fn spawn_hover_loop(app: AppHandle, shared: Arc<Mutex<Shared>>) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        // 「读不到全局光标」只喊一次：这是**整套判定失效**级别的故障（她会一直点不到），
        // 但每 33ms 喊一次会把 stderr 刷爆。
        let mut warned_no_cursor = false;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) else {
                continue;
            };
            if !shared.lock().unwrap_or_else(|p| p.into_inner()).active {
                continue;
            }
            let Some((cx, cy)) = cursor_screen_pos() else {
                if !warned_no_cursor {
                    warned_no_cursor = true;
                    eprintln!(
                        "[shell] 这个平台读不到全局光标 —— 穿透判定用不了，\
                         她会一直处于「忽略光标事件」状态（点不到）。\
                         见 lib.rs 的 cursor_screen_pos"
                    );
                }
                continue;
            };
            warned_no_cursor = false;
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
            // 光标与窗口原点口径不同（macOS 一个是逻辑点、一个是物理像素），
            // 换算收在 `pointer_local` 里 —— 那里有单元测试，这条链上别再手写公式。
            let (local_x, local_y) = pointer_local((cx, cy), (ox, oy), scale);

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
                (cx.round() as i32, cy.round() as i32),
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
///
/// 规则的实体在 `host::http::default_home()`（主目录变量两平台不同名那件事写在那里）。
fn resolve_home() -> std::path::PathBuf {
    host::http::default_home()
}

/// 显示层轮询：**刷新心跳**，并按"该不该显示"显示/隐藏窗口。
///
/// 每 1 秒一轮，比心跳 TTL（6 秒）密得多 —— 用户在设置里切到「页面内」之后，桌面这只
/// 一秒内就让位，不用等超时。
fn spawn_display_loop(app: AppHandle, shared: Arc<Mutex<Shared>>, home: std::path::PathBuf) {
    // 第一次决定显隐时记一条日志（**只记一次**，不然每秒一行）。用户双击之后"没看到窗口"
    // 的时候，这一行就是答案："按偏好让位给页面内那只"。
    let mut announced = false;
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
            // **用户明确藏起来的时候不要把她显示回来。**
            //
            // 这是"藏起来过一会儿又自己出来"的根因：这个循环按显示层规则每帧决定显隐，
            // 而"用户在托盘里点了藏起来"是**另一件事**（意图，不是规则）—— 不分开记的话，
            // 一秒后她就被 `should_show` 显示回来了。
            let hidden_by_user = shared
                .lock()
                .map(|guard| guard.hidden_by_user)
                .unwrap_or(false);
            let want_visible = should_show && !hidden_by_user;
            if !announced {
                announced = true;
                let why = if want_visible {
                    "她在桌面上".to_string()
                } else if hidden_by_user {
                    "窗口是用户在托盘里藏起来的".to_string()
                } else {
                    format!("按偏好让位（mode={mode}）—— 想让她留在桌面上：DSH 设置里选「桌面」")
                };
                let _ = logbook::log(&home, &format!("[shell] 显示层决定：{why}"));
            }
            match window.is_visible() {
                Ok(visible) if visible == want_visible => {}
                _ => {
                    if want_visible {
                        let _ = window.show();
                    } else {
                        let _ = window.hide();
                    }
                    // 窗口可见性变了：菜单里"显示/藏起来"的可用状态要跟着变。
                    crate::tray::refresh(&app);
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
    install_panic_hook();
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
            let _ = logbook::log(&home, "[shell] 显示层偏好已设为 inline（桌面端不让位）");
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

            // 日志要落 `%DSH_HOME%\pet-desktop.log`（GUI 程序没有控制台），所以先定 home。
            // `say` 同时打 stderr 与日志文件 —— 开发时照旧看终端，用户双击时只看得到文件。
            let home = resolve_home();
            let say = |line: String| {
                let _ = logbook::log(&home, &line);
            };

            // ---- 已经有一只了就不要再开一只 ----
            //
            // WebView2 的 user-data-dir 独占，第二个实例只会撞 `0x800700AA 资源在使用中`。
            // 那种失败以前被 panic 成"起不来"（用户 2026-09 第二次报的那个框），而真正该说的
            // 是"她已经在了"。手动双击时提示一下（插件那条路自己会先查 `running()`）。
            if let Some(pid) = another_instance_running(&home) {
                say(format!(
                    "[shell] 已经有一只桌宠在跑（pid {pid}）—— 本次不再开第二只（一只只能跑一份）"
                ));
                if !launched_by_plugin() {
                    #[cfg(windows)]
                    show_info_box(
                        "DSH 桌宠已经在跑了",
                        "她已经站在桌面上了（Windows 11 的托盘图标默认收在溢出区里，点任务栏的 ^ 能看到）。\n\n\
                         想换一只：先在那只的托盘菜单里选「退出」再启动这个文件。",
                    );
                }
                std::process::exit(0);
            }

            // ---- macOS：她不该出现在程序坞 / Cmd-Tab 里 ----
            //
            // Windows 那边靠 `skip_taskbar(true)`，但**这一条在 macOS 上没有实现**：
            // tauri-runtime-wry 里 macOS 分支那个函数是空的（`fn skip_taskbar(self, _skip) { self }`），
            // tao 也只给 Windows/Linux 写了实现。mac 上要藏就得改**激活策略**：
            // Accessory = 不出现在程序坞、不进 Cmd-Tab，但仍然能有窗口与托盘图标。
            // 建窗之前设，免得先闪一下 Dock 图标。
            #[cfg(target_os = "macos")]
            {
                match handle.set_activation_policy(tauri::ActivationPolicy::Accessory) {
                    Ok(()) => say("[shell] 激活策略：Accessory（不进程序坞）".to_string()),
                    Err(error) => say(format!("[shell] 设置激活策略失败：{error}")),
                }
            }

            let runtime = resolve_runtime_dir(&handle);
            let pets_root = resolve_pets_root();
            say(format!(
                "[shell] 起手：{}（pid {}，{}）",
                std::env::current_exe()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| "(拿不到 exe 路径)".to_string()),
                std::process::id(),
                if launched_by_plugin() { "插件拉起" } else { "手动启动" }
            ));
            say(format!("[shell] 运行期目录：{}", runtime.display()));
            say(format!("[shell] DSH_HOME：{}", home.display()));

            // ---- 手动启动 + 偏好是「页面内」⇒ 按"用户要她在桌面上"处理 ----
            //
            // 否则她会读到 inline、1 秒内自己让位，用户看到的是"双击了，什么都没发生"
            // （2026-09 用户报的正是这个）。规则本身不动，只改这一次的意图；写的是同一个
            // 共享文件，页面里那只立刻让位 —— 仍然只有一只。详见
            // `host::display::manual_launch_overrides_inline`。
            let mode = host::display::normalise_mode(host::display::read_preference(&home).get("mode"));
            // `--dsh inline` 是驱动专用的"命令行指定模式"，那种情况下不许改写（见那个函数）。
            let mode_forced = parse_arg("--dsh").map(|value| value == "inline").unwrap_or(false);
            if host::display::manual_launch_overrides_inline(&mode, launched_by_plugin(), mode_forced) {
                let _ = host::display::write_preference(&home, serde_json::json!({ "mode": "desktop" }));
                say("[shell] 偏好原是「页面内」，这次是手动启动 —— 已切成「桌面」：她留在桌面上（DSH 设置里可改回）".to_string());
            } else {
                say(format!("[shell] 显示层偏好：mode={mode}"));
            }

            match &attach {
                Some(upstream) => say(format!("[shell] **挂载模式**：宠物数据与相位都来自 {upstream}")),
                None => say(format!("[shell] 独立模式：宠物目录 {}", pets_root.display())),
            }

            // 随包宠物只在独立模式下解包：挂载时宠物由 DSH 那边的插件负责，本机碰它
            // 没有意义（也不该在挂载时去写用户的宠物目录）。
            let plugin_root = runtime.join("plugin");
            if attach.is_none() && !host::embed::plugin_extracted(&plugin_root) {
                std::fs::create_dir_all(&plugin_root)?;
                match host::catalog::materialize_bundled_pets(&plugin_root) {
                    Ok(count) => say(format!(
                        "[shell] 已解包随包宠物：{count} 个文件 → {}",
                        plugin_root.display()
                    )),
                    Err(error) => say(format!("[shell] 解包随包宠物失败：{error}")),
                }
            }
            let (files, bytes) = host::embed::totals();
            say(format!(
                "[shell] 内嵌资源：{files} 个文件（{:.2} MB）",
                bytes as f64 / 1024.0 / 1024.0
            ));

            let host = host::serve(shared.clone(), pets_root, plugin_root, attach.clone(), home.clone())?;
            say(format!("[shell] 宿主已就绪：{}", host.url));
            // 每一步都**带上自己的上下文**：setup 里任何一步失败，Tauri 只会把它包成
            // "Failed to setup app: ... <错误本身>"，而裸的 io 错误（比如 `拒绝访问。
            // (os error 5)`）根本不说是哪一步 —— 这一轮为了定位它绕了很久。
            //
            // **建窗失败要重试**：`0x800700AA 请求的资源在使用中` 多半是上一只刚退、
            // WebView2 的 user-data-dir 还没放开（任务管理器里强杀、或插件收进程时留下的
            // 子进程都会这样）。等一会儿通常就好了，没必要让用户看一个报错框。
            let mut attempt = 0u32;
            loop {
                attempt += 1;
                // 上一次尝试可能留下半个窗口，先清掉再试（否则会撞"窗口已存在"）。
                if let Some(existing) = app.get_webview_window(pet_window::PET_WINDOW) {
                    let _ = existing.destroy();
                }
                match pet_window::create_pet_window(&handle, &host::page_url(&host)) {
                    Ok(()) => break,
                    Err(error) if attempt < 4 => {
                        say(format!(
                            "[shell] 建窗失败（第 {attempt} 次，1.5 秒后重试）：{error}"
                        ));
                        std::thread::sleep(Duration::from_millis(1500));
                    }
                    Err(error) => {
                        return Err(std::io::Error::other(format!("建桌宠窗口失败：{error}")).into());
                    }
                }
            }
            tray::setup(app, &home).map_err(|error| std::io::Error::other(format!("建托盘失败：{error}")))?;
            spawn_hover_loop(handle.clone(), shared.clone());

            // ---- 显示层：桌面端要不要显示、以及"我还活着"的心跳 ----
            //
            // 用户在 DSH 设置里选了「页面内」时，这个窗口必须让位（否则桌面上和页面里各
            // 一只）。判定读的是两端共用的偏好文件，规则在 `host::display` 里，有单元测试。
            host::display::publish_heartbeat(&home).map_err(|error| {
                std::io::Error::other(format!(
                    "写显示层心跳失败（{}）：{error}",
                    home.join("pet-desktop.json").display()
                ))
            })?;
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

#[cfg(test)]
mod tests {
    use super::pointer_local_with;

    /// 这是整条"穿透判定"链上唯一一段能在本机（Windows）对**两个平台**都验的代码 ——
    /// 所以 `logical` 才做成参数：macOS 那一支否则要等到 CI 才有第一次编译机会。
    ///
    /// Windows：光标与窗口原点都是物理像素，相减再除缩放就是窗口本地 CSS 像素。
    #[test]
    fn pointer_local_windows_口径() {
        // 100%：本地坐标 = 相减。
        assert_eq!(
            pointer_local_with((300.0, 200.0), (100.0, 50.0), 1.0, false),
            (200.0, 150.0)
        );
        // 200%：窗口原点 (1000, 500) 物理 = 本地 (0, 0)；光标 (1200, 700) → 本地 (100, 100)。
        assert_eq!(
            pointer_local_with((1200.0, 700.0), (1000.0, 500.0), 2.0, false),
            (100.0, 100.0)
        );
    }

    /// macOS：光标是**逻辑点**（CGEvent），窗口原点是**物理像素**（tao 乘过缩放）。
    #[test]
    fn pointer_local_macos_逻辑点() {
        // 200% 缩放、窗口原点 (1000, 500) 物理；光标逻辑点 (600, 350)
        // → 物理 (1200, 700) → 本地物理 (200, 200) → 除缩放 → (100, 100)。
        assert_eq!(
            pointer_local_with((600.0, 350.0), (1000.0, 500.0), 2.0, true),
            (100.0, 100.0)
        );
    }

    /// 1x 屏上两个平台必须**无法区分**：mac 的"逻辑点"就等于物理像素。
    #[test]
    fn pointer_local_一倍屏两平台一致() {
        let windows = pointer_local_with((660.0, 480.0), (100.0, 50.0), 1.0, false);
        let macos = pointer_local_with((660.0, 480.0), (100.0, 50.0), 1.0, true);
        assert_eq!(windows, macos);
        assert_eq!(windows, (560.0, 430.0));
    }

    /// 缩放拿到 0 / 负数（异常值）不能变成 NaN 或 Inf ——
    /// NaN 会让 "local < 窗口宽" 这条比较恒为 false，症状正是最难查的那种"她永远点不到"。
    #[test]
    fn pointer_local_缩放异常也要有限() {
        for bad in [0.0, -1.0] {
            let (x, y) = pointer_local_with((300.0, 200.0), (100.0, 50.0), bad, true);
            assert!(x.is_finite() && y.is_finite(), "缩放 {bad} 时算出了 {x},{y}");
        }
    }
}
