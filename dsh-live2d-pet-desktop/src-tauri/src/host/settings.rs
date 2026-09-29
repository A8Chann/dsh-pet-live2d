// 设置存档（共享）：`%DSH_HOME%\pet-settings.json`，**两端都读写同一份**。
//
// 与 `dsh-live2d-pet/lib/settings.js` **逐字对应**（那边是网页端/D SH 侧在用的实现）。
// 为什么必须有它：设置原来只存在 `window.localStorage` 里，而**桌面端页面与 DSH 页面不是
// 同一个 origin**（桌面端在 `http://127.0.0.1:<壳的随机端口>`）—— 浏览器按 origin 隔离
// localStorage，两边各一份、永不互见。用户 2026-09 报的"桌面端设置与 DSH 里的不一致"
// 就是这个：独立模式的壳**没有实现这条路由**，页面只能退回它自己那份 localStorage。
//
// 三个键（与客户端的三类 shared 存档一一对应）：
//
//   tuning     ← `dsh-pet-live2d.settings.v1`  可调项（手感、池子节奏…）
//   overrides  ← `dsh-pet-live2d.settings.v2`  相位池子覆盖 + 开关 + 反应清空
//   outfit     ← `dsh-pet-live2d:outfit`       装扮槽位的选择
//
// **位置与大小不在里面**：那个必须每个窗口各不相同（桌面上她贴屏幕角落、DSH 页面里她贴
// 面板角落），共享了反而会打架。
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 存档里的键（客户端与 JS 侧都按这三个名字读写）。
pub const SETTINGS_KEYS: [&str; 3] = ["tuning", "overrides", "outfit"];

pub fn settings_path(home: &Path) -> PathBuf {
    home.join("pet-settings.json")
}

/// 空存档（文件不存在 / 读坏了都返回它）。
fn empty_settings() -> Value {
    json!({ "tuning": Value::Null, "overrides": Value::Null, "outfit": Value::Null, "rev": 0, "at": 0 })
}

/// 读共享设置。键缺失就是 `null`（"这一项用户没改过"）。
///
/// `rev` 每次**有内容的**写入 +1 —— 页面用它判断"我这份是不是旧的"，也用它避免自己写自己读
/// 的回环。文件被人手改坏时只接受形状对的部分，别把坏数据传染给页面。
pub fn read_settings(home: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(settings_path(home)) else {
        return empty_settings();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return empty_settings();
    };
    let Some(source) = parsed.as_object() else {
        return empty_settings();
    };

    let mut out = empty_settings();
    let target = out.as_object_mut().expect("刚建出来的对象");
    for key in SETTINGS_KEYS {
        if let Some(value) = source.get(key) {
            // 只接受对象（数组/字符串/null 一律当作"没设过"）。
            if value.is_object() {
                target.insert(key.to_string(), value.clone());
            }
        }
    }
    if let Some(rev) = source.get("rev").and_then(Value::as_u64) {
        target.insert("rev".to_string(), json!(rev));
    }
    if let Some(at) = source.get("at").and_then(Value::as_u64) {
        target.insert("at".to_string(), json!(at));
    }
    out
}

