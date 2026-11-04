// 托盘图标与菜单。
//
// 桌宠没有任务栏按钮（`skip_taskbar`），所以托盘是**唯一**的常驻入口：显示/隐藏她、
// 归位、打开设置、退出。没有它，用户把宠物藏起来之后就再也找不到她了。
//
// **这里没有「屏幕」子菜单了**：拖她就能换屏（拖宠物 = 挪窗口，见 `lib.rs` 的
// `spawn_drag_loop`）。原来那一列"第几块屏 2560×1440 @-2560,0"是在用菜单代替拖动 ——
// 用户的原话是"不要这种选择屏幕的，直接能在多屏直接拖动"。
//
// 两条硬纪律（都是踩出来的）：
//
//   1. **给页面的动作走 HTTP 命令队列，不要用 `window.emit()`。**
//      Tauri 的 `emit` 不发 DOM 事件、只走 IPC，而外部页面没有 `window.__TAURI__`
//      （`withGlobalTauri: false`）—— 页面里 `addEventListener("pet://settings")` 永远
//      收不到。症状是菜单项"点了没效果"（"设置""归位"两项就这么静默失效过）。
//   2. **"藏起来"要记成用户意图，不能只 hide 窗口。** 显示循环按显示层规则每帧决定显隐，
//      不记住意图的话，她过一会儿又自己冒出来（用户报的 bug）。
//
// 菜单项的状态（显示/隐藏哪个可用）靠**重建整份菜单**来更新 —— 启动时建好就定住的话，
// 用户在菜单里的选择永远反映不出来。
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::sync::{Arc, Mutex};

use tauri::{App, AppHandle, Manager};

use crate::host::shared::Shared;
use crate::logbook;
use crate::pet_window;

/// 托盘图标的尺寸。**32×32 而不是把大图缩下去**：托盘那块地方只有 16×16 /
/// 20×20，点对点的小图才清晰（大图缩下来会发糊）。
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// 建托盘图标。**注册完会自证一次**，并在这个过程中留下可查的日志。
///
/// 为什么要自证：`TrayIconBuilder::build()` 返回 Ok **不代表图标真的进了通知区域**。
/// `tray-icon` 在 `Shell_NotifyIcon(NIM_ADD)` 失败时是**静默忽略**的（源码里那句注释写着
/// "等 Explorer 发 TaskbarCreated 再重注册"，而那个广播**只有资源管理器重启时才有**）——
/// 于是注册失败一次就等于**永远没有图标**，还没有任何错误冒出来。
/// 用户 2026-09 报的"托盘里也没有她"就是撞在这里：进程、窗口、宠物全正常，
/// 注册表里没有条目、溢出区里也没有，`build()` 却是 Ok。
///
/// 判据用 `TrayIcon::rect()`（Windows 上就是 `Shell_NotifyIconGetRect`）：
/// **系统知道图标画在哪 = 真的注册上了**。
///
/// ⚠️ 但 `rect()` 拿不到**不等于**失败：**藏在溢出区里的图标也拿不到矩形**
/// （实测过：同一个图标在溢出区里 `rect()` 失败，而它明明在）。所以这里**不重试、不重建**
/// —— 只如实记一条日志，再跑一遍 [`diagnose_native_tray`] 把机制问清楚。
pub fn setup(app: &App, home: &std::path::Path) -> tauri::Result<()> {
    let menu = build_menu(app.handle())?;
    let icon = tauri::image::Image::from_bytes(TRAY_ICON)?;
    let built = TrayIconBuilder::with_id("pet-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DSH 桌宠")
        .on_menu_event(|app: &AppHandle, event| {
            let id = event.id.as_ref();
            match id {
                "show" => {
                    set_hidden_by_user(app, false);
                    pet_window::show_pet(app);
                    refresh(app);
                }
                "hide" => {
                    // **记下"是用户藏的"**：显示循环按显示层规则决定显隐，不记住意图
                    // 她过一会儿又自己出来。
                    set_hidden_by_user(app, true);
                    pet_window::hide_pet(app);
                    refresh(app);
                }
                "reset" => {
                    // **壳负责窗口、"她"负责页面**：窗口先回到光标所在那块屏的工作区，
                    // 再让页面把位置与大小也归位（`pet://reset`）。
                    //
                    // 为什么壳要动窗口：拖动之后窗口是漂着的（拖宠物 = 挪窗口），归位
                    // 就得把它重新对齐到一块屏上 —— 否则"归位"只把她挪到那个漂着的窗口
                    // 角落，用户看到的仍然是"没回来"。
                    //
                    // 这里**不立刻**写位置存档：`set_position` 是投递给事件循环的，
                    // 紧接着读 `outer_position` 拿到的可能还是旧值。退出时会再记一次。
                    pet_window::place_on_monitor(app, pet_window::monitor_index_at_cursor(app));
                    set_hidden_by_user(app, false);
                    pet_window::show_pet(app);
                    push(app, "reset");
                    refresh(app);
                }
                "settings" => {
                    set_hidden_by_user(app, false);
                    pet_window::show_pet(app);
                    push(app, "settings");
                    refresh(app);
                }
                "quit" => quit(app),
                _ => {}
            }
        })
        // 左键单击 / 双击：显示她（托盘最常用的那个动作不该要点两次菜单）。
        .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event| {
            let activated = matches!(
                event,
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }
                    | TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
            );
            if activated {
                set_hidden_by_user(tray.app_handle(), false);
                pet_window::show_pet(tray.app_handle());
                refresh(tray.app_handle());
            }
        })
        .build(app);

    match built {
        Ok(tray) => match tray.rect() {
            Ok(Some(_)) => {
                let _ = logbook::log(home, "[shell] 托盘图标已就绪（注册已确认）");
            }
            other => {
                let _ = logbook::log(
                    home,
                    &format!(
                        "[shell] 托盘图标注册了，但系统没给出它的位置（{other:?}）—— \
                         多半是 Win11 把它收进了溢出区（点任务栏的 ^ 看）"
                    ),
                );
                #[cfg(windows)]
                diagnose_native_tray(app, home);
            }
        },
        Err(error) => {
            // 建不起来（拿不到图标 / 菜单失败）：**不让整个应用起不来**，但要说清楚。
            let _ = logbook::log(
                home,
                &format!("[shell] 托盘图标创建失败：{error} —— 她照常工作，只是没有托盘菜单"),
            );
            #[cfg(windows)]
            diagnose_native_tray(app, home);
        }
    }
    Ok(())
}

