// 桌面端外壳（Tauri）的入口库。
//
// 分工（M0 的核心结论）：
//
//   * **壳**只管窗口：透明、置顶、不进任务栏、以及"光标下面是桌面还是她"这一件事。
//   * **sidecar**（node 进程）管宠物：把插件宿主半区的真路由表挂在回环端口上，
//     `lib/index.js` 一行都没改。
//   * **页面**管渲染与判定：跑的就是 `lib/client.js`，不认 Tauri、也不认 DSH。
//
// 三方之间**没有 IPC**，只有两条 HTTP 与一个状态文件：
//
//     壳 --(POST /__desktop/probe)--> sidecar --> 页面判定 --> 壳据此切窗口忽略状态
//     壳 --(写 .run/shell-state.json)--> sidecar 读出来挂成 GET /__desktop/shell
//
// 为什么不用 Tauri 的 IPC：页面是从 loopback 上加载的，Tauri 对**远程源**默认拒绝自定义
// 命令（实测 `shell_state not allowed. Plugin not found`），要走通得开远程 IPC 权限——
// 那正好和我们想要的"发布版别留后门"相反。走文件既不需要权限，又让"换壳"这件事继续
// 成立：换 Electron 时页面和 sidecar 原样搬走，壳只要能发 HTTP、写一个 JSON 就行。
mod pet_window;
mod sidecar;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use sidecar::Sidecar;

/// 壳的运行状态：**唯一用途是给 driver 与排查看的读口**，不参与任何决策。
#[derive(Default)]
pub struct ShellState {
    pub sidecar_url: Option<String>,
    pub window_origin: Option<(f64, f64)>,
    pub window_size: Option<(u32, u32)>,
    pub scale: f64,
    pub cursor: Option<(i32, i32)>,
    pub local: Option<(i32, i32)>,
    pub interactive: bool,
    pub ignored: bool,
    pub active: bool,
    pub last_reason: String,
    pub probes: u64,
    pub changes: u64,
    pub probe_errors: u64,
    pub uptime_ms: u64,
    /// 只在进程内部用来算 `uptime_ms`，不落进状态文件。
    #[allow(dead_code)]
    pub started: Option<Instant>,
}

/// 把状态写到 sidecar 能读到的地方。
///
/// 手写 JSON 而不是引 serde 派生：字段就这么十几个、全是数字与字符串，省一个依赖。
/// 写完再原子替换（临时文件 + `fs::rename`），避免 sidecar 读到半截文件。
pub fn write_state(path: &std::path::Path, state: &ShellState) {
    let text = |value: &str| {
        let mut out = String::with_capacity(value.len() + 2);
        out.push('"');
        for ch in value.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    };
    let pair = |value: Option<(i32, i32)>| match value {
        Some((x, y)) => format!("[{x},{y}]"),
        None => "null".to_string(),
    };
    let pair_f = |value: Option<(f64, f64)>| match value {
        Some((x, y)) => format!("[{x},{y}]"),
        None => "null".to_string(),
    };
    let size = match state.window_size {
        Some((w, h)) => format!("[{w},{h}]"),
        None => "null".to_string(),
    };
    let body = format!(
        concat!(
            "{{\"sidecarUrl\":{},\"windowOrigin\":{},\"windowSize\":{},\"scale\":{},",
            "\"cursor\":{},\"cursorLocal\":{},\"interactive\":{},\"ignored\":{},",
            "\"active\":{},\"lastReason\":{},\"probes\":{},\"changes\":{},\"probeErrors\":{},",
            "\"uptimeMs\":{}}}"
        ),
        state.sidecar_url.as_deref().map_or("null".to_string(), text),
        pair_f(state.window_origin),
        size,
        if state.scale > 0.0 { state.scale } else { 1.0 },
        pair(state.cursor),
        pair(state.local),
        state.interactive,
        state.ignored,
        state.active,
        text(&state.last_reason),
        state.probes,
        state.changes,
        state.probe_errors,
        state.uptime_ms,
    );
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, body).is_ok() {
        let _ = std::fs::rename(&temp, path);
    }
}

/// 光标位置（屏幕物理像素）。非 Windows 上返回 None —— M0 只在 Windows 上验。
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