/// 写共享设置（**合并写**：只动传进来的那几项，别把别的窗口写的擦掉）。
///
/// 返回写好之后的那一份（含新的 `rev`）；`None` = **写失败** —— 调用方要能区分"没写成功"
/// 和"写成功了"，否则页面会以为同步好了。
pub fn write_settings(home: &Path, patch: &Value) -> Option<Value> {
    let patch = patch.as_object()?;
    let current = read_settings(home);

    let mut next = current.clone();
    let mut touched = false;
    {
        let target = next.as_object_mut()?;
        for key in SETTINGS_KEYS {
            match patch.get(key) {
                // 没传 / null / 不是对象 ⇒ 不动这一项。
                Some(value) if value.is_object() => {
                    target.insert(key.to_string(), value.clone());
                    touched = true;
                }
                _ => {}
            }
        }
    }

    // **没有实际内容就不算一次写入**：不推进 `rev`、也不落盘。
    //
    // 这条是防回环的：页面按 `rev` 判断"我这份是不是旧的"，如果"只带 rev 的空写"也推进版本号，
    // 另一个窗口就会以为有变化、于是回写一次 → 互相推着转。（JS 那边有同样的注释与测试。）
    if !touched {
        return Some(current);
    }

    if let Some(target) = next.as_object_mut() {
        let rev = current.get("rev").and_then(Value::as_u64).unwrap_or(0) + 1;
        target.insert("rev".to_string(), json!(rev));
        target.insert("at".to_string(), json!(super::display::now_ms()));
    }

    let text = serde_json::to_string_pretty(&next).ok()? + "\n";
    std::fs::create_dir_all(home).ok()?;
    std::fs::write(settings_path(home), text).ok()?;
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome(std::path::PathBuf);
    impl TempHome {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-pet-settings-{tag}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
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

    #[test]
    fn 没有文件时给出空存档() {
        let home = TempHome::new("empty");
        let settings = read_settings(home.path());
        assert_eq!(settings.get("rev").and_then(Value::as_u64), Some(0));
        assert!(settings.get("tuning").expect("有键").is_null());
    }

    #[test]
    fn 写一项不动别的项_并且推进_rev() {
        let home = TempHome::new("merge");
        let first = write_settings(home.path(), &json!({ "tuning": { "a": 1 } })).expect("写成功");
        assert_eq!(first.get("rev").and_then(Value::as_u64), Some(1));

        let second = write_settings(home.path(), &json!({ "outfit": { "slot": "x" } })).expect("写成功");
        assert_eq!(second.get("rev").and_then(Value::as_u64), Some(2));
        // 关键：第一次写的 tuning 不能被第二次擦掉（两端各写各的）。
        assert_eq!(
            second.get("tuning").and_then(|value| value.get("a")).and_then(Value::as_u64),
            Some(1)
        );
        // 落盘的那份也要一致。
        let on_disk = read_settings(home.path());
        assert_eq!(on_disk.get("rev").and_then(Value::as_u64), Some(2));
        assert_eq!(
            on_disk.get("outfit").and_then(|value| value.get("slot")).and_then(Value::as_str),
            Some("x")
        );
    }

    #[test]
    fn 空写不推进_rev_也不落盘() {
        let home = TempHome::new("noop");
        write_settings(home.path(), &json!({ "tuning": { "a": 1 } })).expect("写成功");
        // `null` / 缺键 / 非对象：都不算内容。
        let noop = write_settings(home.path(), &json!({ "overrides": Value::Null, "outfit": "不是对象" }))
            .expect("不算失败");
        assert_eq!(noop.get("rev").and_then(Value::as_u64), Some(1), "空写不能推进版本号（会两端互推）");
    }

    #[test]
    fn 坏文件只取形状对的部分() {
        let home = TempHome::new("broken");
        std::fs::write(settings_path(home.path()), "{ not json").expect("写坏文件");
        let settings = read_settings(home.path());
        assert_eq!(settings.get("rev").and_then(Value::as_u64), Some(0));

        std::fs::write(
            settings_path(home.path()),
            r#"{ "tuning": [1,2], "overrides": { "ok": true }, "rev": 7 }"#,
        )
        .expect("写半坏文件");
        let settings = read_settings(home.path());
        assert!(settings.get("tuning").expect("有键").is_null(), "数组不是对象，必须拒");
        assert!(settings.get("overrides").expect("有键").is_object(), "对象要留下");
        assert_eq!(settings.get("rev").and_then(Value::as_u64), Some(7));
    }

    #[test]
    fn 非对象补丁直接判失败() {
        let home = TempHome::new("badpatch");
        assert!(write_settings(home.path(), &json!([1, 2, 3])).is_none());
        assert!(write_settings(home.path(), &json!("x")).is_none());
    }
}
