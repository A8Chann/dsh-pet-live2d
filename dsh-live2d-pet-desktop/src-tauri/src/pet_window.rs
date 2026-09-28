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
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindowBuilder};

pub const PET_WINDOW: &str = "pet";

/// 把窗口放到**第 `index` 块屏幕**的工作区上；已经在那一块就不动（返回 `false`）。
///
/// 什么时候调它：
///   * **启动时一次** —— 默认落在光标当时所在的那块屏（用户在哪块屏上工作，她就出现在哪）；
///   * **用户在托盘里指定屏幕**时。
///
/// 什么时候**不要**调：跟随循环里每帧调。那是我犯过的错 —— 她于是"跟着鼠标所在的屏幕跑"
/// （用户的原话："宠物应该是在固定位置，现在我鼠标在不同屏幕上宠物居然会跟随我的鼠标所在的
/// 屏幕"）。她是桌面上的宠物，位置属于**她**，不属于鼠标。指针移到别的屏时她应该待在原地，
/// 只是视线到屏幕边缘就贴边（`gazeRangePx` 收紧之后自然如此）。
///
/// 为什么是"工作区"而不是整块屏：宠物跑到任务栏底下就点不到了。
pub fn place_on_monitor(app: &AppHandle, index: usize) -> bool {
    let Some(window) = app.get_webview_window(PET_WINDOW) else {
        return false;
    };
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    let Some(monitor) = monitors.get(index) else {
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

/// 光标（虚拟桌面坐标）所在那块屏幕的序号（找不到就给 0 = 第一块）。
pub fn monitor_index_at(app: &AppHandle, x: i32, y: i32) -> usize {
    let Ok(monitors) = app.available_monitors() else {
        return 0;
    };
    for (index, monitor) in monitors.iter().enumerate() {
        let position = monitor.position();
        let size = monitor.size();
        if x >= position.x
            && y >= position.y
            && x < position.x + size.width as i32
            && y < position.y + size.height as i32
        {
            return index;
        }
    }
    0
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
    // WebView2 或窗口创建路径里的某个边界，而全屏透明层本来就不需要铺满。
    let monitor_index = crate::cursor_screen_pos()
        .map(|(x, y)| monitor_index_at(app, x, y))
        .unwrap_or(0);
    let target = app
        .available_monitors()
        .ok()
        .and_then(|monitors| monitors.get(monitor_index).map(|monitor| *monitor.work_area()))
        .or_else(|| app.primary_monitor().ok().flatten().map(|monitor| *monitor.work_area()));

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
