// 桌宠窗口。用**全屏透明层**，理由不是偷懒：
//
//   * 右键面板宽 270px、锚在角色左侧，气泡悬在头顶 —— 一个 300×300 的小窗会把它们
//     裁掉。全屏层里布局与网页端完全一致，`lib/client.js` 一格都不用改。
//   * "只有剪影吃事件、透明处穿透"本来就要逐像素判定（网页端也是这么做的），
//     全屏层把这套判定原样搬到桌面上；点小窗的话反而多一层"窗口本身也是矩形"的问题。
//
// 代价是**穿透判定必须对**：判错了就是一层挡住整个桌面的透明玻璃。所以窗口初始就是
// "忽略光标事件"，由穿透轮询把它打开（见 lib.rs 的 spawn_hover_loop）——失败时默认
// 是"不挡桌面"，而不是"挡住桌面"。
//
// ---- 位置：**她是桌面上的宠物，位置属于她自己** ----
//
// 两件事别搞混：
//
//   * **谁都不能让她跟着鼠标跑**（试过：用户原话是"宠物应该是在固定位置"）——
//     跟随循环里每帧按光标搬窗口是错的；
//   * 但**用户拖动她**必须能把她带到任意一块屏上（issue #11："连多屏后无法拖到别的屏幕"）。
//
// 所以拖动走的是"**拖宠物 = 挪窗口**"：指针不动，窗口跟着指针走，她在窗口里的位置
// （`right/bottom`）自始至终不变。这样多屏、异形排布、负坐标、换分辨率全都自动成立 ——
// 不需要"第几块屏"这个概念，也就不需要托盘里那个「屏幕」子菜单。
//
// 窗口位置因此**存屏幕坐标**（`pet-window.json`），不是相对某块屏。
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::utils::config::Color;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindowBuilder};

pub const PET_WINDOW: &str = "pet";

/// 位置存档的文件名（在 `%DSH_HOME%` 下，**只由壳读写**）。
///
/// 为什么位置不跟其他设置一起放 `pet-settings.json`：那个文件两端都在写（页面 3 秒一轮
/// 同步 + 壳），窗口矩形跟着一起写就会被对面的一次整体覆盖擦掉。这个是壳自己的东西，
/// 单独一个文件最省心。
pub const POSITION_FILE: &str = "pet-window.json";

/// 宠物根节点的**默认**边长（CSS px，与 `lib/client.js` 的 `DEFAULT_SIZE` 同值）。
///
/// 只用于"她大概占多大一块"的可见性判断 —— 真实尺寸是页面在管的，这里绝不拿它去布局。
const PET_APPROX_SIZE_CSS: f64 = 300.0;

/// 默认位置离窗口右下角多远（`lib/client.js` 里 `right: 24, bottom: 0`）。
const PET_MARGIN_RIGHT_CSS: f64 = 24.0;

/// 屏幕上至少要有这么多像素可见，才算"她还在"（否则按最近的那块屏夹回来）。
const MIN_VISIBLE_CSS: f64 = 120.0;

/// 一个矩形（**物理像素**，与 `outer_position` / `inner_size` 同一套坐标）。
///
/// 屏幕框（`monitor.position()` / `work_area()`）在 Windows 与 macOS 上也都是物理像素，
/// 所以可以直接和窗口矩形比 —— 只有**光标**在 macOS 上是逻辑点（见 `cursor_screen_pos`）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    /// 两个矩形相交的宽度与高度（不相交就是 0）。
    pub fn overlap(&self, other: &Rect) -> (f64, f64) {
        let width = self.right().min(other.right()) - self.x.max(other.x);
        let height = self.bottom().min(other.bottom()) - self.y.max(other.y);
        (width.max(0.0), height.max(0.0))
    }

    /// 矩形中心。
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    /// 平移到指定位置（尺寸不变）。
    pub fn moved_to(&self, x: f64, y: f64) -> Rect {
        Rect { x, y, ..*self }
    }
}

