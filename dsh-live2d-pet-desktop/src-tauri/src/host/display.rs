// 显示层：桌面上只有一只宠物。
//
// 宠物有两条呈现路径 —— **页面内**（插件在 DSH 里渲染）与**桌面上**（一个原生窗口进程）。
// 两边都可能活着，所以需要一个"谁管这只宠物"的判定，否则用户会看见两只。
//
// 协调靠一个**双方都能读的偏好文件**（`%DSH_HOME%\pet-desktop.json`）：
//
//   {
//     "mode": "auto" | "inline" | "desktop",   // 用户在 DSH 设置里选的
//     "desktopPid": 1234,                      // 桌面端心跳：每 2 秒刷一次
//     "desktopStartedAt": 1790000000000,
//     "at": 1790000000000                      // 心跳时间戳
//   }
//
// 判定规则**只有一条**，两端各自算、结论必然一致：
//
//   桌面端心跳新鲜（< 6 秒）且 mode ≠ "inline"  →  桌面端是 owner
//   否则                                        →  页面内是 owner
//
// 为什么不走 DSH 的进程内服务：桌面端是**另一个进程**，拿不到 `ctx.on(...)`。
// 一个文件 + 一条纯规则，是这两边唯一都能用的东西。
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// 心跳有效期：桌面端每 2 秒刷一次，这里给三倍余量。
///
/// 它同时是"她什么时候回来"的上限 —— 把桌面端杀了，页面里那只最多 6 秒后自己出现。
pub const HEARTBEAT_TTL_MS: u64 = 6000;

pub const MODES: &[&str] = &["auto", "inline", "desktop"];

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn preference_path(home: &Path) -> std::path::PathBuf {
    home.join("pet-desktop.json")
}