/// **诊断用**：绕开 `tray-icon`，在这个进程里手工调 `Shell_NotifyIcon(NIM_ADD)`。
///
/// 为什么要它：用户 2026-09 遇到的"托盘里没有她"，实测**同一台机器上**：
///
///   * 一个与本程序无关的最小探针（PowerShell + WinForms 窗口 + 手工 `Shell_NotifyIcon`）
///     **成功**（`NIM_ADD=True`、`GetRect` 拿到矩形、溢出区里出现它）；
///   * 而**任何 Tauri 程序**（2.11 与 2.12 两代、有无窗口、建在最前还是最后）都失败，
///     `GetLastError = 5`（ACCESS_DENIED）。
///
/// 参数、窗口样式（LAYERED / TRANSPARENT / NOACTIVATE / TOOLWINDOW）、DPI 感知、
/// 依赖版本、exe 位置、完整性标签**都已排除**（探针里逐个试过，全部成功）。
///
/// 所以这里问的是最后一个能决定"我们能不能自己修"的问题：**在 Tauri 进程里新造一个
/// 最普通的窗口，能不能注册？**
///
///   * 能 ⇒ 我们可以在应用内部自己做兜底注册（自建窗口 + 自己的菜单）；
///   * 不能 ⇒ 只能等上游（`tray-icon` / `tao`）或系统侧修。
#[cfg(windows)]
fn diagnose_native_tray(app: &App, home: &std::path::Path) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WS_OVERLAPPED};

    // 一、宠物窗口（带 LAYERED / NOACTIVATE / TOOLWINDOW，与 tray-icon 自己那个隐藏窗口同类）。
    if let Some(window) = app.get_webview_window(crate::pet_window::PET_WINDOW) {
        if let Ok(handle) = window.hwnd() {
            try_register(home, handle.0 as HWND, "宠物窗口");
        }
    }

    // 二、**自己造一个最普通的窗口**：`STATIC` 是系统预注册的类，不需要 RegisterClassW，
    //     也不需要 hInstance。两次唯一差别就是窗口本身。
    let plain = unsafe {
        CreateWindowExW(
            0,
            windows_sys::w!("STATIC"),
            windows_sys::w!("pet-tray-diag"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if plain.is_null() {
        let _ = logbook::log(home, "[dial] 自建普通窗口失败（CreateWindowExW 返回空），跳过");
        return;
    }
    try_register(home, plain, "自建普通窗口");
}

/// 用给定窗口手工注册一个托盘图标，把结果与 `GetLastError` 写进日志；
/// 成功就立刻删掉（诊断用，不在用户托盘里留第二个图标）。
#[cfg(windows)]
fn try_register(home: &std::path::Path, hwnd: windows_sys::Win32::Foundation::HWND, label: &str) {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::LoadIconW;

    // IDI_APPLICATION = 32512：系统自带图标，不需要额外资源。
    let hicon = unsafe { LoadIconW(std::ptr::null_mut(), 32512usize as *const u16) };
    if hicon.is_null() {
        let _ = logbook::log(home, &format!("[dial] （{label}）连系统图标都取不到，跳过"));
        return;
    }
    let mut tip = [0u16; 128];
    for (index, unit) in "DSH 桌宠（诊断）".encode_utf16().take(127).enumerate() {
        tip[index] = unit;
    }
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 0x4453,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: 0x0400 + 1234,
        hIcon: hicon,
        szTip: tip,
        ..unsafe { std::mem::zeroed() }
    };

    let added = unsafe { Shell_NotifyIconW(NIM_ADD, &mut nid) } != 0;
    let error = unsafe { GetLastError() };
    let _ = logbook::log(
        home,
        &format!("[dial] 手工 NIM_ADD（{label}）= {added}（GetLastError={error}）"),
    );
    if added {
        let removed = unsafe { Shell_NotifyIconW(NIM_DELETE, &mut nid) } != 0;
        let _ = logbook::log(home, &format!("[dial] （{label}）成功，诊断图标已清理：{removed}"));
    }
}

/// 建整份菜单（启动时一次、之后每次状态变化重建一次）。
///
/// **没有「屏幕」子菜单**：换屏靠拖（见 `lib.rs` 的 `spawn_drag_loop`）。一块屏一项的
/// 列表是在用菜单代替拖动，用户明确说不要。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let hidden = hidden_by_user(app);
    let show_item = MenuItem::with_id(app, "show", "显示桌宠", hidden, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "藏起来", !hidden, None::<&str>)?;
    // 措辞跟着"拖动"改：她可以被拖到任意一块屏上，所以归位是"回到光标所在的这块屏"，
    // 而不是当年那个"哪块屏由菜单选"的说法。
    let reset_item = MenuItem::with_id(app, "reset", "归位（光标所在屏幕右下角）", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &show_item,
            &hide_item,
            &PredefinedMenuItem::separator(app)?,
            &reset_item,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )
}