/// 她大致占的那块（物理像素），由窗口矩形 + 缩放 + 默认的右下角锚点推出来。
///
/// 位置存档只存窗口矩形：她的位置由 `right/bottom` 锚在窗口右下角，所以"窗口矩形 +
/// 缩放"就足以还原她在屏幕上的那一点。尺寸用默认值 —— 它只参与"还在不在屏幕上"这个
/// 判断，差几十像素不影响结论。
pub fn pet_box(rect: Rect, scale: f64) -> Rect {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let size = PET_APPROX_SIZE_CSS * scale;
    let margin = PET_MARGIN_RIGHT_CSS * scale;
    Rect {
        x: rect.right() - margin - size,
        y: rect.bottom() - size,
        width: size,
        height: size,
    }
}

/// 存档的位置还能不能看见？能就原样返回，看不见就**夹到最近的那块屏**。
///
/// 什么时候会看不见：拖到副屏之后把副屏拔了、分辨率改了、虚拟桌面原点变了。这时候
/// 原样恢复等于"她在一个不存在的地方"—— 窗口在、页面在跑、用户什么都看不到，而且
/// 连托盘「归位」都想不到要按。所以恢复时先问这一句。
///
/// 判据是**她**那块（不是窗口）：窗口是整块屏大小，窗口有一个角在屏幕上不代表她在。
pub fn clamp_pet_visible(rect: Rect, scale: f64, monitors: &[Rect]) -> Rect {
    if monitors.is_empty() {
        return rect;
    }
    let box_pet = pet_box(rect, scale);
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let need = MIN_VISIBLE_CSS * scale;

    // 能在某块屏上看见她（可见面积够大）就原样保留 —— 拖到屏幕边缘、故意压出底边都算
    // "她自己待的地方"，不要多管闲事。
    let visible = monitors.iter().any(|monitor| {
        let (width, height) = box_pet.overlap(monitor);
        width >= need && height >= need
    });
    if visible {
        return rect;
    }

    // 找不到：挑中心最近的那块屏，把她整块挪进去（留同样的右下角边距）。
    let (cx, cy) = box_pet.center();
    let nearest = monitors
        .iter()
        .min_by(|a, b| {
            let distance = |monitor: &Rect| {
                let (mx, my) = monitor.center();
                (mx - cx).powi(2) + (my - cy).powi(2)
            };
            distance(a).partial_cmp(&distance(b)).unwrap_or(std::cmp::Ordering::Equal)
        })
        .copied()
        .unwrap_or(monitors[0]);
    let margin = PET_MARGIN_RIGHT_CSS * scale;
    let size = box_pet.width;
    // 让她的盒子落在这块屏右下角往里一点的位置。
    let pet_x = nearest.right() - margin - size;
    let pet_y = nearest.bottom() - size - margin;
    rect.moved_to(pet_x - (rect.width - margin - size), pet_y - (rect.height - size))
}

/// 位置存档的路径。
pub fn position_path(home: &Path) -> PathBuf {
    home.join(POSITION_FILE)
}

/// 读位置存档：形状不对（缺字段、不是数、宽高非正）就当没有。
pub fn read_saved_rect(home: &Path) -> Option<Rect> {
    let text = std::fs::read_to_string(position_path(home)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    let rect = Rect {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?,
        height: number("height")?,
    };
    if rect.width <= 0.0 || rect.height <= 0.0 || !rect.x.is_finite() || !rect.y.is_finite() {
        return None;
    }
    Some(rect)
}

/// 缩放一起存：恢复时要把它乘回去才知道"她大概占多大"。
pub fn read_saved_scale(home: &Path) -> f64 {
    std::fs::read_to_string(position_path(home))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("scale").and_then(Value::as_f64))
        .filter(|scale| *scale > 0.0)
        .unwrap_or(1.0)
}

/// 写位置存档（临时文件 + rename，避免断电/崩溃留下半截 JSON）。
///
/// 写不进去不是错误：`%DSH_HOME%` 在某些环境里只读（沙箱），那就只是"下次记不住位置"。
pub fn write_saved_rect(home: &Path, rect: Rect, scale: f64) {
    let payload = json!({
        "x": rect.x.round(),
        "y": rect.y.round(),
        "width": rect.width.round(),
        "height": rect.height.round(),
        "scale": if scale > 0.0 { scale } else { 1.0 },
    });
    if std::fs::create_dir_all(home).is_err() {
        return;
    }
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string()) + "\n";
    let target = position_path(home);
    let temporary = target.with_extension("json.tmp");
    if std::fs::write(&temporary, text).is_err() {
        return;
    }
    let _ = std::fs::rename(&temporary, &target);
}

