// 桌宠窗口。M0 用**全屏透明层**，理由不是偷懒：
//
//   * 右键面板宽 270px、锚在角色左侧，气泡悬在头顶 —— 一个 300×300 的小窗会把它们
//     裁掉。全屏层里布局与网页端完全一致，`lib/client.js` 一格都不用改。
//   * "只有剪影吃事件、透明处穿透"本来就要逐像素判定（网页端也是这么做的），
//     全屏层把这套判定原样搬到桌面上；点小窗的话反而多一层"窗口本身也是矩形"的问题。
//
// 代价是**穿透判定必须对**：判错了就是一层挡住整个桌面的透明玻璃。所以窗口初始就是
// "忽略光标事件"，由穿透轮询把它打开（见 lib.rs 的 spawn_hover_loop）——失败时默认
// 是"不挡桌面"，而不是"挡住桌面"。
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
use tauri::utils::config::Color;

use crate::sidecar::Sidecar;

pub const PET_WINDOW: &str = "pet";

pub fn create_pet_window(
    app: &AppHandle,
    url: &str,
    sidecar: Sidecar,
) -> Result<(), Box<dyn std::error::Error>> {
    // 工作区（不含任务栏）：宠物在任务栏底下就没法点了。
    let area = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| *monitor.work_area());

    let mut builder = WebviewWindowBuilder::new(app, PET_WINDOW, tauri::WebviewUrl::External(url.parse()?))
        .title("DSH 桌宠")
        .inner_size(800.0, 600.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .background_color(Color(0, 0, 0, 0));

    // 调试验证用：`PET_DESKTOP_CDP=8823 cargo run` 之后，驱动能从 8823 接管页面读判定。
    // 默认**不开**——发布版不该在本机留一个谁都能接管的调试端口。
    if let Ok(port) = std::env::var("PET_DESKTOP_CDP") {
        if !port.trim().is_empty() {
            builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}"));
        }
    }

    let window = builder.build()?;

    if let Some(area) = area {
        let _ = window.set_position(tauri::PhysicalPosition::new(area.position.x, area.position.y));
        let _ = window.set_size(tauri::PhysicalSize::new(area.size.width, area.size.height));
    }

    // 默认忽略光标事件：判定跑起来之前，宁可"她点不到"，也不要"挡住整个桌面"。
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.show();
    let _ = window.set_focus();

    // sidecar 跟着窗口一起活：窗口没了，sidecar 也该走（Drop 里收尸）。
    app.manage(std::sync::Mutex::new(sidecar));
    Ok(())
}

/// 把宠物藏起来（托盘菜单用）。窗口还在、sidecar 还在，只是不显示——藏起来不占桌面。
pub fn hide_pet(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        let _ = window.hide();
    }
}

/// 显示宠物，并交还焦点（托盘左键、双击、菜单"显示"都走这里）。
pub fn show_pet(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PET_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 她还在不在桌面上。
///
/// 已经写好但**还没接**：托盘那两项"显示/隐藏"目前不会按状态灰掉（M1 的收尾项）。
/// 留着是因为接它只是两行 —— 菜单项要按状态变，就得先有这个问题可问。
#[allow(dead_code)]
pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PET_WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}
