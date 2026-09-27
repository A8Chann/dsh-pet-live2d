// 宿主半区：宠物目录扫描 → catalog JSON。
//
// **这是 `dsh-live2d-pet/lib/index.js` 的 Rust 版**，逐字段对齐（字段名、默认值、
// 省略规则、URL 形状）。为什么敢翻：对拍有依据 —— `tools/probe-catalog.mjs` 同时跑
// JS 版与 Rust 版，把两份 catalog 逐字段比，不相等就红。所以"翻错了"会立刻暴露，
// 而不是等用户发现装扮少了一个槽位。
//
// 几条从 JS 版抄过来的规矩，别"顺手优化"：
//
//   * 字段**缺省即省略**（`requires`/`clears`/`sweep`/`conflicts`/`pairs`/`breaks`/
//     `fidget`/`fidgetWeight`/`fidgetNone`）——浏览器半区用 `??` 与 `undefined` 判存在，
//     多发一个空数组会让它走进不同的分支。
//   * 选项的 `label` 缺省时取**第一个表达式名**，没有表达式就取动作名。
//   * 槽位没有可用选项就整个丢掉（`continue`），不是留一个空槽。
//   * 动作时长取 `Meta.Duration * 1000` 四舍五入；`Loop` 必须是 `true` 才算循环
//     （不是"非 false"）。
//   * 动作/表情的 `params` 是**清理用**的：一次性动作结束后要把它写过的参数还回去，
//     漏了就出现"泡泡吹完嘴没还原"。
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// 浏览器面向的 API 前缀（资产 URL 就长在里面）。
pub const API: &str = "/api/live2d-pet";

/// 部件名里带这些字算"头"（作者在 cdi3 里给部件起了中文名）。
const HEAD_HINTS: &[&str] = &[
    "头", "脸", "面", "眼", "眉", "嘴", "耳", "发", "eye", "face", "hair", "head", "ear", "brow",
    "mouth", "cheek", "nose",
];
/// 名字里带这些字算"尾巴/翅膀"（都是可换的配件，同一时刻只有一个显形）。
const TAIL_HINTS: &[&str] = &["尾", "鳍", "翅", "翼", "fin", "tail", "wing"];

/// 随包宠物 `pet.json` 的**历史内容指纹**（SHA-256），一份一行。
///
/// 只为一件事存在：认出"用户宠物目录里那份是我们某一次发出去的原样副本"。认出来才敢
/// 升级，认不出来就一个字都不碰。与 `lib/index.js` 里的表**必须一致**（改随包宠物时
/// 两边一起补）。
pub const BUNDLED_PET_HASHES: &[(&str, &[&str])] = &[(
    "ds-whale-girl",
    &[
        // ef7fb1a：模型第一次随包分发（1.0.x，17 个槽位、5 个相位）
        "5421dee9d13ee60b91c341ab515bbef3fb8702a9791279c9a2f61124d4478b34",
        // 3f18b195：面板跟随宿主主题 + 自拍可配置
        "707049e3b8a05f3de5ddd49299bcb47fdd2ac1494209b7c710c1371be718bb27",
        // 9b62d727：自拍独立成槽、氛围拆三个、摸鱼不再擦掉手选
        "071a7bfe18b4882703a43f8a14dc7eded8d5aa08671dc3ecc4db220258e5be23",
        // 6c6b61e1（2.0.0）：把作者调好的值烘成宠物默认
        "e931e44a6589932688d7507b0d5e62ba4c0f9618492ec7fe644885117e61f12a",
        // 4b594ed3（2.2.0）：多接三个会话状态
        "88b86f32833882893e8ec10a9320bb4d9899a0211811d5a96544e4b97b804234",
        // 25c4d285（2.3.0 前）：台词 / 反应候选 / 摸鱼槽位
        "18840cd90fe70aa68632c45f77b4af1254595b5f963d261d2cbf34f6fbcaf579",
        // 1.0.1（2.3.0 ~ 2.3.2 随包的那份）：内容与上面那条相同，只是换了插件版本号
        "7c6cdb9c9f3d92636c388bffb3229c439cf01a65fe6a8a88499a8e4071f7884a",
    ],
)];

/// 同步记录：哪个宠物是我们装的、装的是哪一版、装下去那份长什么样。
const SYNC_RECORD: &str = ".synced.json";