/// 当前窗口的矩形（物理像素）。窗口还没建 / 拿不到时返回 `None`。
pub fn current_rect(app: &AppHandle) -> Option<Rect> {
    let window = app.get_webview_window(PET_WINDOW)?;
    let position = window.outer_position().ok()?;
    // `inner_size` 而不是 `outer_size`：无边框窗口两者相同，但穿透判定用的是内尺寸
    // （页面的视口），用同一个量恢复才不会差一圈。
    let size = window.inner_size().ok()?;
    Some(Rect {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    })
}

/// 把窗口放到一个矩形上（物理像素）。
pub fn apply_rect(app: &AppHandle, rect: Rect) {
    let Some(window) = app.get_webview_window(PET_WINDOW) else {
        return;
    };
    let _ = window.set_position(PhysicalPosition::new(rect.x.round() as i32, rect.y.round() as i32));
    let _ = window.set_size(PhysicalSize::new(
        rect.width.round().max(1.0) as u32,
        rect.height.round().max(1.0) as u32,
    ));
}

/// 所有屏幕的工作区（物理像素）。宠物跑到任务栏底下就点不到了，所以用工作区。
pub fn monitor_rects(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Rect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            }
        })
        .collect()
}

/// 恢复上次的位置：读存档 → 用 `clamp_pet_visible` 夹进现有屏幕。
pub fn restore_rect(app: &AppHandle, home: &Path) -> Option<Rect> {
    let saved = read_saved_rect(home)?;
    let scale = read_saved_scale(home);
    Some(clamp_pet_visible(saved, scale, &monitor_rects(app)))
}

/// 把宠物放到**第 `index` 块屏幕**的工作区上；已经在那一块就不动（返回 `false`）。
///
/// 什么时候调它：
///   * **启动时一次**（没有位置存档时）—— 默认落在光标当时所在的那块屏；
///   * **托盘「归位」** —— 回到光标所在那块屏的右下角。
///
/// 什么时候**不要**调：跟随循环里每帧调。那是我犯过的错 —— 她于是"跟着鼠标所在的屏幕跑"
/// （用户的原话："宠物应该是在固定位置，现在我鼠标在不同屏幕上宠物居然会跟随我的鼠标所在的
/// 屏幕"）。她是桌面上的宠物，位置属于**她**，不属于鼠标。
pub fn place_on_monitor(app: &AppHandle, index: usize) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    let Some(monitor) = monitors.get(index) else {
        return false;
    };
    let area = *monitor.work_area();
    let target = Rect {
        x: area.position.x as f64,
        y: area.position.y as f64,
        width: area.size.width as f64,
        height: area.size.height as f64,
    };
    let already = current_rect(app)
        .map(|current| {
            current.x == target.x
                && current.y == target.y
                && current.width == target.width
                && current.height == target.height
        })
        .unwrap_or(false);
    if already {
        return false;
    }
    apply_rect(app, target);
    true
}

