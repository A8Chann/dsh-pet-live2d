// 托盘图标与菜单。
//
// 桌宠没有任务栏按钮（`skip_taskbar`），所以托盘是**唯一**的常驻入口：显示/隐藏她、
// 归位、打开设置、退出。没有它，用户把宠物藏起来之后就再也找不到她了。
//
// 菜单项的文本会跟着状态变（比如她已经显示着，就把"显示"灰掉），这是纯桌面端的
// 习惯做法，也省得用户点了没反应。
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

use crate::pet_window;

/// 托盘图标的尺寸。**32×32 而不是把大图缩下去**：托盘那块地方只有 16×16 /
/// 20×20，点对点的小图才清晰（大图缩下来会发糊）。
const TRAY_ICON: &[u8] = include_bytes!("../icons/32x32.png");

pub fn setup(app: &App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示桌宠", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, "hide", "藏起来", true, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset", "归位（右下角）", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
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
    )?;

    let icon = tauri::image::Image::from_bytes(TRAY_ICON)?;
    TrayIconBuilder::with_id("pet-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DSH 桌宠")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => pet_window::show_pet(app),
            "hide" => pet_window::hide_pet(app),
            "reset" => reset_position(app),
            "settings" => open_settings(app),
            "quit" => quit(app),
            _ => {}
        })
        // 左键单击 / 双击：显示她（托盘最常用的那个动作不该要点两次菜单）。
        .on_tray_icon_event(|tray, event| {
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
                pet_window::show_pet(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// "归位"：让**页面**把位置清掉，而不是壳去猜。
///
/// 宠物在窗口里的位置是页面自己的状态（localStorage），壳硬挪窗口只会让"她"和"判定
/// 用的坐标"错位。所以这里给页面发一个窗口事件，由页面把存的 `right/bottom` 复原成
/// 默认值；她也顺手演一下"归位"的反应。
fn reset_position(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) {
        let _ = window.emit("pet://reset", ());
        let _ = window.show();
    }
}

/**
 * "设置…"：她自己的右键面板就是设置入口，这里只是替用户点开它。
 *
 * 桌面端没有 DSH 的设置页宿主（`ctx.slots` 那一节），所以插件的设置界面被接进了
 * **右键面板的第三个页签**（见 `sidecar/page/runtime.js` 与 `lib/client.js` 里 * `DESKTOP` 守卫那一段）。托盘这一项负责把它打开，省得用户先猜"设置在哪"。
 */
fn open_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(pet_window::PET_WINDOW) {
        let _ = window.emit("pet://settings", ());
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 退出。
///
/// 翻成同进程宿主之后**没有子进程要收尸了**（以前要先 taskkill 掉 Node sidecar 整棵
/// 进程树）。这正是这次架构替换白拿的好处之一：少一个能变成孤儿的进程。
fn quit<R: Runtime>(app: &AppHandle<R>) {
    app.exit(0);
}
