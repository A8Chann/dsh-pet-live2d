// 启动日志：GUI 程序没有控制台，出问题时用户只能看到"什么都没发生"。
//
// `main.rs` 上有 `windows_subsystem = "windows"`（release 版双击不弹黑框），代价是
// **stderr 没有去处** —— 启动失败、WebView2 建不起来、panic，全都无声无息。
// 用户 2026-09 报的"直接跑 Release 里的 exe，桌宠没显示出来"就是踩在这上面：
// 进程读了显示层偏好就自己让位了，而这件事只有 stderr 知道。
//
// 所以启动过程同时写一份 `%DSH_HOME%\pet-desktop.log`（stderr 照旧打，开发时不用改习惯）。
use std::io::Write;
use std::path::{Path, PathBuf};

/// 日志上限：超过就先清空再写（它是给人扫的现场，不是归档，别让它无限长）。
const MAX_BYTES: u64 = 256 * 1024;

pub fn log_path(home: &Path) -> PathBuf {
    home.join("pet-desktop.log")
}

/// 追加一行（带 UTC 时间戳）。
pub fn log(home: &Path, line: &str) {
    // 开发时（`cargo run` / 带控制台启动）照旧能在终端看到。
    eprintln!("{line}");
    let _ = std::fs::create_dir_all(home);
    let path = log_path(home);
    let oversized = std::fs::metadata(&path).map(|meta| meta.len() > MAX_BYTES).unwrap_or(false);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    let opened = if oversized {
        options.truncate(true).open(&path)
    } else {
        options.append(true).open(&path)
    };
    if let Ok(mut file) = opened {
        let _ = writeln!(file, "{} {}", now_stamp(), line);
    }
}

/// 现在的时间戳（UTC）。
pub fn now_stamp() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    format_utc_ms(ms)
}

/// `epoch 毫秒` → `YYYY-MM-DD HH:MM:SS.mmmZ`。
///
/// **UTC**：换算成本地时间要拿操作系统的时区（Windows 是又一个 API），而日志是用来
/// 对时间的，标清楚是 UTC 就够了。自己算（不引 chrono）是为了让这段能在本机跑单元测试。
pub fn format_utc_ms(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let rest = ms % 86_400_000;
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rest / 3_600_000, (rest % 3_600_000) / 60_000, (rest % 60_000) / 1000);
    format!(
        "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{:03}Z",
        rest % 1000
    )
}

/// 1970-01-01 起的天数 → 年月日（Howard Hinnant 的 `civil_from_days`）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::format_utc_ms;

    #[test]
    fn 纪元起点() {
        assert_eq!(format_utc_ms(0), "1970-01-01 00:00:00.000Z");
    }

    #[test]
    fn 闰年与月末() {
        // 2000-01-01T00:00:00Z = 946684800 秒；再加 60 天（1 月 31 天 + 闰年 2 月 29 天）。
        assert_eq!(format_utc_ms(946_684_800_000), "2000-01-01 00:00:00.000Z");
        assert_eq!(format_utc_ms(951_868_800_000), "2000-03-01 00:00:00.000Z");
        // 非闰年的 3 月 1 日：2023-01-01 + 59 天。
        assert_eq!(format_utc_ms(1_672_531_200_000), "2023-01-01 00:00:00.000Z");
        assert_eq!(format_utc_ms(1_677_628_800_000), "2023-03-01 00:00:00.000Z");
    }

    #[test]
    fn 毫秒与闰秒之外的分秒() {
        assert_eq!(format_utc_ms(1_700_000_000_123), "2023-11-14 22:13:20.123Z");
    }
}