/// 光标现在落在**第几块屏**上（建窗时挑屏、托盘归位用："她在哪块屏上工作，就出现在哪块"）。
///
/// 口径：把**光标**与**每块屏的框**换算到同一个空间再比 —— 两边都必须换算，不能只算一边。
///
/// * Windows：光标（`GetCursorPos`）与屏框都是物理像素 → 直接比；
/// * macOS：光标是**逻辑点**（CoreGraphics 全局显示坐标），而屏框是物理像素
///   （tao 把 `CGDisplayBounds` 乘上了该屏的缩放）→ 这里**除回去**（÷ 该屏自己的缩放），
///   于是逐屏 DPI 不同也对得上：乘了再除，回到 `CGDisplayBounds` 那个点空间。
///
/// 读不到光标（Linux/Wayland 等）就退回第 0 块屏，与"没有光标可选"时的旧行为一致。
pub fn monitor_index_at_cursor(app: &AppHandle) -> usize {
    let Some((cx, cy)) = crate::cursor_screen_pos() else {
        return 0;
    };
    let Ok(monitors) = app.available_monitors() else {
        return 0;
    };
    for (index, monitor) in monitors.iter().enumerate() {
        let scale = if crate::CURSOR_IS_LOGICAL {
            let value = monitor.scale_factor();
            if value > 0.0 {
                value
            } else {
                1.0
            }
        } else {
            1.0
        };
        let position = monitor.position();
        let size = monitor.size();
        let x0 = position.x as f64 / scale;
        let y0 = position.y as f64 / scale;
        let x1 = x0 + size.width as f64 / scale;
        let y1 = y0 + size.height as f64 / scale;
        if cx >= x0 && cy >= y0 && cx < x1 && cy < y1 {
            return index;
        }
    }
    0
}