/// 重建一份菜单塞回托盘（显示/隐藏的可用状态会跟着更新）。
///
/// `pub(crate)`：显示循环在窗口显隐变化时也要叫它一次（否则菜单上"显示/藏起来"的
/// 可用状态会停在旧值上）。
pub(crate) fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("pet-tray") else {
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                eprintln!("[tray] 重建菜单失败：{error}");
            }
        }
        Err(error) => eprintln!("[tray] 建菜单失败：{error}"),
    }
}

/// 共享状态：`manage` 进去的是 `Arc<Mutex<Shared>>`，所以这里取的就是它（不是 `Shared`）。
fn shared(app: &AppHandle) -> Option<tauri::State<'_, Arc<Mutex<Shared>>>> {
    app.try_state::<Arc<Mutex<Shared>>>()
}

fn push(app: &AppHandle, command: &str) {
    if let Some(state) = shared(app) {
        if let Ok(mut guard) = state.lock() {
            guard.push_command(command);
        }
    }
}

fn hidden_by_user(app: &AppHandle) -> bool {
    shared(app)
        .and_then(|state| state.lock().ok().map(|guard| guard.hidden_by_user))
        .unwrap_or(false)
}

fn set_hidden_by_user(app: &AppHandle, hidden: bool) {
    if let Some(state) = shared(app) {
        if let Ok(mut guard) = state.lock() {
            guard.hidden_by_user = hidden;
        }
    }
}

/// 退出。
///
/// 翻成同进程宿主之后**没有子进程要收尸了**（以前要先 taskkill 掉 Node sidecar 整棵
/// 进程树）。这正是这次架构替换白拿的好处之一：少一个能变成孤儿的进程。
fn quit(app: &AppHandle) {
    app.exit(0);
}