/// 扫出来的一只宠物：JSON 给浏览器，闭包给资产路由。
pub struct PetEntry {
    pub dir: PathBuf,
    /// 资产路由的**白名单**：模型文件自己 + 它引用到的每个文件（相对路径）。
    pub closure: BTreeSet<String>,
    pub json: Value,
}

impl PetEntry {
    pub fn id(&self) -> &str {
        self.json.get("id").and_then(Value::as_str).unwrap_or("")
    }
}

pub fn read_json(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

/// 安全的相对路径：不要绝对路径、不要反斜杠、不要穿越、每段只允许 `[A-Za-z0-9._-]`。
///
/// 这条同时是**资产路由的白名单来源**：闭包里的路径全从模型文件里读出来，再逐段校验，
/// 所以构造出来的 `..` 段永远进不了闭包。
pub fn safe_rel(raw: &Value) -> Option<String> {
    let value = raw.as_str()?.trim();
    if value.is_empty() || value.contains('\\') || value.starts_with('/') {
        return None;
    }
    // 形如 `C:` 的盘符/协议前缀一律拒绝。
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let mut segments = Vec::new();
    for segment in value.split('/') {
        if segment.is_empty() {
            continue;
        }
        if segment == "." || segment == ".." {
            return None;
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return None;
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        None
    } else {
        Some(segments.join("/"))
    }
}

fn push_ref(out: &mut BTreeSet<String>, raw: &Value) {
    if let Some(safe) = safe_rel(raw) {
        out.insert(safe);
    }
}

/// 一个 model3.json 的引用闭包 —— 资产路由**只**服务这些文件。
pub fn model_closure(model3: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Some(refs) = model3.get("FileReferences").and_then(Value::as_object) else {
        return out;
    };
    if let Some(moc) = refs.get("Moc") {
        push_ref(&mut out, moc);
    }
    if let Some(textures) = refs.get("Textures").and_then(Value::as_array) {
        for texture in textures {
            push_ref(&mut out, texture);
        }
    }
    for key in ["Physics", "Pose", "DisplayInfo", "UserData"] {
        if let Some(value) = refs.get(key) {
            push_ref(&mut out, value);
        }
    }
    if let Some(expressions) = refs.get("Expressions").and_then(Value::as_array) {
        for expression in expressions {
            if let Some(file) = expression.get("File") {
                push_ref(&mut out, file);
            }
        }
    }
    if let Some(motions) = refs.get("Motions").and_then(Value::as_object) {
        for list in motions.values() {
            let Some(list) = list.as_array() else { continue };
            for motion in list {
                if let Some(file) = motion.get("File") {
                    push_ref(&mut out, file);
                }
            }
        }
    }
    out
}

/// 字符串数组（去重、保序、丢掉非字符串与空白）。
fn clean_strings(raw: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(list) = raw.and_then(Value::as_array) else {
        return out;
    };
    for item in list {
        let Some(text) = item.as_str() else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() || out.iter().any(|seen| seen == trimmed) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

/// 表达式名列表：接受 `expressions: [..]` 或 `expression: "x"` 两种写法。
fn option_expressions(option: &Map<String, Value>) -> Vec<String> {
    let raw: Vec<Value> = match option.get("expressions") {
        Some(Value::Array(list)) => list.clone(),
        _ => match option.get("expression").and_then(Value::as_str) {
            Some(name) => vec![Value::String(name.to_string())],
            None => Vec::new(),
        },
    };
    let mut out: Vec<String> = Vec::new();
    for item in raw {
        let Some(text) = item.as_str() else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() || out.iter().any(|seen| seen == trimmed) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

/// 程序化扫描（sweep）：模型自己没动画的参数，由插件每帧生成曲线去驱动。
fn normalise_sweep(raw: Option<&Value>) -> Option<Value> {
    let object = raw?.as_object()?;
    let mut axes = Map::new();
    for key in ["x", "y", "z", "rz"] {
        if let Some(text) = object.get(key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                axes.insert(key.to_string(), Value::String(trimmed.to_string()));
            }
        }
    }
    if axes.is_empty() {
        return None;
    }
    let num = |key: &str, fallback: f64| object.get(key).and_then(Value::as_f64).unwrap_or(fallback);
    for (key, value) in [
        ("ampX", num("ampX", 16.0)),
        ("ampY", num("ampY", 8.0)),
        ("ampZ", num("ampZ", 6.0)),
        // 一圈走完的时长；笔不抬，路径自己闭合，才像"一直在写"。
        ("loopMs", num("loopMs", 2600.0)),
        // 可选的慢漂移，长时间循环不至于钉在一个点上。
        ("driftMs", num("driftMs", 0.0)),
        ("driftY", num("driftY", 0.0)),
    ] {
        axes.insert(key.to_string(), json!(value));
    }
    Some(Value::Object(axes))
}

/// 装扮槽位：一个槽位 = 一个互斥组。畸形的一律丢掉（浏览器半区直接把它们渲染成按钮）。
fn normalise_slots(raw: Option<&Value>) -> Vec<Value> {
    let Some(list) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for slot in list {
        let Some(slot) = slot.as_object() else { continue };
        let id = slot
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let mut options: Vec<Value> = Vec::new();
        if let Some(raw_options) = slot.get("options").and_then(Value::as_array) {
            for option in raw_options {
                let Some(option) = option.as_object() else { continue };
                let expressions = option_expressions(option);
                let motion = option
                    .get("motion")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string);
                let requires = clean_strings(option.get("requires"));
                let clears = clean_strings(option.get("clears"));
                let conflicts = clean_strings(option.get("conflicts"));
                let breaks = clean_strings(option.get("breaks"));
                let sweep = normalise_sweep(option.get("sweep"));
                // 一个表达式都不带、也没有动作与扫描 → 这个选项点了没反应，丢掉。
                if expressions.is_empty() && motion.is_none() && sweep.is_none() {
                    continue;
                }
                let mut pairs = Map::new();
                if let Some(map) = option.get("pairs").and_then(Value::as_object) {
                    for (slot_id, label) in map {
                        if let Some(label) = label.as_str() {
                            if !label.is_empty() {
                                pairs.insert(slot_id.clone(), Value::String(label.to_string()));
                            }
                        }
                    }
                }
                let label = option
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        expressions
                            .first()
                            .cloned()
                            .or_else(|| motion.clone())
                            .unwrap_or_default()
                    });
                let fidget_off = option.get("fidget").and_then(Value::as_bool) == Some(false);
                let fidget_weight = option
                    .get("fidgetWeight")
                    .and_then(Value::as_f64)
                    .filter(|value| *value > 0.0)
                    .unwrap_or(1.0);

                // 字段顺序与 JS 版一致；**缺省即省略**（见文件头的说明）。
                let mut entry = Map::new();
                entry.insert("label".into(), Value::String(label));
                entry.insert("expressions".into(), json!(expressions));
                if let Some(motion) = motion {
                    entry.insert("motion".into(), Value::String(motion));
                }
                if !requires.is_empty() {
                    entry.insert("requires".into(), json!(requires));
                }
                if !clears.is_empty() {
                    entry.insert("clears".into(), json!(clears));
                }
                if let Some(sweep) = sweep {
                    entry.insert("sweep".into(), sweep);
                }
                if !conflicts.is_empty() {
                    entry.insert("conflicts".into(), json!(conflicts));
                }
                if !pairs.is_empty() {
                    entry.insert("pairs".into(), Value::Object(pairs));
                }
                if !breaks.is_empty() {
                    entry.insert("breaks".into(), json!(breaks));
                }
                if fidget_off {
                    entry.insert("fidget".into(), Value::Bool(false));
                }
                if fidget_weight != 1.0 {
                    entry.insert("fidgetWeight".into(), json!(fidget_weight));
                }
                options.push(Value::Object(entry));
            }
        }
        if options.is_empty() {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(id.clone()));
        entry.insert(
            "label".into(),
            Value::String(
                slot.get("label")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or(&id)
                    .to_string(),
            ),
        );
        entry.insert(
            "none".into(),
            Value::String(
                slot.get("none")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("无")
                    .to_string(),
            ),
        );
        if let Some(fidget_none) = slot.get("fidgetNone").and_then(Value::as_f64) {
            if fidget_none > 0.0 {
                entry.insert("fidgetNone".into(), json!(fidget_none));
            }
        }
        entry.insert("options".into(), Value::Array(options));
        out.push(Value::Object(entry));
    }
    out
}

/// 找 cdi3.json：**它不在** model3.json 的引用里（那是编辑器元数据，运行时不读），
/// 所以只能按约定找 —— 与模型同名的优先，其次模型旁边，再其次宠物目录与它的直接子目录。
fn find_cdi3(dir: &Path, base: &str) -> Option<PathBuf> {
    for candidate in [
        dir.join(format!("{base}.cdi3.json")),
        dir.join("model").join(format!("{base}.cdi3.json")),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let mut roots = vec![dir.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() && entry.file_name() != "node_modules" {
                roots.push(entry.path());
            }
        }
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        // 同一目录里有多个 cdi3 时取**名字排序最小的那个**（JS 版的 readdir 顺序在
        // 不同文件系统上不一致，这里定死，好在同一份宠物目录下两者一致）。
        let mut hits: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().to_lowercase().ends_with(".cdi3.json"))
                    .unwrap_or(false)
            })
            .collect();
        hits.sort();
        if let Some(hit) = hits.into_iter().next() {
            return Some(hit);
        }
    }
    None
}