/// 读偏好文件（读不出来就当空 —— 老装机本来就没有）。
pub fn read_preference(home: &Path) -> Value {
    std::fs::read_to_string(preference_path(home))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// 写偏好文件（保持已有字段：两端都在往里写，别把对方的东西擦掉）。
pub fn write_preference(home: &Path, patch: Value) -> std::io::Result<Value> {
    let mut current = read_preference(home);
    if let (Some(target), Some(source)) = (current.as_object_mut(), patch.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    std::fs::create_dir_all(home)?;
    let text = serde_json::to_string_pretty(&current).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(preference_path(home), text + "\n")?;
    Ok(current)
}

/// 规范化 mode：认不出来就当 `auto`。
pub fn normalise_mode(raw: Option<&Value>) -> String {
    match raw.and_then(Value::as_str) {
        Some(text) if MODES.contains(&text) => text.to_string(),
        _ => "auto".to_string(),
    }
}

/// 桌面端心跳新不新鲜。
pub fn heartbeat_fresh(preference: &Value, now: u64) -> bool {
    let at = preference.get("at").and_then(Value::as_u64).unwrap_or(0);
    let pid = preference.get("desktopPid").and_then(Value::as_u64).unwrap_or(0);
    pid != 0 && at != 0 && now.saturating_sub(at) < HEARTBEAT_TTL_MS
}

/// **判定规则**（两端各有一份实现，逻辑必须一致）。
///
/// 返回 `"desktop"` 或 `"inline"`。
pub fn compute_owner(mode: &str, heartbeat_ok: bool) -> &'static str {
    if mode != "inline" && heartbeat_ok {
        "desktop"
    } else {
        "inline"
    }
}

/// 桌面端启动时的自我判定：我该显示吗？
///
/// 注意它读的是**同一个规则** —— 于是"谁显示"永远只有一个答案，不会两边都以为自己该显示。
pub fn desktop_should_show(home: &Path) -> bool {
    let preference = read_preference(home);
    let mode = normalise_mode(preference.get("mode"));
    // 自己刚启动（心跳就是自己），所以只要不是 inline 就该显示。
    compute_owner(&mode, true) == "desktop"
}

/// 桌面端心跳：把"我还活着、我是哪个进程"写进偏好文件。
pub fn publish_heartbeat(home: &Path) -> std::io::Result<()> {
    let pid = std::process::id() as u64;
    let preference = read_preference(home);
    let started = preference
        .get("desktopStartedAt")
        .and_then(Value::as_u64)
        .filter(|value| *value != 0)
        .unwrap_or_else(now_ms);
    write_preference(
        home,
        json!({
            "desktopPid": pid,
            "desktopStartedAt": started,
            "at": now_ms(),
        }),
    )?;
    Ok(())
}

/// 桌面端退出时清掉心跳，让页面里那只**立刻**回来（不用等 6 秒超时）。
pub fn clear_heartbeat(home: &Path) {
    let mut preference = read_preference(home);
    if let Some(map) = preference.as_object_mut() {
        map.insert("desktopPid".to_string(), json!(0));
        map.insert("at".to_string(), json!(0));
    }
    let _ = write_preference(home, preference);
}

/// 给 DSH 设置页看的完整状态。
pub fn status(home: &Path, spawned: bool) -> Value {
    let preference = read_preference(home);
    let mode = normalise_mode(preference.get("mode"));
    let fresh = heartbeat_fresh(&preference, now_ms());
    json!({
        "mode": mode,
        "owner": compute_owner(&mode, fresh),
        "desktopRunning": fresh,
        "desktopPid": preference.get("desktopPid").cloned().unwrap_or(json!(0)),
        "desktopSpawnedByPlugin": spawned,
        "heartbeatAt": preference.get("at").cloned().unwrap_or(json!(0)),
        "ttlMs": HEARTBEAT_TTL_MS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome(std::path::PathBuf);
    impl TempHome {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-pet-display-{tag}-{}-{:?}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("建临时目录");
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// **判定规则**：两端都照着它算，所以这里把每个组合钉死。
    #[test]
    fn owner_rule_is_total() {
        // 心跳新鲜：mode 不是 inline 就是桌面端
        assert_eq!(compute_owner("auto", true), "desktop");
        assert_eq!(compute_owner("desktop", true), "desktop");
        assert_eq!(compute_owner("inline", true), "inline", "选了页面内，桌面端必须让位");
        // 心跳不新鲜：一律回到页面内
        assert_eq!(compute_owner("auto", false), "inline", "桌面端没跑 → 页面内接管");
        assert_eq!(compute_owner("desktop", false), "inline", "选了桌面但没跑：页面内先顶着");
        assert_eq!(compute_owner("inline", false), "inline");
    }

    #[test]
    fn mode_is_normalised_and_unknown_falls_back_to_auto() {
        assert_eq!(normalise_mode(Some(&json!("desktop"))), "desktop");
        assert_eq!(normalise_mode(Some(&json!("inline"))), "inline");
        assert_eq!(normalise_mode(Some(&json!("auto"))), "auto");
        assert_eq!(normalise_mode(Some(&json!("banana"))), "auto");
        assert_eq!(normalise_mode(Some(&json!(42))), "auto");
        assert_eq!(normalise_mode(None), "auto");
    }

    #[test]
    fn heartbeat_expires_after_ttl() {
        let now = 1_000_000u64;
        let fresh = json!({ "desktopPid": 42, "at": now - 1000 });
        let stale = json!({ "desktopPid": 42, "at": now - HEARTBEAT_TTL_MS - 1 });
        let never = json!({ "desktopPid": 0, "at": now });
        assert!(heartbeat_fresh(&fresh, now));
        assert!(!heartbeat_fresh(&stale, now), "超过 TTL 就算不在跑");
        assert!(!heartbeat_fresh(&never, now), "没有 pid 不算在跑");
        assert!(!heartbeat_fresh(&json!({}), now));
    }

    #[test]
    fn writing_preference_keeps_the_other_side_s_fields() {
        let home = TempHome::new("merge");
        publish_heartbeat(home.path()).expect("写心跳");
        write_preference(home.path(), json!({ "mode": "desktop" })).expect("写偏好");
        let preference = read_preference(home.path());
        assert_eq!(preference.get("mode").and_then(Value::as_str), Some("desktop"));
        assert_ne!(
            preference.get("desktopPid").and_then(Value::as_u64),
            Some(0),
            "写偏好不能把桌面端的心跳擦掉"
        );
    }

    #[test]
    fn desktop_should_show_follows_the_rule() {
        let home = TempHome::new("should-show");
        // 没写任何东西 → auto + 自己刚启动 → 显示
        assert!(desktop_should_show(home.path()));
        write_preference(home.path(), json!({ "mode": "inline" })).unwrap();
        assert!(!desktop_should_show(home.path()), "用户选了页面内 → 桌面端不该显示");
        write_preference(home.path(), json!({ "mode": "desktop" })).unwrap();
        assert!(desktop_should_show(home.path()));
    }

    #[test]
    fn status_reports_truthfully() {
        let home = TempHome::new("status");
        let cold = status(home.path(), false);
        assert_eq!(cold.get("mode").and_then(Value::as_str), Some("auto"));
        assert_eq!(cold.get("owner").and_then(Value::as_str), Some("inline"));
        assert_eq!(cold.get("desktopRunning").and_then(Value::as_bool), Some(false));

        publish_heartbeat(home.path()).unwrap();
        let warm = status(home.path(), true);
        assert_eq!(warm.get("owner").and_then(Value::as_str), Some("desktop"));
        assert_eq!(warm.get("desktopRunning").and_then(Value::as_bool), Some(true));
        assert_eq!(warm.get("desktopSpawnedByPlugin").and_then(Value::as_bool), Some(true));
        assert_ne!(warm.get("desktopPid").and_then(Value::as_u64), Some(0));

        clear_heartbeat(home.path());
        let gone = status(home.path(), false);
        assert_eq!(gone.get("owner").and_then(Value::as_str), Some("inline"), "退出后页面内立刻回来");
    }
}
