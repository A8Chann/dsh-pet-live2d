// sidecar 的生命周期。
//
// 两种形态，同一个接口：
//
//   * **发布版**：sidecar 是编译期嵌进 exe 的独立二进制（deno compile，见
//     `tools/build-sidecar.mjs`），启动时解包到 `%LOCALAPPDATA%\<id>\runtime\` 再拉起。
//     这就是"单文件 exe"的全部秘密——用户机器上不需要 node。
//   * **开发版**：没有内嵌 sidecar 时退回 `node sidecar/server.mjs`，改 JS 立刻生效。
//
// 为什么保留 Node 那一版而不是把宿主半区翻成 Rust：`lib/index.js` 里的宠物发现、
// pet.json 归一化、模型引用闭包、随包宠物按内容指纹同步，是修过好几个 bug、有回归
// 测试的逻辑。deno compile 把它连同 Node 兼容层一起编成一个 exe —— **JS 一行不改**，
// 宠物行为与网页端天然一致。
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

/// 编译期嵌进来的 sidecar 资源（插件宿主半区 + 随包宠物 + React + Cubism Core + 页面）。
mod embed_files {
    include!(concat!(env!("OUT_DIR"), "/embed_files.rs"));
}

/// 编译期嵌进来的独立二进制。没编 sidecar 时是个零长数组（`tools/build-sidecar.mjs` 没跑过）。
const EMBEDDED_SIDECAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pet-sidecar-x86_64-pc-windows-msvc.exe"));

#[derive(Debug, Clone, Deserialize)]
pub struct Handshake {
    pub ok: bool,
    pub url: String,
    #[allow(dead_code)]
    pub port: u16,
    #[allow(dead_code)]
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub pid: u32,
    /// sidecar 自己报的形态（诊断用：确认跑的是内嵌那份还是 node）。
    #[serde(default)]
    pub published: bool,
}

pub struct Sidecar {
    pub url: String,
    pub pid: u32,
    /// 跑的是不是内嵌的独立二进制（= 发布形态）。
    pub published: bool,
    child: Child,
    /// 一直握着 stdin：进程活着时不让它读到 EOF（sidecar 拿 EOF 当"壳没了"的信号）。
    _stdin: Option<ChildStdin>,
}

/// 仓库布局：<root>/dsh-live2d-pet-desktop/src-tauri/src/sidecar.rs
fn desktop_dir() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.pop(); // src-tauri
    dir
}

pub fn has_embedded_sidecar() -> bool {
    EMBEDDED_SIDECAR.len() > 4096
}

/// 把编译期嵌进来的资源解包到 `target`（版本没变就跳过）。
///
/// 解包必须在**壳**里做：壳要先建好目录、把 `PET_DESKTOP_EMBED` 指对，才能拉起 sidecar。
/// 两边各解一次会互相踩（sidecar 那份清单与这边是同一个来源，见 build.rs）。
fn extract_embed(target: &Path) -> Result<usize, String> {
    let stamp = target.join(".unpacked");
    let marker = format!("{}|{}", embed_files::EMBED_FILES.len(), EMBEDDED_SIDECAR.len());
    if std::fs::read_to_string(&stamp).map(|old| old == marker).unwrap_or(false) {
        return Ok(0);
    }
    let mut written = 0usize;
    for (relative, bytes) in embed_files::EMBED_FILES {
        let dest = target.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&dest, bytes).map_err(|e| format!("写 {} 失败：{e}", dest.display()))?;
        written += 1;
    }
    std::fs::write(&stamp, marker).map_err(|e| e.to_string())?;
    Ok(written)
}

/// 把内嵌的 sidecar 写到磁盘（可执行文件不能从内存里跑）。带大小标记，避免每次启动都写。
fn extract_sidecar(target: &Path) -> Result<PathBuf, String> {
    let exe = target.join("pet-sidecar.exe");
    let stamp = target.join("pet-sidecar.stamp");
    let marker = EMBEDDED_SIDECAR.len().to_string();
    if exe.exists() && std::fs::read_to_string(&stamp).map(|old| old == marker).unwrap_or(false) {
        return Ok(exe);
    }
    std::fs::write(&exe, EMBEDDED_SIDECAR).map_err(|e| e.to_string())?;
    std::fs::write(&stamp, marker).map_err(|e| e.to_string())?;
    Ok(exe)
}

fn resolve_node() -> String {
    std::env::var("PET_DESKTOP_NODE").unwrap_or_else(|_| "node".to_string())
}

/// 页面模式：`--page spike`（或者 `PET_DESKTOP_PAGE=spike`）。默认挂真的桌宠。
fn resolve_page() -> String {
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|a| a == "--page") {
        if let Some(value) = args.get(at + 1) {
            return value.clone();
        }
    }
    std::env::var("PET_DESKTOP_PAGE").unwrap_or_else(|_| "pet".to_string())
}

/// `--dsh none` 关掉与 DSH 的连接（纯本地独立）。
fn resolve_dsh() -> String {
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|a| a == "--dsh") {
        if let Some(value) = args.get(at + 1) {
            return value.clone();
        }
    }
    std::env::var("PET_DESKTOP_DSH").unwrap_or_else(|_| "http://127.0.0.1:3080".to_string())
}

impl Sidecar {
    /// `runtime` = 可写目录（壳已经建好）。内嵌 sidecar 存在就优先用它。
    pub fn launch(runtime: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let desktop = desktop_dir();
        let embed_root = runtime.join("embed");
        std::fs::create_dir_all(&embed_root)?;

        let embedded = has_embedded_sidecar();
        let mut command;
        if embedded {
            let unpacked = extract_embed(&embed_root)?;
            if unpacked > 0 {
                eprintln!("[sidecar] 已解包内嵌资源：{unpacked} 个文件 → {}", embed_root.display());
            }
            let exe = extract_sidecar(runtime)?;
            command = Command::new(exe);
        } else {
            // 开发路径：直接跑仓库里的 sidecar/server.mjs。
            command = Command::new(resolve_node());
            command.arg(desktop.join("sidecar").join("server.mjs"));
            command.current_dir(desktop.join("sidecar"));
        }

        command
            .arg("--page")
            .arg(resolve_page())
            .arg("--dsh")
            .arg(resolve_dsh())
            .env("PET_DESKTOP_EMBED", &embed_root)
            .env("PET_DESKTOP_RUN", runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 0x08000000 = CREATE_NO_WINDOW：别弹一个黑框出来。
            command.creation_flags(0x0800_0000);
        }

        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("sidecar 没有 stdout")?;
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        let mut handshake = None;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    if let Some(rest) = line.strip_prefix("PET_SIDECAR ") {
                        handshake = Some(serde_json::from_str::<Handshake>(rest)?);
                        break;
                    }
                    // node 的警告之类不算握手，打出来继续等。
                    eprintln!("[sidecar] {line}");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let Some(handshake) = handshake else {
            let _ = child.kill();
            return Err("sidecar 40 秒内没有握手（看上面的 [sidecar] 输出）".into());
        };
        if !handshake.ok {
            let _ = child.kill();
            return Err(format!("sidecar 握手失败：{handshake:?}").into());
        }
        Ok(Self {
            url: handshake.url,
            pid: handshake.pid,
            published: handshake.published || embedded,
            child,
            _stdin: stdin,
        })
    }

    /// 优雅停：先关 stdin（sidecar 拿 EOF 就自己退），1.5 秒后还不走就硬杀整棵进程树。
    pub fn stop(&mut self) {
        self._stdin.take();
        for _ in 0..15 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}
