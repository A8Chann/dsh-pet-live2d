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
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition};

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

/// 一个**开关**在不在（`--from-plugin` 这种没有值的参数）。
///
/// ⚠️ 别拿 [`parse_arg`] 判开关：它读的是**下一个参数**，而 `--from-plugin` 在插件那边
/// 恰恰是**最后一个**参数（`['--attach', url, '--from-plugin']`）⇒ `parse_arg` 返回 `None`
/// ⇒ 插件拉起的那一只被当成"手动启动"。症状很隐蔽：日志里那句"手动启动"就是它，
/// 而更实质的后果是「页面内」偏好会被**改写**（见 `launched_by_plugin` 的用途）。
///
/// 三种写法都认：`--from-plugin`（末尾）→ `Some("")`；`--from-plugin=false` → `Some("false")`；
/// `--from-plugin --attach …`（后面还有别的参数）→ `Some("")`（下一个以 `--` 开头，当没值）。
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    // `--flag=value` 那种写法先认（插件那边可能按开关传值）。
    let with_equals = format!("{flag}=");
    if let Some(argument) = args.iter().find(|argument| argument.starts_with(&with_equals)) {
        return Some(argument[with_equals.len()..].to_string());
    }
    let at = args.iter().position(|arg| arg == flag)?;
    match args.get(at + 1) {
        Some(value) if !value.starts_with("--") => Some(value.clone()),
        _ => Some(String::new()),
    }
}

/// 这一份是不是**插件拉起的**（`--from-plugin` / `PET_DESKTOP_FROM_PLUGIN`）。
///
/// 用途只有一个：区分"用户手动启动"与"插件按设置拉起" —— 前者遇到「页面内」偏好要改写成
/// 「桌面」，后者要严格尊重用户的选择。见 `host::display::manual_launch_overrides_inline`。
fn launched_by_plugin() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if let Some(value) = flag_value(&args, "--from-plugin") {
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

/// [`pointer_local_with`] 的**逆运算**：知道"指针该落在窗口里的哪个点"，反推窗口原点。
///
/// 拖动窗口时唯一要维持的量就是这个点：每一拍拿当前光标反推窗口该摆在哪儿，指针于是
/// 始终压在她身上原来那个位置 —— 她跟着手走。**跨屏不需要任何额外逻辑**：窗口只是
/// 一个矩形，没有"第几块屏"这回事（这正是替掉托盘「屏幕」子菜单的那一步）。
pub(crate) fn window_origin_for_local_with(
    cursor: (f64, f64),
    local: (f64, f64),
    scale: f64,
    logical: bool,
) -> (f64, f64) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let k = if logical { scale } else { 1.0 };
    (cursor.0 * k - local.0 * scale, cursor.1 * k - local.1 * scale)
}

/// 本平台口径下的 [`window_origin_for_local_with`]。
pub(crate) fn window_origin_for_local(
    cursor: (f64, f64),
    local: (f64, f64),
    scale: f64,
) -> (f64, f64) {
    window_origin_for_local_with(cursor, local, scale, CURSOR_IS_LOGICAL)
}

/// 鼠标左键现在按着没有（拖动收尾的兜底：页面的 `pointerup` 可能永远到不了）。
///
/// Windows 用 `GetAsyncKeyState` —— 它问的是**键盘/鼠标的物理状态**，与谁有焦点、
/// 窗口吃不吃事件都无关（穿透场景里正好需要这个性质）。
#[cfg(windows)]
pub(crate) fn left_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

/// macOS 用 CoreGraphics 的按键状态（同样与焦点无关）。
///
/// `kCGEventSourceStateCombinedSessionState = 0`、`kCGMouseButtonLeft = 0`。
/// 不引 objc2：C 的 `_Bool` 与 Rust 的 `bool` 都是 1 字节，签名对得上。
#[cfg(target_os = "macos")]
pub(crate) fn left_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    unsafe { CGEventSourceButtonState(0, 0) }
}

