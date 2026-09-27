// 进程内 HTTP 服务器：把浏览器半区要的四条路由提供出来。
//
// **这是 Node sidecar 的替代品**（原来那 347 行 `sidecar/server.mjs` 整个不要了）。
// 走的是标准库的 `TcpListener` + 手写 HTTP/1.1：我们只需要 GET/POST、不需要 chunked
// 上传、不需要 TLS，为它引一个框架（hyper/axum）会白白把单文件 exe 撑大几百 KB。
//
// 页面**一行都没改**：它照旧 `fetch("/api/live2d-pet/catalog")`、照旧
// `new EventSource("/api/live2d-pet/events")`、照旧去 `/__desktop/probe/pending` 领
// 判定任务。这是刻意的 —— 页面与壳之间那条契约不动，才能拿 `desktop-driver` /
// `probe-settings` 当回归网。
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::catalog::{self, API};
use super::shared::{Point, Shared};

/// 一次请求里最多读多少 body（判定答案是几十字节，够用且防呆）。
const MAX_BODY: usize = 64 * 1024;
/// 页面还没领任务时的等待上限：超过就当"穿透"，不能让壳一直等。
const PROBE_WAIT: Duration = Duration::from_millis(2500);
/// SSE 心跳间隔。
const SSE_PING: Duration = Duration::from_secs(30);

pub struct Host {
    pub port: u16,
    pub url: String,
    pub pets_root: std::path::PathBuf,
    pub plugin_root: std::path::PathBuf,
}

/// 启动服务器（回环、随机端口），返回地址。
pub fn serve(shared: Arc<Mutex<Shared>>, pets_root: std::path::PathBuf, plugin_root: std::path::PathBuf) -> std::io::Result<Host> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    {
        let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.port = port;
    }
    let host = Host {
        port,
        url: format!("http://127.0.0.1:{port}"),
        pets_root,
        plugin_root,
    };
    let state = Arc::new(HostState {
        shared: shared.clone(),
        pets_root: host.pets_root.clone(),
        plugin_root: host.plugin_root.clone(),
    });
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let state = state.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, state);
            });
        }
    });
    Ok(host)
}

struct HostState {
    shared: Arc<Mutex<Shared>>,
    pets_root: std::path::PathBuf,
    plugin_root: std::path::PathBuf,
}

