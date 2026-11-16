// 声音库（Rust 版）：与 `dsh-live2d-pet/lib/sound-files.js` 的库函数逐条对齐。
//
// 分工与 JS 版一致：
//   * **随包声音**活在宠物目录里（`pet.json` 的 `voices`），只读，由 catalog 直接合并；
//   * **用户声音**落在这里 —— `$DSH_HOME/pet-sounds/<petId>.sounds.json` 存元数据，
//     音频文件沿用旧接口的命名 `<petId>--<soundId>.audio`；
//   * 旧接口（相位上传）留下的 `<petId>--<phase>.audio` 在第一次读库时收编成
//     `legacy-<phase>` 条目 —— 幂等，且文件被手删掉的条目会自动消失。
//
// 容器判据不在这里重写一遍：`http::sound_mime` 就是与 JS 侧共享的那一套（两边跑同一份
// 合同向量）。**改判据必须两边一起改**。
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use super::http::{sound_mime, SOUND_PHASES};

/// 一只宠物最多放多少条用户声音。
pub const MAX_LIBRARY: usize = 64;
const MAX_AUDIO: usize = 1024 * 1024;
const MAX_NAME: usize = 60;

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn sounds_dir(home: &Path) -> PathBuf {
    home.join("pet-sounds")
}

fn meta_path(home: &Path, pet_id: &str) -> PathBuf {
    sounds_dir(home).join(format!("{pet_id}.sounds.json"))
}

/// 声音的实际文件路径。
///
/// 旧上传的文件名是 `<petId>--<phase>.audio`，而它的库 id 是 `legacy-<phase>` ——
/// 所以**带 phase 的条目按 phase 找文件**，其余按 id。JS 版 `libraryFilePath` 同一条规则。
fn audio_path(home: &Path, pet_id: &str, file_id: &str) -> PathBuf {
    sounds_dir(home).join(format!("{pet_id}--{file_id}.audio"))
}

fn entry_file_id<'a>(sound_id: &'a str, phase: Option<&'a str>) -> &'a str {
    match phase {
        Some(phase) if sound_id == format!("legacy-{phase}") => phase,
        _ => sound_id,
    }
}

/// 按条目（id + 可选 phase）解析文件路径。
fn entry_path(home: &Path, pet_id: &str, sound_id: &str, phase: Option<&str>) -> PathBuf {
    audio_path(home, pet_id, entry_file_id(sound_id, phase))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn clean_name(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME)
        .collect()
}

/// 元数据里的条目（保留 `at` / `phase` 这些内部字段）。
fn read_meta(home: &Path, pet_id: &str) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(meta_path(home, pet_id)) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(list) = parsed.get("sounds").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in list {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !valid_id(id) || seen.iter().any(|known| known == id) {
            continue;
        }
        let phase = entry
            .get("phase")
            .and_then(Value::as_str)
            .filter(|phase| SOUND_PHASES.contains(phase));
        let Ok(stat) = std::fs::metadata(entry_path(home, pet_id, id, phase)) else {
            continue;
        };
        if !stat.is_file() || stat.len() as usize > MAX_AUDIO {
            continue;
        }
        let mut item = Map::new();
        item.insert("id".to_string(), Value::String(id.to_string()));
        item.insert("name".to_string(), Value::String(clean_name(entry.get("name"))));
        item.insert(
            "at".to_string(),
            Value::Number(entry.get("at").and_then(Value::as_u64).unwrap_or(0).into()),
        );
        if let Some(phase) = entry.get("phase").and_then(Value::as_str) {
            if SOUND_PHASES.contains(&phase) {
                item.insert("phase".to_string(), Value::String(phase.to_string()));
            }
        }
        seen.push(id.to_string());
        out.push(Value::Object(item));
    }
    out
}

fn write_meta(home: &Path, pet_id: &str, entries: &[Value]) -> std::io::Result<()> {
    let dir = sounds_dir(home);
    std::fs::create_dir_all(&dir)?;
    let payload = json!({ "version": 1, "sounds": entries });
    let text = serde_json::to_string_pretty(&payload)? + "\n";
    let temp = dir.join(format!(".{}.{}.tmp", pet_id, now_ms()));
    std::fs::write(&temp, text.as_bytes())?;
    std::fs::rename(&temp, meta_path(home, pet_id))?;
    Ok(())
}

fn write_audio(home: &Path, pet_id: &str, sound_id: &str, bytes: &[u8]) -> std::io::Result<()> {
    let dir = sounds_dir(home);
    std::fs::create_dir_all(&dir)?;
    let temp = dir.join(format!(".{}.{}.{}.tmp", pet_id, sound_id, now_ms()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, audio_path(home, pet_id, sound_id))?;
    Ok(())
}

/// 目录条目 -> catalog 用的形状（不带内部字段）。
fn catalog_entry(entry: &Value) -> Value {
    let mut item = Map::new();
    item.insert(
        "id".to_string(),
        entry.get("id").cloned().unwrap_or(Value::String(String::new())),
    );
    item.insert(
        "name".to_string(),
        entry.get("name").cloned().unwrap_or(Value::String(String::new())),
    );
    item.insert("builtin".to_string(), Value::Bool(false));
    if let Some(phase) = entry.get("phase").and_then(Value::as_str) {
        item.insert("phase".to_string(), Value::String(phase.to_string()));
    }
    Value::Object(item)
}

/// 读库（含一次性的旧文件收编）。返回 catalog 形状的条目。
pub fn list(home: &Path, pet_id: &str) -> Vec<Value> {
    if !valid_id(pet_id) {
        return Vec::new();
    }
    let mut entries = read_meta(home, pet_id);
    let mut dirty = false;
    for phase in SOUND_PHASES {
        let id = format!("legacy-{phase}");
        if entries
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            continue;
        }
        let path = entry_path(home, pet_id, &id, Some(phase));
        let Ok(stat) = std::fs::metadata(&path) else {
            continue;
        };
        if !stat.is_file() || stat.len() as usize > MAX_AUDIO {
            continue;
        }
        entries.push(json!({
            "id": id,
            "name": "",
            "at": mtime_ms(&path),
            "phase": phase,
        }));
        dirty = true;
    }
    if dirty {
        let _ = write_meta(home, pet_id, &entries);
    }
    entries.iter().map(catalog_entry).collect()
}