/// 穿透轮询：读数 → 问 sidecar（页面判定）→ 变化时切窗口的忽略状态 → 落一份状态给读口。
///
/// 为什么轮询而不是听事件：窗口一旦忽略光标事件，页面就收不到鼠标移动（Windows 把命中
/// 测试交给了下层窗口），所以"该不该忽略"这个判断本身成了鸡生蛋问题。绕开的办法只有
/// 一个：**自己问操作系统光标在哪**（`GetCursorPos`），这与窗口吃不吃事件无关。
fn spawn_hover_loop(app: AppHandle, state_path: std::path::PathBuf) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            let Some(window) = app.get_webview_window("pet") else {
                continue;
            };
            let base = {
                let state = app.state::<Mutex<ShellState>>();
                let locked = state.lock();
                match locked {
                    Ok(guard) => guard.sidecar_url.clone(),
                    Err(_) => None,
                }
            };
            let Some(base) = base else {
                continue;
            };
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
            let local_x = ((cx as f64 - ox) / scale).round();
            let local_y = ((cy as f64 - oy) / scale).round();

            let mut verdict = None;
            let mut error = None;
            let inside = local_x >= 0.0 && local_y >= 0.0 && local_x < w as f64 && local_y < h as f64;
            if inside {
                let body = serde_json::json!({
                    "x": local_x,
                    "y": local_y,
                    "screenX": cx,
                    "screenY": cy,
                    "scale": scale,
                });
                match ureq::post(&format!("{base}/__desktop/probe"))
                    .timeout(Duration::from_millis(400))
                    .send_json(body)
                {
                    Ok(response) => verdict = response.into_json::<serde_json::Value>().ok(),
                    Err(err) => error = Some(err.to_string()),
                }
            }
            let interactive = verdict
                .as_ref()
                .and_then(|v| v.get("interactive"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let reason = verdict
                .as_ref()
                .and_then(|v| v.get("reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // 桌面 → 忽略光标事件（点下去穿到下层窗口）；她 → 吃事件。
            let ignore = !interactive;
            let changed = last != Some(interactive);
            if changed {
                last = Some(interactive);
                let _ = window.set_ignore_cursor_events(ignore);
            }

            let snapshot = {
                let state = app.state::<Mutex<ShellState>>();
                let locked = state.lock();
                match locked {
                    Ok(mut s) => {
                        s.cursor = Some((cx, cy));
                        s.local = Some((local_x.round() as i32, local_y.round() as i32));
                        s.window_origin = Some((ox, oy));
                        s.window_size = Some((w, h));
                        s.scale = scale;
                        s.interactive = interactive;
                        s.ignored = ignore;
                        s.last_reason = reason;
                        s.probes += 1;
                        if error.is_some() {
                            s.probe_errors += 1;
                        }
                        if changed {
                            s.changes += 1;
                        }
                        s.uptime_ms = s.started.map_or(0, |t| t.elapsed().as_millis() as u64);
                        // 快照：写文件用的字段，与决策无关。
                        ShellState {
                            sidecar_url: s.sidecar_url.clone(),
                            window_origin: s.window_origin,
                            window_size: s.window_size,
                            scale: s.scale,
                            cursor: s.cursor,
                            local: s.local,
                            interactive: s.interactive,
                            ignored: s.ignored,
                            active: s.active,
                            last_reason: s.last_reason.clone(),
                            probes: s.probes,
                            changes: s.changes,
                            probe_errors: s.probe_errors,
                            uptime_ms: s.uptime_ms,
                            started: None,
                        }
                    }
                    Err(_) => continue,
                }
            };
            write_state(&state_path, &snapshot);
        }
    });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active = parse_active();
    tauri::Builder::default()
        .manage(Mutex::new(ShellState {
            started: Some(Instant::now()),
            active,
            ..Default::default()
        }))
        .setup(move |app| {
            let handle = app.handle().clone();
            let sidecar = Sidecar::launch()?;
            let url = sidecar.url.clone();
            let state_path = sidecar.state_path.clone();
            {
                let state = app.state::<Mutex<ShellState>>();
                let locked = state.lock();
                if let Ok(mut guard) = locked {
                    guard.sidecar_url = Some(url.clone());
                    guard.active = active;
                }
            }
            pet_window::create_pet_window(&handle, &url, sidecar)?;
            spawn_hover_loop(handle, state_path);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用初始化失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(sidecar) = app.try_state::<Mutex<Sidecar>>() {
                    if let Ok(mut guard) = sidecar.lock() {
                        guard.stop();
                    }
                }
            }
        });
}
