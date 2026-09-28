// 托盘图标与菜单。
//
// 桌宠没有任务栏按钮（`skip_taskbar`），所以托盘是**唯一**的常驻入口：显示/隐藏她、
// 归位、选屏幕、打开设置、退出。没有它，用户把宠物藏起来之后就再也找不到她了。
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
// 菜单项的状态（显示/隐藏哪个可用、当前选的是哪块屏）靠**重建整份菜单**来更新 ——
// 启动时建好就定住的话，用户在菜单里的选择永远反映不出来。
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::sync::{Arc, Mutex};

use tauri::{App, AppHandle, Manager};

use crate::host::shared::Shared;
use crate::pet_window;

/// 托盘图标的尺寸。**32×32 而不是把大图缩下去**：托盘那块地方只有 16×16 /
/// 20×20，点对点的小图才清晰（大图缩下来会发糊）。
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// 屏幕菜单项 id 的前缀：`screen:<序号>`。
const SCREEN_PREFIX: &str = "screen:";

pub fn setup(app: &App) -> tauri::Result<()> {
    let menu = build_menu(app.handle(), current_monitor_index(app.handle()))?;

    let icon = tauri::image::Image::from_bytes(TRAY_ICON)?;
    TrayIconBuilder::with_id("pet-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DSH 桌宠")
        .on_menu_event(|app: &AppHandle, event| {
            let id = event.id.as_ref();
            if let Some(index) = id.strip_prefix(SCREEN_PREFIX) {
                if let Ok(index) = index.parse::<usize>() {
                    if pet_window::place_on_monitor(app, index) {
                        // 换了屏 = 换了窗口尺寸：轮廓快照要重抓，位置也要归位到新屏右下角
                        // （留着旧坐标她会跑到屏幕外）。两件事都交给页面做。
                        push(app, "reset");
                        refresh(app);
                    }
                }
                return;
            }
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
                    // 页面的位置是它自己的状态（localStorage），壳硬挪窗口只会让"她"和判定
                    // 用的坐标错位 —— 所以让**页面**去清，壳只负责把命令递过去。
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
        .build(app)?;
    Ok(())
}

/// 建整份菜单（启动时一次、之后每次状态变化重建一次）。
fn build_menu(app: &AppHandle, current: usize) -> tauri::Result<Menu<tauri::Wry>> {
    let hidden = hidden_by_user(app);
    let show_item = MenuItem::with_id(app, "show", "显示桌宠", hidden, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "藏起来", !hidden, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset", "归位（右下角）", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let screen_menu = build_screen_submenu(app, current)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &show_item,
            &hide_item,
            &PredefinedMenuItem::separator(app)?,
            &reset_item,
            &screen_menu,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )
}

/// 「屏幕」子菜单：一块屏一项，标出分辨率与位置，当前那块打点。
///
/// 单项而不是"循环切换"：多屏的分辨率/相对位置各不相同，用户需要看到**自己选的是哪一块**。
fn build_screen_submenu(app: &AppHandle, current: usize) -> tauri::Result<Submenu<tauri::Wry>> {
    let monitors = app.available_monitors().unwrap_or_default();
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let size = monitor.size();
        let position = monitor.position();
        // 用全角空格占位，免得"● "与"　 "宽度不同导致文字错位。
        let label = format!(
            "{}{}  {}×{}  @{},{}",
            if index == current { "● " } else { "　 " },
            index + 1,
            size.width,
            size.height,
            position.x,
            position.y,
        );
        items.push(MenuItem::with_id(
            app,
            format!("{SCREEN_PREFIX}{index}"),
            label,
            true,
            None::<&str>,
        )?);
    }
    if items.is_empty() {
        items.push(MenuItem::with_id(
            app,
            SCREEN_PREFIX.to_string() + "0",
            "（没检测到屏幕）",
            false,
            None::<&str>,
        )?);
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    Submenu::with_id_and_items(app, "pet-screen-menu", "屏幕", true, &refs)
}

/// 重建一份菜单塞回托盘（选中项、显示/隐藏的可用状态都会跟着更新）。
///
/// `pub(crate)`：显示循环在窗口显隐变化时也要叫它一次（否则菜单上"显示/藏起来"的
/// 可用状态会停在旧值上）。
pub(crate) fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("pet-tray") else {
        return;
    };
    match build_menu(app, current_monitor_index(app)) {
        Ok(menu) => {
            if let Err(error) = tray.set_menu(Some(menu)) {
                eprintln!("[tray] 重建菜单失败：{error}");
            }
        }
        Err(error) => eprintln!("[tray] 建菜单失败：{error}"),
    }
}

/// 她当前在哪块屏（按**窗口位置**判，不是光标 —— 她是固定位置的）。
fn current_monitor_index(app: &AppHandle) -> usize {
    let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) else {
        return 0;
    };
    let Ok(position) = window.outer_position() else {
        return 0;
    };
    // `monitor_index_at` 收窄在具体运行时上，泛型的 `AppHandle<R>` 得先转成它。
    pet_window::monitor_index_at(app, position.x, position.y)
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
