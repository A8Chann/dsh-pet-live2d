// 进程内共享状态：穿透判定 + 壳的状态 + 探针统计。
//
// 为什么这些能放在内存里、而不像 Node sidecar 那样绕一个文件：**服务器与壳现在是同一个
// 进程**。以前壳把状态写进 `shell-state.json` 让 sidecar 读，是因为两者隔着进程边界；
// 翻成 Rust 之后那层文件协议整个不需要了 —— 少一次 33ms 一次的磁盘写，也少一个能写歪的
// 中间格式。
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

/// 光标位置（页面坐标）。
#[derive(Clone, Copy, Default)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// 一次"该不该穿透"的问询。
pub struct Probe {
    pub seq: u64,
    pub point: Point,
    pub answer: Option<(bool, String)>,
}

#[derive(Default)]
pub struct ProbeStats {
    pub asked: u64,
    pub answered: u64,
    pub dropped: u64,
    pub last_reason: String,
}

/// 壳与服务器共享的一切。
pub struct Shared {
    pub started: Instant,
    pub probe: Probe,
    pub stats: ProbeStats,
    /// 壳侧的开关：`--active=false` 时不做穿透轮询（A/B 对照用）。
    pub active: bool,
    /// 光标（屏幕物理像素）与换算出来的窗口内坐标。
    pub cursor: Option<(i32, i32)>,
    pub local: Option<(i32, i32)>,
    pub window_origin: Option<(f64, f64)>,
    pub window_size: Option<(u32, u32)>,
    pub scale: f64,
    /// 上一次判定结果（`interactive` = 光标下面是"她"或面板）。
    pub interactive: bool,
    pub ignored: bool,
    pub last_reason: String,
    pub probes: u64,
    pub changes: u64,
    pub probe_errors: u64,
    /// 自适应会话相位（由 dsh-link 写）。
    pub phase: String,
    pub phase_detail: String,
    pub dsh: Value,
    /// 端口（页面地址的一部分，诊断用）。
    pub port: u16,
}

impl Shared {
    pub fn new(active: bool) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            started: Instant::now(),
            probe: Probe { seq: 0, point: Point::default(), answer: None },
            stats: ProbeStats::default(),
            active,
            cursor: None,
            local: None,
            window_origin: None,
            window_size: None,
            scale: 1.0,
            interactive: false,
            ignored: true,
            last_reason: String::new(),
            probes: 0,
            changes: 0,
            probe_errors: 0,
            phase: "idle".to_string(),
            phase_detail: String::new(),
            dsh: json!({ "connected": false, "disabled": true }),
            port: 0,
        }))
    }

    /// 壳问一次："光标在 (x, y) 时，窗口要不要忽略光标事件？"
    ///
    /// 语义与 Node 版一致：把任务挂起来（清掉上一次的答案），等页面来领；
    /// `verdict()` 读答案，读不到就当"穿透"（宁可点不到她，也不要挡住桌面）。
    pub fn ask_probe(&mut self, point: Point) {
        // 上一个还没答完就被顶掉：页面慢了，记一笔但不算错。
        if self.probe.answer.is_none() && self.probe.seq > 0 {
            self.stats.dropped += 1;
        }
        self.probe.seq += 1;
        self.probe.point = point;
        self.probe.answer = None;
        self.stats.asked += 1;
    }

    /// 读答案。`None` = 页面还没答（壳会按"穿透 + 记一次 probe_errors"处理）。
    pub fn verdict(&self) -> Option<(bool, String)> {
        self.probe.answer.clone()
    }

    pub fn answer_probe(&mut self, seq: u64, interactive: bool, reason: String) -> bool {
        if seq != self.probe.seq {
            return false;
        }
        self.probe.answer = Some((interactive, reason.clone()));
        self.stats.answered += 1;
        self.stats.last_reason = reason;
        true
    }

    /// 壳每轮把结果写回来（判定、坐标、忽略状态、切换次数）。
    pub fn report_hover(
        &mut self,
        cursor: (i32, i32),
        local: (i32, i32),
        origin: (f64, f64),
        size: (u32, u32),
        scale: f64,
        interactive: bool,
        reason: String,
    ) {
        let ignore = !interactive;
        if self.ignored != ignore {
            self.changes += 1;
        }
        self.cursor = Some(cursor);
        self.local = Some(local);
        self.window_origin = Some(origin);
        self.window_size = Some(size);
        self.scale = scale;
        self.interactive = interactive;
        self.ignored = ignore;
        self.last_reason = reason;
        self.probes += 1;
    }

    pub fn set_phase(&mut self, phase: &str, detail: &str) {
        if self.phase == phase && self.phase_detail == detail {
            return;
        }
        self.phase = phase.to_string();
        self.phase_detail = detail.to_string();
    }

    /// 壳的状态（给 `/__desktop/shell` 与驱动看；驱动读的就是这一份）。
    pub fn shell_json(&self) -> Value {
        json!({
            "sidecarUrl": if self.port == 0 { Value::Null } else { json!(format!("http://127.0.0.1:{}", self.port)) },
            "windowOrigin": self.window_origin.map(|(x, y)| json!([x, y])).unwrap_or(Value::Null),
            "windowSize": self.window_size.map(|(w, h)| json!([w, h])).unwrap_or(Value::Null),
            "scale": if self.scale > 0.0 { self.scale } else { 1.0 },
            "cursor": self.cursor.map(|(x, y)| json!([x, y])).unwrap_or(Value::Null),
            "cursorLocal": self.local.map(|(x, y)| json!([x, y])).unwrap_or(Value::Null),
            "interactive": self.interactive,
            "ignored": self.ignored,
            "active": self.active,
            "lastReason": self.last_reason,
            "probes": self.probes,
            "changes": self.changes,
            "probeErrors": self.probe_errors,
            "uptimeMs": self.started.elapsed().as_millis() as u64,
        })
    }

    pub fn probe_json(&self) -> Value {
        json!({
            "asked": self.stats.asked,
            "answered": self.stats.answered,
            "dropped": self.stats.dropped,
            "lastReason": self.stats.last_reason,
        })
    }
}