/// 其它平台读不到按键：只能靠页面松手的那条消息收尾。
///
/// 返回 `true` 而不是 `false`：`false` 会被当成"用户已经松手"，拖动一启动就结束 ——
/// 宁可让 `DRAG_MAX` 兜底，也不要在读不到的平台上把拖动做成一次性的。
#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn left_button_down() -> bool {
    true
}

/// 拖动的轮询周期。
///
/// 8ms ≈ 125 次/秒：比一帧（16.7ms）密，比高刷鼠标事件（最高 1000Hz）稀 —— 再稀一点
/// 就能看出"窗口一格一格追着指针"。每拍只做三件事：读光标、读窗口位置、必要时挪一下。
const DRAG_POLL_MS: u64 = 8;

/// 一次拖动最多持续这么久（页面没发松手 + 按键状态也读不到时的兜底）。
///
/// 没有它的话，任何"松手没被观察到"的情形都会变成**窗口永远跟着鼠标跑** —— 那正是
/// 用户最讨厌的失控方式。到点就当她已经放下。
const DRAG_MAX: Duration = Duration::from_secs(120);

/// 拖动循环：页面说"按住她了"之后，把窗口挪到"指针相对窗口的位置保持不变"。
///
/// 为什么由壳来挪、而不是页面在 `pointermove` 里发窗口坐标：
///
///   * `pointermove` 只有在指针**落在窗口内**时才来。窗口一旦被甩在后面，事件就断了 ——
///     壳自己轮询光标没有这个死角（这也是它一直在做的事，见 `spawn_hover_loop`）；
///   * 页面发的屏幕坐标要先换算成物理像素，而"缩放"在跨屏时是会变的；壳手里两样都是
///     原生量，不需要换算。
///
/// 落点（`local`）是页面给的 `clientX/clientY`，单位正好是窗口本地 CSS 像素 —— 于是
/// "按下 → 发请求"那几毫秒里手已经挪开的距离不会被算成抓取偏移（否则拖动一开始她会跳）。
fn spawn_drag_loop(app: AppHandle, shared: Arc<Mutex<Shared>>, home: std::path::PathBuf) {
    std::thread::spawn(move || {
        let mut anchor: Option<((f64, f64), Instant)> = None;
        // 这一轮拖动有没有**真的**挪过窗口。
        //
        // 为什么要它：按下点一下也算"一次拖动"（页面每次 pointerdown 都会报落点），而
        // 收尾要写位置存档 —— 不判这一下，用户每摸一次她都会写一次盘。
        let mut moved = false;
        // 这一次拖动里**见过按键按下**没有。
        //
        // 只在"见过按下、现在松了"时才收尾。因为读按键的那两个平台 API 一旦不可用
        // （macOS 缺少输入权限之类）会恒返回 false —— 不判这一下，拖动会在第一拍就
        // 结束（症状是"拖不动"）。这样退化之后仍然是：页面发松手 / `DRAG_MAX` 收尾。
        let mut saw_down = false;
        loop {
            std::thread::sleep(Duration::from_millis(DRAG_POLL_MS));
            let request = {
                let guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.drag_request
            };
            // 页面的"按住"进来了：记下抓取点，这一拍就开始跟。
            if let (Some(point), None) = (request, anchor) {
                anchor = Some((point, Instant::now()));
                moved = false;
                saw_down = false;
                let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.dragging = true;
            }
            let Some((point, started)) = anchor else {
                continue;
            };
            let down = left_button_down();
            saw_down = saw_down || down;
            // 三种收尾：页面松手了 / 按键确实按下过、现在松了 / 拖太久了。
            if request.is_none() || (saw_down && !down) || started.elapsed() > DRAG_MAX {
                finish_drag(&app, &shared, &home, moved);
                anchor = None;
                continue;
            }
            if follow_cursor(&app, point) {
                moved = true;
            }
        }
    });
}

/// 把窗口挪到"指针还压在 `local` 这个点上"的地方。返回**这一拍真的挪了没有**。
fn follow_cursor(app: &AppHandle, local: (f64, f64)) -> bool {
    let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) else {
        return false;
    };
    let Some((cursor_x, cursor_y)) = cursor_screen_pos() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let (target_x, target_y) = window_origin_for_local((cursor_x, cursor_y), local, scale);
    let Ok(current) = window.outer_position() else {
        return false;
    };
    let (x, y) = (target_x.round() as i32, target_y.round() as i32);
    // 只在真的变了才调：`set_position` 每次都惊动窗口管理器，静止时别白叫。
    if x == current.x && y == current.y {
        return false;
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
    true
}

