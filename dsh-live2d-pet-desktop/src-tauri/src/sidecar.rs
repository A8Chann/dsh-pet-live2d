// sidecar 的生命周期：拉起 node 进程、读它的握手行、退出时收尸。
//
// 为什么是 Node 而不是把插件翻成 Rust：`lib/index.js` 里的宠物发现、`pet.json` 解析、
// 模型引用闭包白名单是**已经修过 bug、有回归测试**的逻辑，翻一遍就是第二份实现。
// Node 在 DSH 用户的机器上必然存在（DSH 自己就跑在 Node 上）。
//
// 打包时（M4）这里会换成"随包的 sidecar 二进制 + 随包的 node"，接口不变。
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Handshake {
    pub ok: bool,
    pub url: String,
    /// 端口与页面模式目前只用于日志（诊断时"壳连的到底是哪一个 sidecar"很重要）。
    #[allow(dead_code)]
    pub port: u16,
    #[allow(dead_code)]
    #[serde(default)]
    pub page: String,
    #[serde(default)]
    pub pid: u32,
}

pub struct Sidecar {
    pub url: String,
    pub pid: u32,
    /// 壳把状态写在这里，sidecar 读出来挂成 `GET /__desktop/shell`。
    pub state_path: PathBuf,
    child: Child,
    /// 一直握着 stdin：进程活着时不让它读到 EOF（sidecar 用 EOF 当"壳没了"的信号）。
    _stdin: Option<ChildStdin>,
}

/// 仓库布局：<root>/dsh-live2d-pet-desktop/src-tauri/src/sidecar.rs
///                ^^^^^ 上溯四级就是仓库根，插件在它的兄弟目录 dsh-live2d-pet。
fn default_sidecar_dir() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.pop(); // src-tauri
    dir.push("sidecar");
    dir
}

fn resolve_node() -> String {
    std::env::var("PET_DESKTOP_NODE").unwrap_or_else(|_| "node".to_string())
}

/// 状态文件：放在 sidecar 目录旁边的 `.run/`（和页面驱动的临时文件同一个地方）。
fn state_path_for(dir: &std::path::Path) -> PathBuf {
    let mut run = dir.to_path_buf();
    run.pop();
    run.push(".run");
    let _ = std::fs::create_dir_all(&run);
    run.join("shell-state.json")
}

/// 页面模式：`cargo run -- --page spike`（或者 `PET_DESKTOP_PAGE=spike`）。
/// 默认挂真的 `lib/client.js`。
fn resolve_page() -> String {
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|a| a == "--page") {
        if let Some(value) = args.get(at + 1) {
            return value.clone();
        }
    }
    std::env::var("PET_DESKTOP_PAGE").unwrap_or_else(|_| "pet".to_string())
}

impl Sidecar {
    pub fn launch() -> Result<Self, Box<dyn std::error::Error>> {
        let dir = default_sidecar_dir();
        let script = dir.join("server.mjs");
        let page = resolve_page();
        let state_path = state_path_for(&dir);

        let mut command = Command::new(resolve_node());
        command
            .arg(&script)
            .arg("--page")
            .arg(&page)
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 0x08000000 = CREATE_NO_WINDOW：node 别弹一个黑框出来。
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

        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut handshake = None;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    if let Some(rest) = line.strip_prefix("PET_SIDECAR ") {
                        handshake = Some(serde_json::from_str::<Handshake>(rest)?);
                        break;
                    }
                    // node 的警告（比如实验特性提示）不算握手，打出来继续等。
                    eprintln!("[sidecar] {line}");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let Some(handshake) = handshake else {
            let _ = child.kill();
            return Err("sidecar 20 秒内没有握手（看上面的 [sidecar] 输出）".into());
        };
        if !handshake.ok {
            let _ = child.kill();
            return Err(format!("sidecar 握手失败：{handshake:?}").into());
        }
        Ok(Self {
            url: handshake.url,
            pid: handshake.pid,
            state_path,
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
