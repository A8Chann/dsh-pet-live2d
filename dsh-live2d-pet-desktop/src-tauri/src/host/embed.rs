// 编译期嵌进来的资源：查表读出来。
//
// 表本身由 `build.rs` 生成（`OUT_DIR/embed_files.rs`）——`include_bytes!` 只吃字面量
// 路径，没法在运行期拼，所以清单必须在构建期定下来。
mod table {
    include!(concat!(env!("OUT_DIR"), "/embed_files.rs"));
}

/// 按名字取一份内嵌资源（`page/runtime.js`、`client.js`、`vendor.js`、`plugin/pets/...`）。
pub fn get(name: &str) -> Option<&'static [u8]> {
    table::EMBED
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, bytes)| *bytes)
}

/// 全部名字（诊断：`GET /__desktop/embed` 与"打包后少了什么"的排查）。
pub fn names() -> Vec<&'static str> {
    table::EMBED.iter().map(|(key, _)| *key).collect()
}

/// 名字与内容（解包、同步随包宠物时用）。
pub fn entries() -> impl Iterator<Item = (&'static str, &'static [u8])> {
    table::EMBED.iter().map(|(key, bytes)| (*key, *bytes))
}

/// 名字与大小（排查时一眼看出哪份资源没进来）。
pub fn listing() -> Vec<(&'static str, usize)> {
    table::EMBED.iter().map(|(key, bytes)| (*key, bytes.len())).collect()
}

/// 资源总数与总字节数。
pub fn totals() -> (usize, usize) {
    table::EMBED
        .iter()
        .fold((0usize, 0usize), |(count, bytes), (_, data)| {
            (count + 1, bytes + data.len())
        })
}

/// 解包是否已经做过（用"随包宠物目录里有没有 pet.json"判断，比写标记文件更直观）。
pub fn plugin_extracted(target: &std::path::Path) -> bool {
    entries().any(|(name, _)| {
        name.starts_with("plugin/pets/") && name.ends_with("/pet.json") && {
            let relative = name.trim_start_matches("plugin/");
            target
                .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
                .is_file()
        }
    })
}