fn model_base(model_path: &str) -> &str {
    model_path.strip_suffix(".model3.json").unwrap_or(model_path)
}

fn matches_hints(text: &str, hints: &[&str]) -> bool {
    let lowered = text.to_lowercase();
    hints.iter().any(|hint| lowered.contains(&hint.to_lowercase()))
}

/// 从 cdi3 里按名字挑部件（摸头/摸尾巴要知道哪些 drawable 是头、是尾巴）。
fn parts_matching(dir: &Path, model_path: &str, hints: &[&str]) -> Vec<String> {
    let Some(file) = find_cdi3(dir, model_base(model_path)) else {
        return Vec::new();
    };
    let Some(parts) = read_json(&file).and_then(|cdi3| cdi3.get("Parts").cloned()) else {
        return Vec::new();
    };
    let Some(parts) = parts.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for part in parts {
        let Some(id) = part.get("Id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let name = part.get("Name").and_then(Value::as_str).unwrap_or("");
        if matches_hints(name, hints) || matches_hints(id, hints) {
            out.push(id.to_string());
        }
    }
    out
}

/// 部件 id → 作者给的中文名（诊断用）。
fn part_names(dir: &Path, model_path: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(file) = find_cdi3(dir, model_base(model_path)) else {
        return out;
    };
    let Some(parts) = read_json(&file).and_then(|cdi3| cdi3.get("Parts").cloned()) else {
        return out;
    };
    let Some(parts) = parts.as_array() else {
        return out;
    };
    for part in parts {
        let (Some(id), Some(name)) = (
            part.get("Id").and_then(Value::as_str),
            part.get("Name").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !name.is_empty() {
            out.insert(id.to_string(), Value::String(name.to_string()));
        }
    }
    out
}

fn reaction_list(raw: Option<&Value>) -> Vec<String> {
    raw.and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn object_or_empty(raw: Option<&Value>) -> Value {
    match raw {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => json!({}),
    }
}

fn string_array(raw: Option<&Value>) -> Vec<String> {
    raw.and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 扫一只宠物目录；返回 JSON 与资产白名单。
pub fn scan_pet(dir: &Path, id: &str) -> Option<PetEntry> {
    let manifest = read_json(&dir.join("pet.json"))?;
    if manifest.get("renderer").and_then(Value::as_str) != Some("live2d") {
        return None;
    }
    let block = manifest.get("live2d")?.as_object()?;
    let model_path = safe_rel(block.get("model").unwrap_or(&Value::Null))?;
    if !model_path.ends_with(".model3.json") {
        return None;
    }
    let model_file = dir.join(model_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !model_file.is_file() {
        return None;
    }
    let model3 = read_json(&model_file)?;
    let mut closure = model_closure(&model3);
    if closure.is_empty() {
        return None;
    }
    // 模型描述自己也走同一条路由：浏览器先取它，再取它点名的每个文件。
    closure.insert(model_path.clone());

    let labels = read_json(&dir.join("catalog.json")).unwrap_or(Value::Null);
    let label_for = |kind: &str, key: &str| -> Option<Value> {
        let list = labels.get(kind)?.as_array()?;
        list.iter()
            .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
            .cloned()
    };

    // 每条动作都带上自己的时长与循环标记 —— 浏览器半区两样都要：引擎拒绝重启仍在
    // 播放的 组+序号，而标了 Loop 的动作永远不会发 motionFinish。
    //
    // ⚠️ `motions` 必须声明在 `if let` **外面**：JS 是函数作用域，写在块里没问题；
    // Rust 是块作用域，写在块里出了块就没了 —— 下面的 json! 会直接少掉这个字段。
    // 这个坑在对拍里表现为"motions 整段缺失"，比"内容不对"更难一眼看出来。
    let mut motions = Vec::new();
    if let Some(motion_groups) = model3
        .get("FileReferences")
        .and_then(|refs| refs.get("Motions"))
        .and_then(Value::as_object)
    {
        for (group, list) in motion_groups {
            let Some(list) = list.as_array() else { continue };
            if list.is_empty() {
                continue;
            }
            let meta = label_for("motions", group);
            let mut items = Vec::new();
            for (index, entry) in list.iter().enumerate() {
                let file = safe_rel(entry.get("File").unwrap_or(&Value::Null));
                let motion_meta = file.as_ref().and_then(|rel| {
                    read_json(&dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
                });
                let raw_duration = motion_meta
                    .as_ref()
                    .and_then(|meta| meta.get("Meta"))
                    .and_then(|meta| meta.get("Duration"))
                    .and_then(Value::as_f64);
                // 这个动作写过的**每一个**参数：一次性动作结束后要靠它把值还回去。
                let mut params: Vec<String> = Vec::new();
                if let Some(curves) = motion_meta
                    .as_ref()
                    .and_then(|meta| meta.get("Curves"))
                    .and_then(Value::as_array)
                {
                    for curve in curves {
                        if curve.get("Target").and_then(Value::as_str) != Some("Parameter") {
                            continue;
                        }
                        if let Some(pid) = curve.get("Id").and_then(Value::as_str) {
                            if !pid.is_empty() {
                                params.push(pid.to_string());
                            }
                        }
                    }
                }
                let duration = match raw_duration {
                    Some(value) if value > 0.0 => (value * 1000.0).round() as i64,
                    _ => 0,
                };
                let is_loop = motion_meta
                    .as_ref()
                    .and_then(|meta| meta.get("Meta"))
                    .and_then(|meta| meta.get("Loop"))
                    .and_then(Value::as_bool)
                    == Some(true);
                items.push(json!({
                    "index": index,
                    "duration": duration,
                    "loop": is_loop,
                    "params": params,
                }));
            }
            motions.push(json!({
                "group": group,
                "count": items.len(),
                "label": meta.as_ref().and_then(|m| m.get("label")).and_then(Value::as_str).unwrap_or(group),
                "category": meta.as_ref().and_then(|m| m.get("category")).and_then(Value::as_str).unwrap_or("action"),
                "items": items,
            }));
        }
    }

    // 同上：`expressions` 也要在块外声明（块作用域，见 motions 那段说明）。
    let mut expressions = Vec::new();
    if let Some(refs) = model3
        .get("FileReferences")
        .and_then(|refs| refs.get("Expressions"))
        .and_then(Value::as_array)
    {
        for reference in refs {
            let file = safe_rel(reference.get("File").unwrap_or(&Value::Null));
            let name = match reference.get("Name").and_then(Value::as_str) {
                Some(name) if !name.is_empty() => name.to_string(),
                _ => match &file {
                    Some(file) => file.clone(),
                    None => continue,
                },
            };
            let meta = label_for("expressions", &name);
            // 把表达式自己写的参数一并发出去：引擎那条管线加载得对但一个参数都不动，
            // 所以浏览器半区自己按这些值去写参数。
            let mut params = Vec::new();
            if let Some(rel) = &file {
                if let Some(parsed) =
                    read_json(&dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
                {
                    if let Some(list) = parsed.get("Parameters").and_then(Value::as_array) {
                        for parameter in list {
                            let Some(pid) = parameter.get("Id").and_then(Value::as_str) else {
                                continue;
                            };
                            if pid.is_empty() {
                                continue;
                            }
                            let Some(value) = parameter.get("Value").and_then(Value::as_f64) else {
                                continue;
                            };
                            let blend = match parameter.get("Blend").and_then(Value::as_str) {
                                Some("Multiply") => "Multiply",
                                Some("Overwrite") => "Overwrite",
                                _ => "Add",
                            };
                            params.push(json!({ "id": pid, "value": value, "blend": blend }));
                        }
                    }
                }
            }
            expressions.push(json!({
                "name": name,
                "label": meta.as_ref().and_then(|m| m.get("label")).and_then(Value::as_str).unwrap_or(&name),
                "category": meta.as_ref().and_then(|m| m.get("category")).and_then(Value::as_str).unwrap_or("other"),
                "file": file.clone().unwrap_or_default(),
                "params": params,
            }));
        }
    }

    let scale = block
        .get("scale")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0 && *value <= 10.0)
        .unwrap_or(1.0);
    let translate = block.get("translate").and_then(Value::as_object);
    let model_url = format!(
        "{API}/asset/{}/{}",
        urlencode(id),
        model_path
            .split('/')
            .map(urlencode)
            .collect::<Vec<_>>()
            .join("/")
    );

    let mut value = json!({
        "id": id,
        "displayName": manifest.get("displayName").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or(id),
        "description": manifest.get("description").and_then(Value::as_str).unwrap_or(""),
        "scale": scale,
        "motionsByPhase": object_or_empty(block.get("motions")),
        "motionOptions": object_or_empty(block.get("motionOptions")),
        "expressionsByPhase": object_or_empty(block.get("expressions")),
        "expressionSlots": normalise_slots(block.get("expressionSlots")),
        "looksByPhase": object_or_empty(block.get("looksByPhase")),
        "motionGuards": object_or_empty(block.get("motionGuards")),
        "headParts": parts_matching(dir, &model_path, HEAD_HINTS),
        "tailParts": parts_matching(dir, &model_path, TAIL_HINTS),
        "partNames": Value::Object(part_names(dir, &model_path)),
        "lines": object_or_empty(block.get("lines")),
        "patReactions": reaction_list(block.get("patReactions")),
        "tailReactions": reaction_list(block.get("tailReactions")),
        "spinReactions": reaction_list(block.get("spinReactions")),
        "fidgetSlots": string_array(block.get("fidgetSlots")),
        "hiddenMotions": string_array(block.get("hiddenMotions")),
        "translate": {
            "x": translate.and_then(|t| t.get("x")).and_then(Value::as_f64).unwrap_or(0.0),
            "y": translate.and_then(|t| t.get("y")).and_then(Value::as_f64).unwrap_or(0.0),
        },
        "modelUrl": model_url,
    });

    // 动作与表情**手工插键**，不走上面那个 `json!`。
    //
    // 踩过：把它们写在 `json!` 里时，整个字段会**静默消失**（两份 Vec 明明有内容、
    // 同一个宏里别的字段都在）。症状是"动作菜单和装扮少了整段"，而且只在打开面板时
    // 才看得出来。手工 insert 之后行为确定，也不再依赖宏怎么展开这两个标识符。
    if let Some(map) = value.as_object_mut() {
        map.insert("motions".to_string(), Value::Array(motions));
        map.insert("expressions".to_string(), Value::Array(expressions));
    }

    Some(PetEntry {
        dir: dir.to_path_buf(),
        closure,
        json: value,
    })
}

/// `encodeURIComponent` 的等价物：保留 `A-Za-z0-9-_.!~*'()`，其余按 UTF-8 逐字节转义。
pub fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 扫一遍宠物根目录（字典序，与 JS 版一致）。
pub fn build_catalog(pets_root: &Path) -> Vec<PetEntry> {
    let Ok(entries) = std::fs::read_dir(pets_root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    let mut pets = Vec::new();
    for name in names {
        let dir = pets_root.join(&name);
        if !dir.is_dir() {
            continue;
        }
        if let Some(entry) = scan_pet(&dir, &name) {
            pets.push(entry);
        }
    }
    pets
}

/// 打一份 pets 目录里的 `.synced.json`。
fn read_sync_record(pets_root: &Path) -> Map<String, Value> {
    read_json(&pets_root.join(SYNC_RECORD))
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn sha256_file(file: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(file).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(format!("{:x}", hasher.finalize()))
}

/// 点分版本比较：`1.1.0 > 1.0.1`；非数字段只取数字部分。
pub fn compare_versions(a: &str, b: &str) -> i64 {
    let parts = |raw: &str| -> Vec<i64> {
        raw.split('.')
            .map(|piece| {
                let digits: String = piece.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<i64>().unwrap_or(0)
            })
            .collect()
    };
    let left = parts(a);
    let right = parts(b);
    for index in 0..left.len().max(right.len()) {
        let one = left.get(index).copied().unwrap_or(0);
        let two = right.get(index).copied().unwrap_or(0);
        if one != two {
            return if one > two { 1 } else { -1 };
        }
    }
    0
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn is_pristine_bundled(pet_id: &str, manifest: &Path) -> bool {
    let Some(hash) = sha256_file(manifest) else {
        return false;
    };
    BUNDLED_PET_HASHES
        .iter()
        .find(|(id, _)| *id == pet_id)
        .map(|(_, hashes)| hashes.contains(&hash.as_str()))
        .unwrap_or(false)
}

/// 把随包宠物装进用户的宠物目录，并在**确实是我们装的那份**过期时更新它。
///
/// 三条判定，缺一条都会变成"静默覆盖用户数据"：
///   1. 目标不存在 → 装一份（并把版本与内容指纹记进 `pets/.synced.json`）；
///   2. 目标就是我们上次装下去的那一份（内容指纹对得上）→ 整份更新；
///   3. 用户动过（指纹对不上）→ **一个字都不碰**。
///
/// 返回要打印的日志行。
pub fn install_bundled_pets(bundled_root: &Path, pets_root: &Path) -> Vec<String> {
    let mut notes = Vec::new();
    let Ok(entries) = std::fs::read_dir(bundled_root) else {
        return notes;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    let mut record = read_sync_record(pets_root);
    let mut dirty = false;
    for name in names {
        let source = bundled_root.join(&name);
        let target = pets_root.join(&name);
        if !source.is_dir() {
            continue;
        }
        let manifest = source.join("pet.json");
        if !manifest.is_file() {
            continue;
        }
        let version = read_json(&manifest)
            .and_then(|value| value.get("version").cloned())
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_default();
        let target_manifest = target.join("pet.json");
        let local_version = || {
            read_json(&target_manifest)
                .and_then(|value| value.get("version").cloned())
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "?".to_string())
        };

        if !target.exists() {
            if std::fs::create_dir_all(pets_root).is_err() || copy_tree(&source, &target).is_err() {
                continue;
            }
            if let Some(hash) = sha256_file(&target_manifest) {
                record.insert(name.clone(), json!({ "version": version, "hash": hash }));
                dirty = true;
            }
            continue;
        }

        let same = sha256_file(&target_manifest);
        let ours = record
            .get(&name)
            .and_then(|entry| entry.get("hash"))
            .and_then(Value::as_str)
            .map(|known| Some(known.to_string()) == same)
            .unwrap_or(false)
            || is_pristine_bundled(&name, &target_manifest);
        if !ours {
            // 用户自己改过：不动它。**要说出来** —— 沉默地不升级，用户看到的是
            // "插件更新了但没有任何变化"，比报错更难查。
            if compare_versions(&version, &local_version()) > 0 {
                notes.push(format!(
                    "{name}：宠物目录里这份被改过，跳过更新（随包版本 {version}，本地 {}）",
                    local_version()
                ));
            }
            continue;
        }
        // **升级与否只看内容**，不看版本号：版本号是宠物自己声明的，随包那份在同一个
        // 版本号下改过（补默认值就是这么发生的）。
        let bundled_hash = sha256_file(&manifest);
        if same.is_some() && same == bundled_hash {
            continue;
        }
        // 「原先」那个版本号要在覆盖之前读。
        let was = local_version();
        if copy_tree(&source, &target).is_err() {
            continue;
        }
        if let Some(hash) = bundled_hash {
            record.insert(name.clone(), json!({ "version": version, "hash": hash }));
            dirty = true;
        }
        notes.push(format!("{name}：宠物默认值更新到 {version}（原先 {was}）"));
    }
    if dirty {
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(record)) {
            let _ = std::fs::write(pets_root.join(SYNC_RECORD), text + "\n");
        }
    }
    notes
}

/// 把 catalog 转成 HTTP 响应的形状（`{ok, coreUrl, vendorUrl, pets: [...]}`）。
pub fn catalog_response(pets: &[PetEntry], core_url: &str, vendor_url: &str) -> Value {
    json!({
        "ok": true,
        "coreUrl": core_url,
        "vendorUrl": vendor_url,
        "pets": pets.iter().map(|pet| pet.json.clone()).collect::<Vec<_>>(),
    })
}