/// 读一条用户声音的字节；随包声音不在这里（它们在宠物目录里）。
pub fn read_sound(home: &Path, pet_id: &str, sound_id: &str) -> Option<(Vec<u8>, &'static str)> {
    if !valid_id(pet_id) || !valid_id(sound_id) {
        return None;
    }
    let entries = list(home, pet_id);
    let entry = entries
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(sound_id))?;
    let phase = entry.get("phase").and_then(Value::as_str);
    let bytes = std::fs::read(entry_path(home, pet_id, sound_id, phase)).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_AUDIO {
        return None;
    }
    let mime = sound_mime(&bytes)?;
    Some((bytes, mime))
}

fn new_sound_id(home: &Path, pet_id: &str) -> String {
    let mut salt = 0u64;
    loop {
        let seed = now_ms()
            .wrapping_mul(1_000_003)
            .wrapping_add(std::process::id() as u64)
            .wrapping_add(salt);
        let id = format!("u-{:012x}", seed & 0xffff_ffff_ffff);
        if !audio_path(home, pet_id, &id).exists() {
            return id;
        }
        salt = salt.wrapping_add(1);
    }
}

/// 新增一条用户声音。返回 catalog 形状的条目。
pub fn add(
    home: &Path,
    pet_id: &str,
    name: Option<&Value>,
    bytes: &[u8],
) -> Result<Value, &'static str> {
    if !valid_id(pet_id) {
        return Err("invalid-path");
    }
    if bytes.is_empty() || bytes.len() > MAX_AUDIO || sound_mime(bytes).is_none() {
        return Err("invalid-audio");
    }
    if list(home, pet_id).len() >= MAX_LIBRARY {
        return Err("too-many-sounds");
    }
    let id = new_sound_id(home, pet_id);
    write_audio(home, pet_id, &id, bytes).map_err(|_| "write-failed")?;
    let entry = json!({
        "id": id,
        "name": clean_name(name),
        "at": now_ms(),
    });
    let mut entries = read_meta(home, pet_id);
    entries.push(entry.clone());
    write_meta(home, pet_id, &entries).map_err(|_| "write-failed")?;
    Ok(catalog_entry(&entry))
}

/// 替换内容（id 与名字不变）。找不到返回 `Ok(None)`。
pub fn replace(
    home: &Path,
    pet_id: &str,
    sound_id: &str,
    bytes: &[u8],
) -> Result<Option<Value>, &'static str> {
    if !valid_id(pet_id) || !valid_id(sound_id) {
        return Ok(None);
    }
    if bytes.is_empty() || bytes.len() > MAX_AUDIO || sound_mime(bytes).is_none() {
        return Err("invalid-audio");
    }
    let entries = read_meta(home, pet_id);
    let Some(entry) = entries
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(sound_id))
    else {
        return Ok(None);
    };
    write_audio(
        home,
        pet_id,
        entry_file_id(sound_id, entry.get("phase").and_then(Value::as_str)),
        bytes,
    )
    .map_err(|_| "write-failed")?;
    Ok(Some(catalog_entry(entry)))
}

/// 改名（只影响用户声音；空名字允许，客户端会兜底）。
pub fn rename(home: &Path, pet_id: &str, sound_id: &str, name: Option<&Value>) -> Option<Value> {
    if !valid_id(pet_id) || !valid_id(sound_id) {
        return None;
    }
    let mut entries = read_meta(home, pet_id);
    let entry = entries
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(sound_id))?;
    let cleaned = clean_name(name);
    entry["name"] = Value::String(cleaned);
    let snapshot = entry.clone();
    write_meta(home, pet_id, &entries).ok()?;
    Some(catalog_entry(&snapshot))
}

/// 删除一条用户声音（文件 + 条目）。不存在返回 `false`。
pub fn delete(home: &Path, pet_id: &str, sound_id: &str) -> bool {
    if !valid_id(pet_id) || !valid_id(sound_id) {
        return false;
    }
    let entries = read_meta(home, pet_id);
    if !entries
        .iter()
        .any(|item| item.get("id").and_then(Value::as_str) == Some(sound_id))
    {
        return false;
    }
    let phase = entries
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(sound_id))
        .and_then(|item| item.get("phase"))
        .and_then(Value::as_str);
    let _ = std::fs::remove_file(entry_path(home, pet_id, sound_id, phase));
    let kept: Vec<Value> = entries
        .into_iter()
        .filter(|item| item.get("id").and_then(Value::as_str) != Some(sound_id))
        .collect();
    let _ = write_meta(home, pet_id, &kept);
    true
}
