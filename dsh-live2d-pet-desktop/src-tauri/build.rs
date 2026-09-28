// 构建期把要嵌进 exe 的资源铺成 Rust 源码。
//
// 嵌两样东西：
//
//   1. **插件宿主半区与随包宠物**（`dsh-live2d-pet/`）—— 宠物发现要按文件系统扫，
//      所以运行时会解包到可写目录；
//   2. **页面与浏览器半区**（`sidecar/page/*`、`lib/client.js`、`lib/live2d-vendor.js`、
//      React UMD、Cubism Core）—— 服务器直接从内存发出去，**不解包**（页面是只读的）。
//
// `include_bytes!` 只吃**字面量路径**，没法在运行期拼，所以清单必须在这里生成成源码。
// 谁改了页面/客户端却忘了重新构建，构建时会因为文件变新而重跑（下面每个文件都
// `rerun-if-changed`）。
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// 读取待嵌入文件清单（`<stem>|<相对路径>` → 从嵌入根取的相对路径）。
struct Asset {
    /// 嵌进二进制后的名字（HTTP 路由按它取）。
    name: String,
    /// 磁盘上的绝对路径。
    path: PathBuf,
}

fn read(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let desktop = manifest.parent().map(Path::to_path_buf).unwrap_or_else(|| manifest.clone());
    let repo = desktop.parent().map(Path::to_path_buf).unwrap_or_else(|| desktop.clone());
    let plugin = repo.join("dsh-live2d-pet");
    let page_dir = desktop.join("sidecar").join("page");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default());

    let mut assets: Vec<Asset> = Vec::new();
    let mut push = |name: &str, path: PathBuf, assets: &mut Vec<Asset>| {
        if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            assets.push(Asset { name: name.to_string(), path });
        } else {
            println!("cargo:warning=缺少内嵌资源 {}（{}）", name, path.display());
        }
    };

    // ---- 浏览器半区与运行时 ----
    push("client.js", plugin.join("lib").join("client.js"), &mut assets);
    push("vendor.js", plugin.join("lib").join("live2d-vendor.js"), &mut assets);
    // 页面：外层 index/spike + /page/* 下的一切（runtime.js / desktop.js / boot.js / hover.js）
    for name in ["index.html", "spike.html"] {
        push(&format!("page/{name}"), page_dir.join(name), &mut assets);
    }
    for entry in std::fs::read_dir(&page_dir).into_iter().flatten().flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.ends_with(".js") {
            continue;
        }
        push(&format!("page/{file_name}"), entry.path(), &mut assets);
    }
    // React UMD：与 DSH 客户端同一个版本；生产版优先（139KB vs 1.16MB）。
    let react_dir = repo.join("tools").join("browser-test").join("node_modules");
    for (name, candidates) in [
        (
            "react.js",
            vec![
                react_dir.join("react").join("umd").join("react.production.min.js"),
                react_dir.join("react").join("umd").join("react.development.js"),
            ],
        ),
        (
            "react-dom.js",
            vec![
                react_dir.join("react-dom").join("umd").join("react-dom.production.min.js"),
                react_dir.join("react-dom").join("umd").join("react-dom.development.js"),
            ],
        ),
    ] {
        if let Some(hit) = candidates.into_iter().find(|candidate| candidate.is_file()) {
            push(name, hit, &mut assets);
        } else {
            println!("cargo:warning=找不到 React UMD（先在 tools/browser-test 里 npm install）");
        }
    }
    // Cubism Core：Live2D 株式会社的专有运行时，**不随包分发**；这里嵌的是本机已经
    // 缓存过的那一份（插件自己从官方 CDN 取回来缓存的），只是为了离线可用。
    let core = std::env::var("USERPROFILE")
        .map(|home| PathBuf::from(home).join(".dsh").join("pets").join(".runtime").join("live2dcubismcore.min.js"))
        .unwrap_or_default();
    if core.is_file() {
        println!("cargo:warning=内嵌 Cubism Core（{}）", core.display());
        push("live2dcubismcore.min.js", core, &mut assets);
    } else {
        println!("cargo:warning=本机没有缓存过 Cubism Core —— 第一次运行会去官方 CDN 取一份");
    }

    // ---- 随包宠物（要解包到磁盘，宿主半区按文件系统扫）----
    // 目录结构必须与真包一致（`lib/` 与 `pets/` 是兄弟），因为插件宿主半区是按这个
    // 相对位置找 `pets/` 的。桌宠现在运行的是自己的 Rust 实现，但保持同样的布局能让
    // "同一份补丁"两条路都成立。
    let bundled_pets = plugin.join("pets");
    let mut pet_files = 0usize;
    if bundled_pets.is_dir() {
        let mut listing: Vec<(String, PathBuf)> = Vec::new();
        walk(&bundled_pets, "", &mut listing);
        listing.sort();
        for (relative, path) in listing {
            println!("cargo:rerun-if-changed={}", path.display());
            assets.push(Asset {
                name: format!("plugin/pets/{relative}"),
                path,
            });
            pet_files += 1;
        }
    }

    // ---- 生成源码 ----
    let mut source = String::from(
        "// 由 build.rs 生成：编译期嵌进 exe 的资源。不要手改。\n\
         pub static EMBED: &[(&str, &[u8])] = &[\n",
    );
    let mut total = 0u64;
    for asset in &assets {
        let Some(bytes) = read(&asset.path) else { continue };
        total += bytes.len() as u64;
        let _ = writeln!(
            source,
            "    ({:?}, include_bytes!({:?})),",
            asset.name,
            asset.path.to_string_lossy().replace('\\', "/")
        );
    }
    source.push_str("];\n");
    std::fs::write(out_dir.join("embed_files.rs"), source).expect("写 embed_files.rs 失败");

    println!(
        "cargo:warning=已嵌入资源 {} 个文件（{:.2} MB，其中随包宠物 {} 个）",
        assets.len(),
        total as f64 / 1024.0 / 1024.0,
        pet_files
    );
    println!("cargo:rerun-if-changed={}", plugin.join("pets").display());
    println!("cargo:rerun-if-changed={}", page_dir.display());

    tauri_build::build()
}

/// 递归收集目录下的文件（相对路径用 `/` 分隔）。
fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            walk(&path, &relative, out);
        } else {
            out.push((relative, path));
        }
    }
}