/// 拖动收尾：清状态；**真的挪过**才写位置存档（点一下不该写盘）。
fn finish_drag(app: &AppHandle, shared: &Arc<Mutex<Shared>>, home: &std::path::Path, moved: bool) {
    {
        let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.dragging = false;
        // 请求也要清：页面的松手消息可能晚到几毫秒，留着它下一拍会**重新拖起来**。
        guard.drag_request = None;
    }
    if moved {
        pet_window::remember_position(app, home);
    }
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
    // 页面报来的界面语言（见 `/__desktop/locale`）：变了就重建托盘。起手记 0 = "还没报过"。
    let mut locale_rev = 0u64;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        // 心跳：只要进程活着就一直刷（哪怕窗口是藏着的）—— 藏起来不等于退出，
        // 用户可能只是想暂时看页面里那只。
        if host::display::publish_heartbeat(&home).is_err() {
            continue;
        }
        // 界面语言：页面加载后报一次，壳自己的托盘菜单按它换文案。
        //
        // 为什么放在这个 1 秒循环里：语言不影响任何时序（托盘晚一秒变英文没人看得出来），
        // 而这里已经拿着 `AppHandle`，`tray::refresh` 直接调。
        let (next_locale, next_rev) = {
            let guard = shared.lock().unwrap_or_else(|p| p.into_inner());
            (guard.ui_locale.clone(), guard.ui_locale_rev)
        };
        if next_rev != locale_rev {
            locale_rev = next_rev;
            crate::tray::refresh(&app);
            let _ = logbook::log(&home, &format!("[shell] 托盘语言：{next_locale}"));
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
            let home = resolve_home();

            // ---- 托盘：**放在 setup 的第一件事**（实验） ----
            //
            // 参照物是同机上一个能正常出托盘的 Tauri 应用（DSH Desktop）：代码几乎一样，
            // 唯一实质差别是它建托盘时进程里的"前置动作"少得多。用户 2026-09 报"托盘里没有她"
            // 时实测：本程序手工调 `Shell_NotifyIcon` 也被拒（`GetLastError=5` ACCESS_DENIED），
            // 而一个无关的最小程序能注册成功 ⇒ 想确认锅是不是"我们 setup 里的前置动作"。
            // 这一段只是**定位实验**：先在最前面建托盘，看它能不能注册上。
            tray::setup(app, &home).map_err(|error| {
                std::io::Error::other(format!("建托盘失败：{error}"))
            })?;

            // `say` 同时打 stderr 与日志文件 —— 开发时照旧看终端，用户双击时只看得到文件。
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

            // （托盘的定位实验：现在它在 setup 的第一件事里建，见上面的注释。）
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
                match pet_window::create_pet_window(&handle, &host::page_url(&host), &home) {
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
            // 托盘已经在前面建好了（那次挪动是实验的一部分，见上面的注释）。
            spawn_hover_loop(handle.clone(), shared.clone());
            // ---- 拖宠物 = 挪窗口（多屏就靠这一条）----
            //
            // 窗口只有一块屏那么大，位置一旦相对窗口存，她就永远跨不出这块屏
            // （issue #11 的"连多屏后无法拖到别的屏幕"）。改成挪窗口之后，屏幕坐标
            // 说了算，多屏 / 异形排布 / 负原点 / 换分辨率全都自动成立。
            spawn_drag_loop(handle.clone(), shared.clone(), home.clone());

            // ---- macOS：她得在**所有桌面空间**上都看得见 ----
            //
            // macOS 的窗口默认归属创建时那个 Space，切一次桌面她就不见了（issue #11
            // 前半段："切换桌面后消失"）。`CanJoinAllSpaces` 才是那个开关 —— 在
            // Windows 上它没有对应物（那边每个虚拟桌面本来就是同一批窗口）。
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) {
                match window.set_visible_on_all_workspaces(true) {
                    Ok(()) => say("[shell] 窗口在所有桌面空间可见（切 Space 不会消失）".to_string()),
                    Err(error) => say(format!("[shell] 设置「所有空间可见」失败：{error}")),
                }
            }
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
                // 她最后待在哪，下次就在哪 —— 拖动结束时已经记过一次，这里再记一次是为了
                // "没拖过、但窗口被别的东西挪了"这类情况（归位之后立刻退出也走这里）。
                pet_window::remember_position(_app, &home);
                host::display::clear_heartbeat(&home);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{flag_value, pointer_local_with, window_origin_for_local_with};

    /// `--from-plugin` 在插件那边是**最后一个**参数 —— 这一条就是为此钉的。
    ///
    /// 用的正是 2026-11 那次"桌面起不来"现场里抓到的命令行：
    /// `… --attach http://127.0.0.1:3080 --from-plugin`。
    #[test]
    fn from_plugin_flag_is_recognised_at_the_end_of_the_command_line() {
        let argv = |args: &[&str]| args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();

        let actual = argv(&["pet.exe", "--attach", "http://127.0.0.1:3080", "--from-plugin"]);
        assert_eq!(flag_value(&actual, "--from-plugin"), Some(String::new()), "末尾那个开关必须认出来");

        // 后面还有别的参数（下一个以 `--` 开头 ⇒ 当它没有值）
        let actual = argv(&["pet.exe", "--from-plugin", "--attach", "http://127.0.0.1:3080"]);
        assert_eq!(flag_value(&actual, "--from-plugin"), Some(String::new()));

        // 显式给值
        assert_eq!(
            flag_value(&argv(&["pet.exe", "--from-plugin=false"]), "--from-plugin"),
            Some("false".to_string())
        );
        // 没有这个开关
        assert_eq!(flag_value(&argv(&["pet.exe", "--attach", "x"]), "--from-plugin"), None);
    }

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

    /// 拖动用的那条公式必须是 `pointer_local` 的**逆** —— 两个平台、几种缩放都成立。
    ///
    /// 这就是"拖宠物 = 挪窗口"的全部数学：知道指针该压在窗口里的哪一点，反推窗口原点。
    #[test]
    fn window_origin_反推回同一个原点() {
        for logical in [false, true] {
            for scale in [1.0, 1.25, 1.5, 2.0] {
                for origin in [(0.0, 0.0), (100.0, 50.0), (-2560.0, -200.0), (3440.0, 0.0)] {
                    for cursor in [(660.0, 480.0), (1200.0, 700.0), (-300.0, 90.0)] {
                        let local = pointer_local_with(cursor, origin, scale, logical);
                        let back = window_origin_for_local_with(cursor, local, scale, logical);
                        assert!(
                            (back.0 - origin.0).abs() < 1e-9 && (back.1 - origin.1).abs() < 1e-9,
                            "logical={logical} scale={scale} origin={origin:?} cursor={cursor:?} \
                             → local={local:?} → {back:?}"
                        );
                    }
                }
            }
        }
    }

    /// 拖动时"指针在窗口里的那个点"要保持不变：光标走多远，窗口就走多远。
    #[test]
    fn window_origin_跟着光标走同样的距离() {
        // Windows 口径（物理像素、缩放无关）：抓在 (200,150)，光标从 (300,200) 移到 (500,260)
        let start = window_origin_for_local_with((300.0, 200.0), (200.0, 150.0), 1.0, false);
        let moved = window_origin_for_local_with((500.0, 260.0), (200.0, 150.0), 1.0, false);
        assert_eq!((moved.0 - start.0, moved.1 - start.1), (200.0, 60.0));
        // macOS 口径（光标是逻辑点、窗口原点是物理像素、2 倍屏）：屏幕上的位移也要 ×2
        let start = window_origin_for_local_with((150.0, 100.0), (50.0, 25.0), 2.0, true);
        let moved = window_origin_for_local_with((250.0, 130.0), (50.0, 25.0), 2.0, true);
        assert_eq!((moved.0 - start.0, moved.1 - start.1), (200.0, 60.0));
    }
}
