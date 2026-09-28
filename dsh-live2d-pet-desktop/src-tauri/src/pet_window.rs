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
use tauri::utils::config::Color;
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindowBuilder};

pub const PET_WINDOW: &str = "pet";

/// 光标（虚拟桌面坐标）落在哪块显示器上。
fn monitor_containing(app: &AppHandle, x: i32, y: i32) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors.into_iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        x >= position.x
            && y >= position.y
            && x < position.x + size.width as i32
            && y < position.y + size.height as i32
    })
}

/// 把窗口搬到"光标所在那块显示器"的工作区上。
///
/// 只有在**真的换了屏**时才动（返回 `true`），否则每 33ms 一次 `set_position` 会让窗口
/// 一直重排、页面那边 `ResizeObserver` 也就一直重抓轮廓。
///
/// 为什么是"工作区"而不是整块屏：宠物跑到任务栏底下就点不到了。
pub fn focus_monitor_at(app: &AppHandle, x: i32, y: i32) -> bool {
    let Some(window) = app.get_webview_window(PET_WINDOW) else {
        return false;
    };
    let Some(monitor) = monitor_containing(app, x, y) else {
        return false;
    };
    let area = *monitor.work_area();
    let already = window
        .outer_position()
        .ok()
        .map(|position| position.x == area.position.x && position.y == area.position.y)
        .unwrap_or(false);
    if already {
        return false;
    }
    let _ = window.set_position(PhysicalPosition::new(area.position.x, area.position.y));
    let _ = window.set_size(PhysicalSize::new(area.size.width, area.size.height));
    true
}

/// 建桌宠窗口。
///
/// 翻成同进程宿主之后这个函数不再接管子进程（以前要 `app.manage(sidecar)` 让它的 Drop
/// 负责收尸），只负责窗口。
pub fn create_pet_window(app: &AppHandle, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    // 起手尺寸用**光标当前所在那块屏的工作区**，而不是"整个虚拟桌面"。
    //
    // 试过铺满虚拟桌面（8560×1440 + 负坐标），结果进程**直接崩掉**：事件日志里是
    // `0xc0000409`（fail-fast / 栈缓冲越界），模块就是 exe 自己。那个尺寸/负原点会踩到
    // WebView2 或窗口创建路径里的某个边界，而全屏透明层本来就不需要铺满 ——
    // 跟随循环（`focus_monitor_at`）会把窗口搬到光标所在的那块屏上。
    //
    // 顺序很关键：**先按光标的屏幕定位，再决定尺寸**，否则用户在多屏环境里看到的她
    // 永远在主屏（那就是"无法移动到别的屏幕"的另一半）。
    let target = crate::cursor_screen_pos()
        .and_then(|(x, y)| monitor_containing(app, x, y))
        .or_else(|| app.primary_monitor().ok().flatten())
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

    if let Some(area) = target {
        let _ = window.set_position(PhysicalPosition::new(area.position.x, area.position.y));
        let _ = window.set_size(PhysicalSize::new(area.size.width, area.size.height));
    }

    // 默认忽略光标事件：判定跑起来之前，宁可"她点不到"，也不要"挡住整个桌面"。
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// 把宠物藏起来（托盘菜单用）。窗口与宿主都还在，只是不显示——藏起来不占桌面。
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