/// 每次请求都重扫宠物目录 —— 与 JS 版一致（`buildCatalog()` 每请求重建），
/// 好处是"装了一只新宠物/改了 pet.json"立刻生效，不用重启。
fn pets(state: &HostState) -> Vec<catalog::PetEntry> {
    catalog::build_catalog(&state.pets_root)
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "moc3" => "application/octet-stream",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

struct Request {
    method: String,
    path: String,
    body: String,
}

/// 读一条请求（请求行 + 头 + 按 content-length 读 body）。
fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = String::new();
    if length > 0 {
        let take = length.min(MAX_BODY);
        let mut buffer = vec![0u8; take];
        reader.read_exact(&mut buffer)?;
        body = String::from_utf8_lossy(&buffer).to_string();
        // 多出来的部分丢掉（我们不会发那么大的请求，但别把连接搞脏）。
        for _ in take..length {
            let mut byte = [0u8; 1];
            if reader.read_exact(&mut byte).is_err() {
                break;
            }
        }
    }
    Ok(Some(Request {
        method,
        path: target,
        body,
    }))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn send_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    extra: &[(&str, String)],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: keep-alive\r\n",
        body.len()
    );
    for (key, value) in extra {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn send_json(stream: &mut TcpStream, status: u16, payload: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    send_bytes(
        stream,
        status,
        "application/json; charset=utf-8",
        &body,
        &[("cache-control", "no-store".to_string())],
    )
}

fn handle(mut stream: TcpStream, state: Arc<HostState>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let reader_stream = stream.try_clone()?;
    let mut reader = BufReader::new(reader_stream);
    loop {
        let Some(request) = read_request(&mut reader)? else {
            return Ok(());
        };
        let (path, query) = match request.path.split_once('?') {
            Some((path, query)) => (path.to_string(), query.to_string()),
            None => (request.path.clone(), String::new()),
        };
        let _ = query;
        if !route(&mut stream, &state, &request.method, &path, &request.body)? {
            return Ok(());
        }
    }
}

/// 返回 `true` 表示连接可以继续（keep-alive）。
fn route(
    stream: &mut TcpStream,
    state: &HostState,
    method: &str,
    path: &str,
    body: &str,
) -> std::io::Result<bool> {
    // ---- 插件 API ----
    if path == format!("{API}/catalog") {
        // **先同步随包宠物，再扫目录**：第一次运行时宠物还不存在，顺序反了会返回空列表
        // （JS 版的 buildCatalog() 也是这么排的）。
        let notes = catalog::install_bundled_pets(&state.plugin_root.join("pets"), &state.pets_root);
        for note in notes {
            eprintln!("[host] {note}");
        }
        let pets = pets(state);
        let payload = catalog::catalog_response(
            &pets,
            &format!("{API}/runtime/live2dcubismcore.min.js"),
            &format!("{API}/runtime/live2d-vendor.js"),
        );
        send_json(stream, 200, &payload)?;
        return Ok(true);
    }
    if path == format!("{API}/runtime/live2dcubismcore.min.js")
        || path == format!("{API}/runtime/live2d-vendor.js")
    {
        let name = if path.ends_with("live2d-vendor.js") {
            "vendor.js"
        } else {
            "live2dcubismcore.min.js"
        };
        return serve_embed(stream, name);
    }
    if let Some(rest) = path.strip_prefix(&format!("{API}/asset/")) {
        return serve_asset(stream, state, rest);
    }
    if path == format!("{API}/events") {
        return serve_events(stream, state);
    }

    // ---- 桌面端自己的接口 ----
    if path == "/__desktop/ping" {
        let pets = pets(state);
        let (phase, detail, probe, shell, dsh) = {
            let guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
            (
                guard.phase.clone(),
                guard.phase_detail.clone(),
                guard.probe_json(),
                guard.shell_json(),
                guard.dsh.clone(),
            )
        };
        send_json(
            stream,
            200,
            &json!({
                "ok": true,
                "page": page_name(),
                "pid": std::process::id(),
                "pets": pets.iter().map(|pet| json!({
                    "id": pet.id(),
                    "displayName": pet.json.get("displayName").cloned().unwrap_or(Value::Null),
                })).collect::<Vec<_>>(),
                "phase": { "phase": phase, "detail": detail },
                "probe": probe,
                "shell": shell,
                "dsh": dsh,
            }),
        )?;
        return Ok(true);
    }
    if path == "/__desktop/shell" {
        let guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
        let payload = guard.shell_json();
        drop(guard);
        send_json(stream, 200, &payload)?;
        return Ok(true);
    }
    // 页面来领任务 / 交答案（与 Node 版**逐字段相同**，页面不用改）。
    if path == "/__desktop/probe/pending" {
        let mut guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
        let payload = if guard.probe.answer.is_some() {
            json!({ "ok": false, "reason": "answered" })
        } else if guard.probe.seq == 0 {
            json!({ "ok": false, "reason": "no-task" })
        } else {
            json!({
                "ok": true,
                "seq": guard.probe.seq,
                "x": guard.probe.point.x,
                "y": guard.probe.point.y,
            })
        };
        drop(guard);
        send_json(stream, 200, &payload)?;
        return Ok(true);
    }
    if path == "/__desktop/probe/answer" && method == "POST" {
        let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let seq = parsed.get("seq").and_then(Value::as_u64).unwrap_or(0);
        let interactive = parsed.get("interactive").and_then(Value::as_bool).unwrap_or(false);
        let reason = parsed
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
        let accepted = guard.answer_probe(seq, interactive, reason);
        drop(guard);
        send_json(stream, 200, &json!({ "ok": accepted, "seq": seq }))?;
        return Ok(true);
    }

    // ---- 页面 ----
    if path == "/" || path == "/index.html" {
        let name = if page_name() == "spike" { "page/spike.html" } else { "page/index.html" };
        return serve_embed(stream, name);
    }
    if let Some(rest) = path.strip_prefix("/page/") {
        return serve_embed(stream, &format!("page/{}", percent_decode(rest)));
    }
    if let Some(rest) = path.strip_prefix("/react/") {
        return serve_embed(stream, &percent_decode(rest));
    }
    if path == "/vendor.js" {
        return serve_embed(stream, "vendor.js");
    }
    // 和真实的 DSH 一样按**包名**寻址，页面里的 script 标签就不必为桌面端改一份。
    if path == "/plugins/dsh-pet-live2d/client.js" {
        return serve_embed(stream, "client.js");
    }
    if path == "/favicon.ico" {
        return serve_embed(stream, "icon.png");
    }

    send_bytes(
        stream,
        404,
        "text/plain; charset=utf-8",
        format!("not found: {path}").as_bytes(),
        &[],
    )?;
    Ok(true)
}

fn page_name() -> String {
    std::env::var("PET_DESKTOP_PAGE").unwrap_or_else(|_| "pet".to_string())
}

fn serve_embed(stream: &mut TcpStream, name: &str) -> std::io::Result<bool> {
    let Some(bytes) = super::embed::get(name) else {
        eprintln!("[host] 内嵌资源里没有 {name}");
        send_bytes(stream, 404, "text/plain; charset=utf-8", b"missing", &[])?;
        return Ok(true);
    };
    send_bytes(
        stream,
        // 桌面端没有构建步骤，页面改完就该立刻生效。
        200,
        mime_for(name),
        bytes,
        &[("cache-control", "no-store".to_string())],
    )?;
    Ok(true)
}

/// 资产路由：**只服务模型引用闭包内的文件**。
///
/// 两道闸：路径必须落在闭包 Set 里（`..` 永远匹配不上），且相对路径逐段通过
/// `safe_rel` 的白名单。JS 版还有一层 `realpathSync` 包含判定，这里不需要 ——
/// 闭包是从模型自己声明的文件名算出来的，而不是从请求里来的。
fn serve_asset(
    stream: &mut TcpStream,
    state: &HostState,
    rest: &str,
) -> std::io::Result<bool> {
    let segments: Vec<String> = rest.split('/').map(percent_decode).collect();
    if segments.len() < 2 {
        send_bytes(stream, 404, "text/plain; charset=utf-8", b"not found", &[])?;
        return Ok(true);
    }
    let id = segments[0].clone();
    let rel = segments[1..].join("/");
    let Some(pet) = pets(state).into_iter().find(|pet| pet.id() == id) else {
        send_bytes(stream, 404, "text/plain; charset=utf-8", b"unknown pet", &[])?;
        return Ok(true);
    };
    if !pet.closure.contains(&rel) {
        eprintln!("[host] 资产不在引用闭包里，拒绝：{id}/{rel}");
        send_bytes(stream, 403, "text/plain; charset=utf-8", b"forbidden", &[])?;
        return Ok(true);
    }
    let file = pet.dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    let Ok(bytes) = std::fs::read(&file) else {
        send_bytes(stream, 404, "text/plain; charset=utf-8", b"missing", &[])?;
        return Ok(true);
    };
    send_bytes(
        stream,
        200,
        mime_for(&rel),
        &bytes,
        &[("cache-control", "no-cache".to_string())],
    )?;
    Ok(true)
}

/// 相位流（SSE）：与插件宿主半区那条约 30 行的事件路由**逐字段同形**。
fn serve_events(stream: &mut TcpStream, state: &HostState) -> std::io::Result<bool> {
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=utf-8\r\ncache-control: no-store\r\nconnection: keep-alive\r\nx-accel-buffering: no\r\n\r\n",
    );
    let (phase, detail) = {
        let guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
        (guard.phase.clone(), guard.phase_detail.clone())
    };
    head.push_str(&format!(
        "data: {}\n\n",
        json!({ "phase": phase, "detail": detail, "at": now_ms() })
    ));
    stream.write_all(head.as_bytes())?;
    stream.flush()?;

    let mut last = (phase, detail);
    let mut last_ping = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(120));
        let (phase, detail) = {
            let guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
            (guard.phase.clone(), guard.phase_detail.clone())
        };
        if (phase.clone(), detail.clone()) != last {
            last = (phase.clone(), detail.clone());
            let frame = format!("data: {}\n\n", json!({ "phase": phase, "detail": detail, "at": now_ms() }));
            if stream.write_all(frame.as_bytes()).is_err() {
                return Ok(false);
            }
            if stream.flush().is_err() {
                return Ok(false);
            }
            last_ping = Instant::now();
        } else if last_ping.elapsed() > SSE_PING {
            if stream.write_all(b": ping\n\n").is_err() || stream.flush().is_err() {
                return Ok(false);
            }
            last_ping = Instant::now();
        }
        // 客户端断了要退出这个线程：写完 flush 再看一眼对端还在不在。
        if stream.flush().is_err() {
            return Ok(false);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 页面地址（壳建窗时用）。
pub fn page_url(host: &Host) -> String {
    format!("{}/", host.url)
}

/// 一次探索：把"光标在哪、判定是什么"问一遍（壳的轮询循环调它）。
pub fn probe_now(shared: &Arc<Mutex<Shared>>, point: Point) -> Option<(bool, String)> {
    let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
    guard.ask_probe(point);
    let seq = guard.probe.seq;
    drop(guard);
    let deadline = Instant::now() + PROBE_WAIT;
    loop {
        {
            let mut guard = shared.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(answer) = guard.verdict() {
                return Some(answer);
            }
            // 任务被顶掉（壳自己又问了）就当这次没答。
            if guard.probe.seq != seq {
                return None;
            }
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(4));
    }
}

/// 诊断：内嵌资源清单（排查"打包后少了什么"时用）。
pub fn embed_names() -> Vec<&'static str> {
    super::embed::names()
}

/// 给测试用：直接读一份内嵌文件。
pub fn embed_bytes(name: &str) -> Option<&'static [u8]> {
    super::embed::get(name)
}

/// 给测试用：宠物根目录（默认 `%DSH_HOME%\pets`）。
pub fn default_pets_root() -> std::path::PathBuf {
    let home = std::env::var("DSH_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()))
                .join(".dsh")
        });
    home.join("pets")
}

/// 给测试用：`Path` 存在性（避免测试里到处 use std::path）。
pub fn path_exists(path: &Path) -> bool {
    path.exists()
}
