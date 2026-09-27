// 构建期把两样东西交给编译器 `include_bytes!`：
//
//   1. **sidecar 独立二进制**（`binaries/pet-sidecar-*.exe`，由 deno compile 产出，
//      ~45–86MB）—— 单文件分发靠它；
//   2. **sidecar 的资源**（`sidecar/embed/`，插件宿主半区 + 随包宠物 + React + Cubism
//      Core + 页面，~5.5MB）—— 运行时解包到可写目录，sidecar 才能按文件系统扫描宠物。
//
// 为什么资源要壳来嵌、而不是只靠 sidecar 自己那份：壳必须先建好解包目录、把
// `PET_DESKTOP_EMBED` 指对，才能拉起 sidecar；sidecar 自己在启动时解包会和这一步打架。
//
// 清单（哪些文件、各自多大）在这里生成成 Rust 源码，因为 `include_bytes!` 只吃字面量
// 路径，没法在运行期拼。
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// 在 `dir` 下递归收集文件（相对路径用 `/` 分隔，与清单里一致）。
///
/// 目前只被 `copy_tree` 的调用方间接用到（开发期把 embed 拷进 target/），留着它是为了
/// 需要"自己列一遍目录"时不用再写一次——清单本身走 `read_manifest`。
#[allow(dead_code)]
fn collect(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if entry.path().is_dir() {
            collect(&entry.path(), &relative, out);
        } else {
            out.push(relative);
        }
    }
}

/// 从 `sidecar/embed-manifest.mjs` 读清单（与 sidecar 侧解包用的是同一份，避免两处不一致）。
fn read_manifest(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('"') {
            continue;
        }
        if let Some(end) = trimmed[1..].find('"') {
            out.push(trimmed[1..1 + end].to_string());
        }
    }
    out
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

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let desktop = manifest.parent().map(Path::to_path_buf).unwrap_or_else(|| manifest.clone());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());

    // ---- 1. sidecar 独立二进制 ----
    let sidecar_src = manifest.join("binaries").join("pet-sidecar-x86_64-pc-windows-msvc.exe");
    let sidecar_dst = out_dir.join("pet-sidecar-x86_64-pc-windows-msvc.exe");
    if sidecar_src.exists() {
        println!("cargo:rerun-if-changed={}", sidecar_src.display());
        if let Ok(bytes) = std::fs::copy(&sidecar_src, &sidecar_dst) {
            println!("cargo:warning=已嵌入 sidecar 独立二进制（{:.1} MB）", bytes as f64 / 1024.0 / 1024.0);
        }
    } else {
        println!("cargo:warning=没有编译好的 sidecar —— 壳会退回用 node 跑 sidecar/server.mjs（仅开发用，发布版必须跑 tools/build-sidecar.mjs）");
    }

    // ---- 2. sidecar 的资源（embed）----
    let embed_src = desktop.join("sidecar").join("embed");
    let files = read_manifest(&desktop.join("sidecar").join("embed-manifest.mjs"));
    let mut total = 0u64;
    let mut source = String::from("// 由 build.rs 生成：编译期嵌进壳的资源清单与字节。不要手改。\n");
    source.push_str("pub const EMBED_FILES: &[(&str, &[u8])] = &[\n");
    let mut listed = 0usize;
    for relative in &files {
        let path = embed_src.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !path.exists() {
            // 清单里有、磁盘上没有：说明 embed 过期了。跳过并在下面统一提示。
            continue;
        }
        total += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // include_bytes! 要的是**绝对路径**字面量（build.rs 的 cwd 是 src-tauri）。
        let _ = writeln!(
            source,
            "    ({:?}, include_bytes!({:?})),",
            relative,
            path.to_string_lossy().replace('\\', "/")
        );
        listed += 1;
    }
    source.push_str("];\n");
    std::fs::write(out_dir.join("embed_files.rs"), source).expect("写 embed_files.rs 失败");

    // 清单与磁盘不一致时明确报出来 —— 否则症状是"打包后少了几个文件"，很难查。
    if listed != files.len() {
        println!(
            "cargo:warning=embed 清单 {} 条，实际嵌入 {} 条 —— 跑一次 node tools/prep-embed.mjs 再构建",
            files.len(),
            listed
        );
    }
    if listed > 0 {
        println!("cargo:warning=已嵌入 sidecar 资源 {listed} 个文件（{:.1} MB）", total as f64 / 1024.0 / 1024.0);
    } else {
        println!("cargo:warning=没有可嵌入的资源 —— 先跑 node tools/prep-embed.mjs");
    }

    // 开发期把 embed 也拷一份到 target/<profile>/embed/：不打包时壳直接读磁盘上的那份，
    // 省掉每次启动解包 5MB 的开销（发布版走 include_bytes!）。
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let dev_embed = manifest.join("target").join(&profile).join("embed");
    if embed_src.exists() {
        let _ = copy_tree(&embed_src, &dev_embed);
    }

    tauri_build::build()
}