/// 建桌宠窗口。
///
/// 起手位置按这个顺序挑：
///
///   1. **上次的位置**（`pet-window.json`，存的是屏幕坐标 —— 她被你拖到哪就回到哪）；
///   2. 没有存档 / 存档那块屏已经不在了 → 光标当前所在那块屏的工作区。
pub fn create_pet_window(
    app: &AppHandle,
    url: &str,
    home: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    // 起手尺寸用**一块屏的工作区**，而不是"整个虚拟桌面"。
    //
    // 试过铺满虚拟桌面（8560×1440 + 负坐标），结果进程**直接崩掉**：事件日志里是
    // `0xc0000409`（fail-fast / 栈缓冲越界），模块就是 exe 自己。那个尺寸/负原点会踩到
    // WebView2 或窗口创建路径里的某个边界，而全屏透明层本来就不需要铺满。
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor_index = monitor_index_at_cursor(app);
    let fallback = monitors
        .get(monitor_index)
        .or_else(|| monitors.first())
        .map(|monitor| {
            let area = *monitor.work_area();
            Rect {
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            }
        });
    let restored = restore_rect(app, home);

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

    if let Some(rect) = restored.or(fallback) {
        apply_rect(app, rect);
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

/// 记住她现在待的地方（拖动结束、归位、退出时各写一次）。
pub fn remember_position(app: &AppHandle, home: &Path) {
    let Some(rect) = current_rect(app) else {
        return;
    };
    let scale = app
        .get_webview_window(PET_WINDOW)
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    write_saved_rect(home, rect, scale);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    /// 一块屏 1920×1080，工作区就是它自己（任务栏按 0 算，测试只关心几何）。
    fn single() -> Vec<Rect> {
        vec![monitor(0.0, 0.0, 1920.0, 1080.0)]
    }

    /// 双屏：主屏 1920 在主，副屏 2560 在右边。
    fn dual() -> Vec<Rect> {
        vec![monitor(0.0, 0.0, 1920.0, 1080.0), monitor(1920.0, 0.0, 2560.0, 1440.0)]
    }

    /// 三屏：左边再来一块 —— 虚拟桌面里**负坐标是常态**，别把它当成"跑到屏幕外"。
    fn triple() -> Vec<Rect> {
        let mut monitors = dual();
        monitors.insert(0, monitor(-2560.0, 0.0, 2560.0, 1440.0));
        monitors
    }

    /// 她在窗口右下角：窗口 (0,0) 1920×1080 → 盒子在 (1920-24-300, 1080-300)。
    #[test]
    fn pet_box_sits_in_the_bottom_right_corner() {
        let box_pet = pet_box(monitor(0.0, 0.0, 1920.0, 1080.0), 1.0);
        assert_eq!(box_pet, monitor(1596.0, 780.0, 300.0, 300.0));
    }

    /// 2 倍缩放：盒子的物理像素跟着翻倍，锚点还是右下角。
    #[test]
    fn pet_box_scales_with_the_window() {
        let box_pet = pet_box(monitor(0.0, 0.0, 3840.0, 2160.0), 2.0);
        assert_eq!(box_pet, monitor(3840.0 - 48.0 - 600.0, 2160.0 - 600.0, 600.0, 600.0));
    }

    /// 在屏幕上（包括故意压出底边）→ **一个像素都不动**。
    #[test]
    fn visible_positions_are_left_alone() {
        // 正好铺满主屏。
        assert_eq!(
            clamp_pet_visible(monitor(0.0, 0.0, 1920.0, 1080.0), 1.0, &dual()),
            monitor(0.0, 0.0, 1920.0, 1080.0)
        );
        // 用户在拖动时把她压出屏幕下边一点（脚踩出屏幕那种）—— 她自己待的地方，别管。
        let overhang = monitor(0.0, 100.0, 1920.0, 1080.0);
        assert_eq!(clamp_pet_visible(overhang, 1.0, &dual()), overhang);
        // 负原点（副屏在左边）：虚拟桌面里完全正常，不许当成"屏幕外"。
        let left = monitor(-2560.0, -200.0, 1920.0, 1080.0);
        assert_eq!(clamp_pet_visible(left, 1.0, &triple()), left);
        // 拖到右边副屏上：窗口大半在屏幕外也不算丢。
        let right = monitor(2600.0, 0.0, 1920.0, 1080.0);
        assert_eq!(clamp_pet_visible(right, 1.0, &dual()), right);
    }

    /// 副屏被拔了：存档里那个位置只剩一小片（或者完全没有）能看见 → 夹到最近那块屏。
    #[test]
    fn a_vanished_monitor_is_clamped_back() {
        // 她原来在副屏（x≈4000）上，现在只剩主屏。
        let away = monitor(4000.0, 100.0, 2560.0, 1440.0);
        let fixed = clamp_pet_visible(away, 1.0, &single());
        let box_pet = pet_box(fixed, 1.0);
        assert_eq!(
            box_pet.overlap(&single()[0]),
            (300.0, 300.0),
            "夹回来之后她得**完整**落在这块屏里：{box_pet:?}"
        );
    }

    /// 完全在屏幕上方（用户把它拖上去过）：也得夹回来。
    #[test]
    fn a_window_above_the_screen_is_clamped_back() {
        let above = monitor(0.0, -5000.0, 1920.0, 1080.0);
        let fixed = clamp_pet_visible(above, 1.0, &single());
        let box_pet = pet_box(fixed, 1.0);
        let (width, height) = box_pet.overlap(&single()[0]);
        assert!(width >= 300.0 && height >= 300.0, "夹回来要完整可见：{box_pet:?}");
    }

    /// 一块屏都没有（极少见：远程桌面断开的瞬间）不能 panic，原样返回。
    #[test]
    fn no_monitors_keeps_the_rect() {
        let rect = monitor(100.0, 100.0, 800.0, 600.0);
        assert_eq!(clamp_pet_visible(rect, 1.0, &[]), rect);
    }

    /// 存档的读写在往返之后是同一个矩形（这是"重启还待在那儿"的全部依据）。
    #[test]
    fn position_round_trips_through_the_file() {
        let home = std::env::temp_dir().join(format!(
            "dsh-pet-window-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&home);
        let rect = monitor(-1280.0, 120.0, 2560.0, 1400.0);
        write_saved_rect(&home, rect, 1.5);
        assert_eq!(read_saved_rect(&home), Some(rect));
        assert!((read_saved_scale(&home) - 1.5).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 存档坏了（半截 JSON / 宽高为 0 / 字段缺失）→ 当没有，别把窗口摆到 (0,0) 的 0×0。
    #[test]
    fn a_broken_archive_is_ignored() {
        for text in ["{", "{\"x\":1,\"y\":2}", "{\"x\":1,\"y\":2,\"width\":0,\"height\":100}"] {
            let home = std::env::temp_dir().join(format!(
                "dsh-pet-window-broken-{}",
                std::process::id()
            ));
            let _ = std::fs::create_dir_all(&home);
            std::fs::write(position_path(&home), text).unwrap();
            assert_eq!(read_saved_rect(&home), None, "应当忽略：{text}");
            let _ = std::fs::remove_dir_all(&home);
        }
    }
}
