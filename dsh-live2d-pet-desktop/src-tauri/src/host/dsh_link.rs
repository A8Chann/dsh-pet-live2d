// 与**运行中的 DSH** 的连接：订阅它的 `/api/live2d-pet/events`，把相位喂给共享状态。
//
// 桌面端不拥有 DSH 的进程，所以拿不到 `ctx.on(...)`。好在**插件宿主半区已经把 DSH 那
// 十几个事件折成了 9 个相位**并通过 SSE 推出来 —— 桌面端只要订阅它，就能演出与网页端
// **一样的**状态机（`tool → thinking` 的 1200ms 防抖、`done` 的 3.5 秒回落都发生在
// DSH 那边，不是第二份实现）。
//
// 这是"本地独立 + 可挂 DSH"：连不上不是错误，宠物照样站着、照样自己摸鱼；断了自动重连
// （间隔退避），不弹错、不崩。
//
// 解析用**裸 TcpStream 逐行读**而不是引 HTTP 客户端：SSE 就是一个长连接加若干
// `data: {...}\n\n` 帧，为它引一个依赖不值得，而且我们要精确控制超时与重连。
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::shared::Shared;

/// 与插件宿主半区保持一致的相位白名单。
const PHASES: &[&str] = &[
    "idle", "thinking", "waiting", "asking", "tool", "helper", "queued", "done", "failed",
];

pub fn spawn(base: String, shared: Arc<Mutex<Shared>>) {
    std::thread::spawn(move || {
        let mut backoff = 500u64;
        let mut attempts = 0u64;
        loop {
            attempts += 1;
            match connect_and_stream(&base, &shared) {
                Ok(()) => {
                    // 对端正常关掉了：等一会儿重连。
                    backoff = 500;
                }
                Err(error) => {
                    let message = format!("{error}");
                    let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
                    guard.dsh = serde_json::json!({
                        "base": base,
                        "connected": false,
                        "attempts": attempts,
                        "lastError": message,
                    });
                }
            }
            std::thread::sleep(Duration::from_millis(backoff));
            backoff = (backoff * 2).min(15_000);
        }
    });
}

/// 连一次、读到断为止。
fn connect_and_stream(base: &str, shared: &Arc<Mutex<Shared>>) -> std::io::Result<()> {
    let url = base.trim_end_matches('/').to_string() + "/api/live2d-pet/events";
    let without_scheme = url
        .strip_prefix("http://")
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "只支持 http://"))?;
    let (authority, path) = match without_scheme.find('/') {
        Some(at) => (&without_scheme[..at], &without_scheme[at..]),
        None => (without_scheme, "/"),
    };
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host.to_string(), port.parse::<u16>().unwrap_or(80)),
        None => (authority.to_string(), 80),
    };

    let stream = TcpStream::connect((host.as_str(), port))?;
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    let mut writer = stream.try_clone()?;
    writer.write_all(
        format!(
            "GET {path} HTTP/1.1\r\nhost: {authority}\r\naccept: text/event-stream\r\nconnection: keep-alive\r\n\r\n"
        )
        .as_bytes(),
    )?;
    writer.flush()?;

    let mut reader = BufReader::new(stream);
    // 状态行 + 头。
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if !line.contains(" 200 ") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            format!("相位流没有 200：{}", line.trim()),
        ));
    }
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line.trim().is_empty() {
            break;
        }
    }
    {
        let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
        guard.dsh = serde_json::json!({ "base": base, "url": url, "connected": true, "attempts": 1 });
    }
    eprintln!("[dsh-link] 已连上 {url}");

    // 逐帧读：只认 `data:`（心跳是 `: ping`，直接跳过）。
    let mut frames = 0u64;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
                guard.dsh = serde_json::json!({
                    "base": base, "url": url, "connected": false,
                    "attempts": 1, "lastError": format!("{error}"),
                });
                return Err(error);
            }
        }
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<Value>(rest.trim()) else {
            continue;
        };
        let phase = payload.get("phase").and_then(Value::as_str).unwrap_or("");
        if !PHASES.contains(&phase) {
            continue;
        }
        let detail = payload.get("detail").and_then(Value::as_str).unwrap_or("");
        frames += 1;
        let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
        guard.set_phase(phase, detail);
        guard.dsh = serde_json::json!({
            "base": base, "url": url, "connected": true,
            "attempts": 1, "phases": frames,
        });
    }
    Ok(())
}
