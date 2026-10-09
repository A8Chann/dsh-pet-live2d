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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};

use super::catalog::{self, API};
use super::shared::{Point, Shared};

/// JSON base64 音频最大 2 MiB；超限直接回 413 并关闭连接。
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_AUDIO: usize = 1024 * 1024;
const SOUND_PHASES: [&str; 8] = ["thinking", "tool", "waiting", "asking", "helper", "queued", "done", "failed"];
/// 页面还没领任务时的等待上限：超过就当"穿透"，不能让壳一直等。
const PROBE_WAIT: Duration = Duration::from_millis(2500);
/// SSE 心跳间隔。
const SSE_PING: Duration = Duration::from_secs(30);
/// 转发给上游时，等响应头的上限。
const UPSTREAM_CONNECT: Duration = Duration::from_secs(10);

pub struct Host {
    pub port: u16,
    pub url: String,
    pub pets_root: std::path::PathBuf,
    pub plugin_root: std::path::PathBuf,
    /// 挂载模式的上游（DSH 的本机地址）。`Some` 时 `API + "/*"` 全部转发过去，
    /// 本机不再自己扫宠物、不再自己发资产。
    pub attach: Option<String>,
}

/// 启动服务器（回环、随机端口），返回地址。
pub fn serve(
    shared: Arc<Mutex<Shared>>,
    pets_root: std::path::PathBuf,
    plugin_root: std::path::PathBuf,
    attach: Option<String>,
    home: std::path::PathBuf,
) -> std::io::Result<Host> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    {
        let mut guard = shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.port = port;
        guard.attach = attach.clone();
        guard.home = home.clone();
    }
    let host = Host {
        port,
        url: format!("http://127.0.0.1:{port}"),
        pets_root,
        plugin_root,
        attach,
    };
    let state = Arc::new(HostState {
        shared: shared.clone(),
        pets_root: host.pets_root.clone(),
        plugin_root: host.plugin_root.clone(),
        attach: host.attach.clone(),
        home,
        desktop_pid: Mutex::new(0),
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
    attach: Option<String>,
    /// 编译期嵌入的那份资源，会不会被 DSH 那边的插件覆盖 —— 由调用方传进来，见 serve。
    home: PathBuf,
    /// 我们自己拉起的桌面端 pid（0 = 没拉）。
    desktop_pid: Mutex<u32>,
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
    origin: Option<String>,
    host: Option<String>,
    content_type: Option<String>,
    too_large: bool,
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
    let mut origin = None;
    let mut host = None;
    let mut content_type = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let trimmed = header.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            match key.to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().unwrap_or(MAX_BODY + 1),
                "content-type" => content_type = Some(value.trim().to_string()),
                "origin" => origin = Some(value.trim().to_string()),
                "host" => host = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    // 不截断 body：超限响应后必须断开，否则剩余字节会被误读作新请求。
    let too_large = length > MAX_BODY;
    let mut body = String::new();
    if length > 0 && !too_large {
        let mut buffer = vec![0u8; length];
        reader.read_exact(&mut buffer)?;
        body = String::from_utf8(buffer).unwrap_or_default();
    }
    Ok(Some(Request {
        method,
        path: target,
        body,
        origin,
        host,
        content_type,
        too_large,
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
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
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
        &[("cache-control", "no-store".to_string()), ("x-content-type-options", "nosniff".to_string())],
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
        if request.too_large {
            send_json(&mut stream, 413, &json!({ "ok": false, "error": "body-too-large" }))?;
            return Ok(());
        }
        let (path, query) = match request.path.split_once('?') {
            Some((path, query)) => (path.to_string(), query.to_string()),
            None => (request.path.clone(), String::new()),
        };
        let _ = query;
        if !route(&mut stream, &state, &request, &path)? {
            return Ok(());
        }
    }
}

/// 返回 `true` 表示连接可以继续（keep-alive）。
fn route(
    stream: &mut TcpStream,
    state: &HostState,
    request: &Request,
    path: &str,
) -> std::io::Result<bool> {
    let method = request.method.as_str();
    let body = request.body.as_str();
    // ---- 挂载模式：插件那一整套原样转发给 DSH ----
    //
    // 这就是"改 bug 只改一处"的落点：挂载时本机的宠物扫描、catalog、资产路由**一次都不
    // 参与**，页面拿到的每个字节都来自 DSH 里的 `lib/index.js`。所以那边修好了，桌面这
    // 只跟着好，我们这边一行都不用动。
    //
    // **连不上上游时故意失败，不退回本机实现**：静默兜底会把"挂载没成功"伪装成"挂载成功"
    // （页面上照样有宠物，但它其实来自本机扫描）—— 那正是这套架构最不该出现的不确定性。
    // 真兜底由用户显式选择：不加 `--attach` 就是独立模式。
    if let Some(upstream) = &state.attach {
        if path.starts_with(&format!("{API}/")) || path == API {
            if path.starts_with(&format!("{API}/sound/")) && method == "POST" {
                if let Err(error) = check_sound_post(request, stream.local_addr()?.port()) {
                    send_json(stream, error.0, &json!({ "ok": false, "error": error.1 }))?;
                    return Ok(true);
                }
            }
            if relay_to_upstream(stream, upstream, method, path, body)? {
                return Ok(false);
            }
            eprintln!("[host] 挂载模式：连不上上游 {upstream}（{path}）");
            send_json(
                stream,
                502,
                &json!({
                    "ok": false,
                    "error": "attach-upstream-unreachable",
                    "upstream": upstream,
                    "path": path,
                    "hint": "挂载模式要求 DSH 在运行；想让她独立站着就别加 --attach",
                }),
            )?;
            return Ok(true);
        }
    }

    // ---- 插件 API ----
    if let Some(rest) = path.strip_prefix(&format!("{API}/sound/")) {
        return serve_sound(stream, state, request, rest);
    }
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
    // 显示层：**客户端只认 `{API}/layer`**（每秒一次"现在该谁管这只宠物"），页面据此决定
    // 自己让不让位（桌面壳那一份的判据是 `owner !== "desktop"` → `visibility: hidden`）。
    //
    // ⚠️ 这里原来只有桌面端自己的 `/__desktop/owner`，而客户端在某一版改成读 `{API}/layer`
    // —— 于是**独立模式**（手动双击）下页面取不到，保持默认 `owner:"inline"`，页面把自己
    // 藏了：窗口在、canvas 在画、就是什么都看不到（用户 2026-09 报的"设置里显示桌面已接管，
    // 但看不到宠物"）。挂载模式不受影响，因为那条路把整个 API 转发给了 DSH 里的插件。
    // **两份宿主的路由形状必须一起改** —— AGENTS.md 的第一条纪律就是这条。
    if path == format!("{API}/layer") {
        if method == "POST" {
            let parsed: Value =
                serde_json::from_str(if body.trim().is_empty() { "{}" } else { body })
                    .unwrap_or_else(|_| json!({}));
            // 独立模式里"下载桌面端"没有意义：我们自己就是那只桌面端。
            if parsed.get("action").and_then(Value::as_str) == Some("download-desktop") {
                send_json(
                    stream,
                    200,
                    &json!({ "ok": true, "download": { "started": false, "reason": "built-in" } }),
                )?;
                return Ok(true);
            }
            // 页面能改的只有"显示位置"；判定权仍在壳（它每秒按偏好摆正一次）。
            if let Some(mode) = parsed.get("mode").and_then(Value::as_str) {
                let mode = super::display::normalise_mode(Some(&json!(mode)));
                let _ = super::display::write_preference(&state.home, json!({ "mode": mode }));
            }
        } else if method != "GET" && method != "HEAD" {
            send_json(stream, 405, &json!({ "ok": false, "error": "method-not-allowed" }))?;
            return Ok(true);
        }
        send_json(stream, 200, &layer_payload(state))?;
        return Ok(true);
    }

    // 共享设置：**两端都读写 `%DSH_HOME%\pet-settings.json` 这一份**，页面按 `rev` 判断
    // 自己那份是不是旧的。桌面端页面与 DSH 页面不是同一个 origin，localStorage 各存各的、
    // 永不互见 —— 所以这条路由是"两边设置一致"的唯一通道。
    //
    // ⚠️ 与 `{API}/layer` 同一类分叉：JS 宿主（`lib/index.js` 的 `settingsRoute`）一直有它，
    // 而这边原来没有 —— 用户 2026-09 报的"桌面端设置与 DSH 里的不一致"就是这个。
    // 语义必须与 `lib/settings.js` 逐字对应（合并写、空写不推进 rev、坏数据只取形状对的）。
    if path == format!("{API}/settings") {
        if method == "POST" {
            let parsed: Result<Value, _> =
                serde_json::from_str(if body.trim().is_empty() { "{}" } else { body });
            let Ok(parsed) = parsed else {
                send_json(stream, 400, &json!({ "ok": false, "error": "bad-body" }))?;
                return Ok(true);
            };
            match super::settings::write_settings(&state.home, &parsed) {
                Some(written) => {
                    let mut payload = written;
                    if let Some(map) = payload.as_object_mut() {
                        map.insert("ok".to_string(), json!(true));
                    }
                    send_json(stream, 200, &payload)?;
                }
                None => {
                    send_json(stream, 500, &json!({ "ok": false, "error": "write-failed" }))?;
                }
            }
            return Ok(true);
        }
        if method != "GET" && method != "HEAD" {
            send_json(stream, 405, &json!({ "ok": false, "error": "method-not-allowed" }))?;
            return Ok(true);
        }
        let mut payload = super::settings::read_settings(&state.home);
        if let Some(map) = payload.as_object_mut() {
            map.insert("ok".to_string(), json!(true));
        }
        send_json(stream, 200, &payload)?;
        return Ok(true);
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
    // 显示层：页面每秒问一次"现在该谁管这只宠物"。
    //
    // 页面**只读**这里，判定权在 host（校验 mode、算心跳、必要时拉起/收掉桌面端）——
    // 页面自己不去碰偏好文件，两个写者会互相擦。
    //
    // 这是桌面端最早的读口名；客户端后来统一改成 `{API}/layer`（见上面那条），这里保留
    // 是给**已有的驱动**用的（`probe-*.mjs` 直接读它）。两者载荷同形。
    if path == "/__desktop/owner" {
        send_json(stream, 200, &layer_payload(state))?;
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
    // **待办命令**：托盘菜单进来，页面每 33ms 取走（取走即清空）。
    //
    // 为什么不用 Tauri 的 `window.emit()`：它**不发 DOM 事件**、只走 IPC，而外部页面没有
    // `window.__TAURI__`（`withGlobalTauri: false`）—— 页面里 `addEventListener("pet://reset")`
    // 永远收不到东西。原来"设置""归位"两项就是这么静默失效的（用户报"点了没效果"）。
    if path == "/__desktop/commands" {
        let mut guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
        let commands = guard.take_commands();
        drop(guard);
        send_json(stream, 200, &json!({ "ok": true, "commands": commands }))?;
        return Ok(true);
    }
    // **全局光标**：页面每 33ms 问一次，用来驱动跟随。
    //
    // 为什么不塞进 `/probe/pending`：那个只在指针**落在窗口内**时才有任务，而这里要解决的
    // 恰恰是"指针在别的程序上"那一半 —— 塞进去的话，指针一出窗口位置就冻住了。
    //
    // 坐标是**本窗口的 CSS 像素**（= `clientX/clientY`）：壳读到的是虚拟桌面物理像素，
    // 先减窗口原点再除缩放。落在窗口外时会是负数/超出，那正是我们要的方向信息。
    if path == "/__desktop/cursor" {
        let guard = state.shared.lock().unwrap_or_else(|p| p.into_inner());
        let scale = if guard.scale > 0.0 { guard.scale } else { 1.0 };
        let origin = guard.window_origin.unwrap_or((0.0, 0.0));
        let payload = match guard.cursor {
            Some((x, y)) => json!({
                "ok": true,
                "x": (x as f64 - origin.0) / scale,
                "y": (y as f64 - origin.1) / scale,
                "screenX": x,
                "screenY": y,
            }),
            None => json!({ "ok": false, "reason": "no-cursor-yet" }),
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

fn sound_mime(bytes: &[u8]) -> Option<&'static str> {
    if valid_wav(bytes) { Some("audio/wav") }
    else if valid_ogg(bytes) { Some("audio/ogg") }
    else if valid_mp3(bytes) { Some("audio/mpeg") }
    else { None }
}

fn valid_wav(bytes: &[u8]) -> bool {
    if bytes.get(..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") { return false; }
    let Some(size) = bytes.get(4..8).and_then(|b| b.try_into().ok()).map(u32::from_le_bytes) else { return false; };
    // 长度字段：流式录音这类文件常写 0 或 0xFFFFFFFF（"长度未知/一直写到尾"），浏览器
    // 照样能播，所以只对这三个值放行，其余仍要求精确匹配（畸形头照旧拒绝）。
    // **JS 宿主 `lib/sound-files.js` 的 `validWav` 是同一条规则**，改这里必须一起改。
    let declared = size as usize;
    if declared != 0 && declared != u32::MAX as usize && declared != bytes.len().saturating_sub(8) {
        return false;
    }
    let (mut offset, mut block_align, mut data_size) = (12usize, None, None);
    while offset < bytes.len() {
        let Some(header) = bytes.get(offset..offset + 8) else { return false; };
        let size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let Some(end) = offset.checked_add(8).and_then(|start| start.checked_add(size)) else { return false; };
        let Some(chunk) = bytes.get(offset + 8..end) else { return false; };
        if &header[..4] == b"fmt " {
            if block_align.is_some() || chunk.len() < 16 { return false; }
            let format = u16::from_le_bytes([chunk[0], chunk[1]]);
            let channels = u16::from_le_bytes([chunk[2], chunk[3]]);
            let rate = u32::from_le_bytes(chunk[4..8].try_into().unwrap());
            let byte_rate = u32::from_le_bytes(chunk[8..12].try_into().unwrap());
            let align = u16::from_le_bytes([chunk[12], chunk[13]]);
            let bits = u16::from_le_bytes([chunk[14], chunk[15]]);
            if !matches!(format, 1 | 3) || channels == 0 || rate == 0 || bits == 0 || bits % 8 != 0
                || (format == 3 && !matches!(bits, 32 | 64))
                || usize::from(align) != usize::from(channels) * usize::from(bits / 8)
                || u64::from(byte_rate) != u64::from(rate) * u64::from(align) {
                return false;
            }
            block_align = Some(usize::from(align));
        } else if &header[..4] == b"data" {
            if data_size.is_some() { return false; }
            data_size = Some(size);
        }
        let Some(next) = end.checked_add(size % 2) else { return false; };
        if next > bytes.len() { return false; }
        offset = next;
    }
    match (block_align, data_size) {
        (Some(align), Some(size)) => size > 0 && size % align == 0,
        _ => false,
    }
}

fn valid_ogg(bytes: &[u8]) -> bool {
    let Some(header) = bytes.get(..27) else { return false; };
    if &header[..4] != b"OggS" || header[4] != 0 || header[5] != 2
        || u32::from_le_bytes(header[18..22].try_into().unwrap()) != 0 { return false; }
    let Some(segments) = bytes.get(27..27 + usize::from(header[26])) else { return false; };
    let payload_size: usize = segments.iter().map(|&size| usize::from(size)).sum();
    let start = 27 + segments.len();
    let Some(page) = bytes.get(..start + payload_size) else { return false; };
    let checksum = u32::from_le_bytes(header[22..26].try_into().unwrap());
    if ogg_checksum(page) != checksum { return false; }
    let Some(packet_end) = segments.iter().position(|&size| size < 255) else { return false; };
    let packet_size: usize = segments[..=packet_end].iter().map(|&size| usize::from(size)).sum();
    let packet = &page[start..start + packet_size];
    if packet.starts_with(b"OpusHead") {
        packet.len() >= 19 && packet[8] == 1 && packet[9] != 0
            && (if packet[18] == 0 { packet[9] <= 2 && packet.len() == 19 }
                else { packet[18] != 255 && packet.len() >= 21 + usize::from(packet[9]) })
    } else if packet.starts_with(b"\x01vorbis") {
        packet.len() == 30 && packet[7..11] == [0; 4] && packet[11] != 0
            && packet[12..16] != [0; 4] && packet[28] & 15 >= 6
            && packet[28] >> 4 >= packet[28] & 15 && packet[28] >> 4 <= 13
            && packet[29] == 1
    } else { false }
}

fn ogg_checksum(page: &[u8]) -> u32 {
    let mut crc = 0u32;
    for (index, &byte) in page.iter().enumerate() {
        crc ^= u32::from(if (22..26).contains(&index) { 0 } else { byte }) << 24;
        for _ in 0..8 {
            crc = (crc << 1) ^ if crc & 0x8000_0000 != 0 { 0x04c1_1db7 } else { 0 };
        }
    }
    crc
}

fn valid_mp3(bytes: &[u8]) -> bool {
    let mut offset = 0usize;
    if bytes.starts_with(b"ID3") {
        let Some(tag) = bytes.get(..10) else { return false; };
        if !(2..=4).contains(&tag[3]) || tag[4] == 0xff
            || tag[6..10].iter().any(|&byte| byte & 0x80 != 0)
            || tag[5] & (if tag[3] == 4 { 0x0f } else if tag[3] == 3 { 0x1f } else { 0x3f }) != 0 { return false; }
        let tag_size = tag[6..10].iter().fold(0usize, |size, &byte| size * 128 + usize::from(byte));
        offset = 10 + tag_size + if tag[3] == 4 && tag[5] & 0x10 != 0 { 10 } else { 0 };
    }
    let Some(frame) = bytes.get(offset..offset + 4) else { return false; };
    if frame[0] != 0xff || frame[1] & 0xe0 != 0xe0 { return false; }
    let version = (frame[1] >> 3) & 3;
    let layer = (frame[1] >> 1) & 3;
    let bitrate_index = usize::from(frame[2] >> 4);
    let rate_index = usize::from((frame[2] >> 2) & 3);
    if version == 1 || layer == 0 || bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 { return false; }
    let bitrates: &[u16; 16] = match (version == 3, layer) {
        (true, 3) => &[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
        (true, 2) => &[0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
        (true, 1) => &[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
        (false, 3) => &[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
        _ => &[0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    };
    let rate = [44100usize, 48000, 32000][rate_index] / match version { 3 => 1, 2 => 2, _ => 4 };
    let bitrate = usize::from(bitrates[bitrate_index]) * 1000;
    let padding = usize::from((frame[2] >> 1) & 1);
    let frame_size = if layer == 3 { (12 * bitrate / rate + padding) * 4 }
        else { (if layer == 1 && version != 3 { 72 } else { 144 }) * bitrate / rate + padding };
    frame[3] & 3 != 2 && bytes.len().saturating_sub(offset) >= frame_size
}

fn check_sound_post(request: &Request, port: u16) -> Result<(), (u16, &'static str)> {
    let host = request.host.as_deref().unwrap_or("").to_ascii_lowercase();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}")
        && host != format!("[::1]:{port}") {
        return Err((403, "untrusted-host"));
    }
    if let Some(origin) = &request.origin {
        let origin = origin.to_ascii_lowercase();
        if origin != format!("http://{host}") && origin != format!("https://{host}") {
            return Err((403, "cross-origin"));
        }
    }
    let content_type = request.content_type.as_deref().unwrap_or("").to_ascii_lowercase();
    if content_type != "application/json" && !content_type.starts_with("application/json;") {
        return Err((415, "json-required"));
    }
    Ok(())
}

// 目录和文件都不接受符号链接；名字只由已验证的 id 和相位拼出。
fn sound_path(home: &Path, id: &str, phase: &str, create: bool) -> std::io::Result<PathBuf> {
    if !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') || id.is_empty() || !SOUND_PHASES.contains(&phase) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid-path"));
    }
    if create { fs::create_dir_all(home)?; }
    let dir = home.join("pet-sounds");
    if create && !dir.exists() { fs::create_dir(&dir)?; }
    let meta = fs::symlink_metadata(&dir)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "unsafe-path"));
    }
    Ok(dir.join(format!("{id}--{phase}.audio")))
}

fn read_sound(home: &Path, id: &str, phase: &str) -> Option<(Vec<u8>, &'static str, String)> {
    let file = sound_path(home, id, phase, false).ok()?;
    let meta = fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_AUDIO as u64 { return None; }
    let bytes = fs::read(file).ok()?;
    if bytes.len() > MAX_AUDIO { return None; }
    let mime = sound_mime(&bytes)?;
    let token = format!("{:x}", Sha256::digest(&bytes));
    Some((bytes, mime, token))
}

fn sound_error(stream: &mut TcpStream, status: u16, error: &str) -> std::io::Result<bool> {
    send_json(stream, status, &json!({ "ok": false, "error": error }))?;
    Ok(true)
}

fn serve_sound(stream: &mut TcpStream, state: &HostState, request: &Request, rest: &str) -> std::io::Result<bool> {
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.is_empty() || segments.len() > 2 { return sound_error(stream, 404, "not-found"); }
    let id = segments[0];
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || (segments.len() == 2 && !SOUND_PHASES.contains(&segments[1]))
        || !pets(state).iter().any(|pet| pet.id() == id) {
        return sound_error(stream, 404, "not-found");
    }
    let phase = segments.get(1).copied();
    match request.method.as_str() {
        "POST" => {
            let Some(phase) = phase else { return sound_error(stream, 405, "method-not-allowed"); };
            if let Err((status, error)) = check_sound_post(request, stream.local_addr()?.port()) {
                return sound_error(stream, status, error);
            }
            let Ok(value) = serde_json::from_str::<Value>(&request.body) else { return sound_error(stream, 400, "bad-body"); };
            let Some(map) = value.as_object() else { return sound_error(stream, 400, "bad-body"); };
            if map.len() != 1 { return sound_error(stream, 400, "bad-body"); }
            if map.get("action").and_then(Value::as_str) == Some("reset") {
                if fs::symlink_metadata(state.home.join("pet-sounds")).is_ok() {
                    let Ok(file) = sound_path(&state.home, id, phase, false) else { return sound_error(stream, 500, "write-failed"); };
                    if let Ok(meta) = fs::symlink_metadata(&file) {
                        if meta.file_type().is_symlink() || !meta.is_file() { return sound_error(stream, 500, "write-failed"); }
                        if fs::remove_file(file).is_err() { return sound_error(stream, 500, "write-failed"); }
                    }
                }
            } else if let Some(encoded) = map.get("base64").and_then(Value::as_str) {
                if encoded.is_empty() || encoded.len() > (MAX_AUDIO + 2) / 3 * 4 {
                    return sound_error(stream, 400, "invalid-audio");
                }
                let Ok(bytes) = STANDARD.decode(encoded) else { return sound_error(stream, 400, "invalid-audio"); };
                if bytes.is_empty() || bytes.len() > MAX_AUDIO || STANDARD.encode(&bytes) != encoded || sound_mime(&bytes).is_none() {
                    return sound_error(stream, 400, "invalid-audio");
                }
                let Ok(path) = sound_path(&state.home, id, phase, true) else { return sound_error(stream, 500, "write-failed"); };
                if let Ok(meta) = fs::symlink_metadata(&path) {
                    if meta.file_type().is_symlink() || !meta.is_file() { return sound_error(stream, 500, "write-failed"); }
                }
                static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let nonce = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let temp = path.with_file_name(format!(".{}-{nonce}.tmp", std::process::id()));
                let written = OpenOptions::new().write(true).create_new(true).open(&temp)
                    .and_then(|mut file| file.write_all(&bytes))
                    .and_then(|_| fs::rename(&temp, &path));
                if written.is_err() { let _ = fs::remove_file(temp); return sound_error(stream, 500, "write-failed"); }
            } else { return sound_error(stream, 400, "bad-body"); }
            send_json(stream, 200, &json!({ "ok": true }))?;
            Ok(true)
        }
        "GET" | "HEAD" => {
            if let Some(phase) = phase {
                let Some((bytes, mime, _)) = read_sound(&state.home, id, phase) else { return sound_error(stream, 404, "not-found"); };
                let payload = if request.method == "HEAD" { &[][..] } else { &bytes[..] };
                send_bytes(stream, 200, mime, payload, &[("cache-control", "no-store".into()), ("x-content-type-options", "nosniff".into())])?;
            } else {
                let mut sounds = serde_json::Map::new();
                for phase in SOUND_PHASES {
                    if let Some((bytes, mime, token)) = read_sound(&state.home, id, phase) {
                        sounds.insert(phase.into(), json!({ "url": format!("{API}/sound/{id}/{phase}?token={token}"), "mime": mime, "bytes": bytes.len(), "token": token }));
                    }
                }
                send_json(stream, 200, &json!({ "ok": true, "sounds": sounds }))?;
            }
            Ok(true)
        }
        _ => sound_error(stream, 405, "method-not-allowed"),
    }
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

/// 把浏览器半区的 API 请求原样转发给 DSH（挂载模式）。
///
/// 返回值：`true` = 已经转发（或转发失败但已经回了错，调用方不要再兜底）；
/// `false` = 压根没连上上游，交给本机实现兜底。
///
/// 手写而不是引 HTTP 客户端：这里要转发的是**一条可能是 SSE 的长连接**，用现成库反而
/// 要处理"流式响应怎么再流出去"。裸 socket 只是双向 `io::copy`。
///
/// ⚠️ 两个容易踩的点：
///   * 上游可能回 `chunked`（DSH 的资产路由就走 `node:http` 的默认分块）—— 那种情况
///     **不能**把 `content-length` 再抄一遍，得把分块剥掉、只把体透传；
///   * 转发完必须**关掉**这条连接（我们不知道上游会不会继续写），所以对客户端声明
///     `connection: close`。
fn relay_to_upstream(
    client: &mut TcpStream,
    upstream: &str,
    method: &str,
    path: &str,
    body: &str,
) -> std::io::Result<bool> {
    if method != "GET" && method != "POST" && method != "HEAD" {
        return Ok(true); // 只转发这几种；其余交给本机实现去回 405/404
    }
    let authority = upstream
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    if upstream.starts_with("https://") {
        // 上游是本机 DSH，不该是 https；真遇到就明确报错，别静默失败。
        eprintln!("[host] 挂载模式不支持 https 上游：{upstream}");
        return Ok(false);
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host.to_string(), port.parse::<u16>().unwrap_or(80)),
        None => (authority.clone(), 80),
    };

    let Ok(mut server) = TcpStream::connect((host.as_str(), port)) else {
        return Ok(false);
    };
    server.set_read_timeout(Some(UPSTREAM_CONNECT))?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nhost: {authority}\r\naccept: */*\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
        body.as_bytes().len()
    );
    server.write_all(request.as_bytes())?;
    server.flush()?;

    // 读上游的响应头。
    let mut reader = BufReader::new(server.try_clone()?);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line)? == 0 {
        return Ok(false);
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.push((key.trim().to_string(), value.trim().to_string()));
        }
    }

    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(502);
    let header_of = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };
    let chunked = header_of("transfer-encoding")
        .map(|value| value.to_lowercase().contains("chunked"))
        .unwrap_or(false);
    let content_length = header_of("content-length").and_then(|value| value.parse::<usize>().ok());

    // 回给客户端：只带这几个头，**故意声明 connection: close**。
    let reason = status_line.split_whitespace().nth(2).unwrap_or("OK");
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {}\r\nconnection: close\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\n\r\n",
        header_of("content-type").unwrap_or_else(|| "application/octet-stream".to_string())
    );
    if !chunked {
        if let Some(length) = content_length {
            head = head.replace(
                "connection: close\r\n",
                &format!("content-length: {length}\r\nconnection: close\r\n"),
            );
        }
    }
    client.write_all(head.as_bytes())?;
    client.flush()?;

    // 体：分块的剥壳，其余原样搬。
    if chunked {
        loop {
            let mut size_line = String::new();
            if reader.read_line(&mut size_line)? == 0 {
                break;
            }
            let size_text = size_line.trim().split(';').next().unwrap_or("0");
            let Ok(size) = usize::from_str_radix(size_text, 16) else {
                break;
            };
            if size == 0 {
                break;
            }
            let mut chunk = vec![0u8; size];
            reader.read_exact(&mut chunk)?;
            if client.write_all(&chunk).is_err() {
                break; // 客户端先走了（比如刷新页面）
            }
            let _ = client.flush();
            let mut crlf = [0u8; 2];
            let _ = reader.read_exact(&mut crlf);
        }
    } else if let Some(length) = content_length {
        let mut remaining = length;
        let mut buffer = [0u8; 8192];
        while remaining > 0 {
            let take = remaining.min(buffer.len());
            let read = reader.read(&mut buffer[..take])?;
            if read == 0 {
                break;
            }
            if client.write_all(&buffer[..read]).is_err() {
                break;
            }
            remaining -= read;
        }
    } else {
        // 既没长度也没分块：那就是"读到连接断"，一路搬（SSE 这条路不走这里）。
        let _ = std::io::copy(&mut reader, client);
    }
    let _ = client.flush();
    // 我们声明了 connection: close，所以这条连接用完就结束。
    Ok(true)
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

/// `%DSH_HOME%`（默认 `~/.dsh`）。
///
/// ⚠️ 主目录环境变量**两个平台不同名**：Windows 是 `USERPROFILE`，macOS/Linux 是 `HOME`。
/// 只认前者的话，mac 上会退化成**当前工作目录**下的 `.dsh` —— 症状是"宠物目录找不到"，
/// 而且会在人家随便哪个 cwd 里新建一份（比找不到更讨厌）。
pub fn default_home() -> std::path::PathBuf {
    if let Some(value) = std::env::var("DSH_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return std::path::PathBuf::from(value);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".dsh")
}

/// 给测试用：宠物根目录（默认 `%DSH_HOME%\pets`）。
pub fn default_pets_root() -> std::path::PathBuf {
    default_home().join("pets")
}

/// 显示层载荷（`{API}/layer` 与 `/__desktop/owner` **同形**，与 JS 宿主逐字段对应）。
///
/// 页面对它的用法只有一个关键字段：`owner`（桌面壳那一份是"owner 不是我 ⇒ 让位"）。
/// 剩下的是设置页要显示的（mode / desktopRunning / binary / download）。
///
/// **有意缺一个字段**：JS 那边还有 `pidStillTaken`（"心跳说没了、但那个 pid 号还占着"，
/// 防 pid 复用的诊断）。Rust 侧要判它得去 `OpenProcess` 问系统，而这个载荷每秒被轮询一次，
/// 不值当；客户端与驱动都不读它（只有 JS 的单元测试用）。**写在这里，免得下次对拍时
/// 以为是漏了。**
fn layer_payload(state: &HostState) -> Value {
    let mut payload = super::display::status(&state.home, false);
    let spawned = state
        .desktop_pid
        .lock()
        .map(|pid| *pid != 0)
        .unwrap_or(false);
    if let Some(map) = payload.as_object_mut() {
        map.insert("ok".to_string(), json!(true));
        map.insert("desktopSpawnedByPlugin".to_string(), json!(spawned));
        // 独立模式里"桌面端"就是本进程：二进制恒为就绪，也没有可下载的东西
        // （挂载模式走转发，根本到不了这里）。
        map.insert(
            "binary".to_string(),
            json!({
                "found": true,
                "path": std::env::current_exe().ok().map(|path| path.display().to_string()),
                "source": "self",
                "supported": true,
                "hint": "",
            }),
        );
        map.insert("download".to_string(), json!({ "state": "idle", "at": 0 }));
    }
    payload
}

#[cfg(test)]
mod sound_tests {
    use super::*;

    /// 音频容器判据的**合同向量**：与网页宿主 `lib/sound-files.js` 读同一份
    /// `tools/sound-vectors.json`，对同一组字节流必须给出同一个 mime。
    ///
    /// 这里原来是一堆手写向量，改成读文件是因为判据有两份手写实现（Rust 一份、JS 一份）：
    /// 各测各的等于没测 —— 分叉的症状（"网页端传得进、桌面端读不出来"）两边都不报错。
    #[test]
    fn sound_vectors_contract() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/sound-vectors.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("读不到合同向量 {}：{error}", path.display()));
        let contract: Value = serde_json::from_str(&raw).expect("合同向量是 JSON");
        let vectors = contract["vectors"].as_array().expect("合同向量里有 vectors 数组").clone();
        assert!(vectors.len() >= 10, "合同向量太少，等于没测");
        for vector in vectors {
            let name = vector["name"].as_str().unwrap_or("?");
            let expected = vector["mime"].as_str();
            let bytes = STANDARD
                .decode(vector["base64"].as_str().expect("向量带 base64"))
                .unwrap_or_else(|_| panic!("向量的 base64 坏了：{name}"));
            assert_eq!(sound_mime(&bytes), expected, "判据与合同不符：{name}");
        }
    }

    #[test]
    fn post_headers_require_loopback_host_and_json() {
        let build = |host: &str, origin: Option<&str>, content_type: &str| Request {
            method: "POST".into(), path: "".into(), body: "".into(), too_large: false,
            host: Some(host.into()), origin: origin.map(|value| value.to_string()),
            content_type: Some(content_type.into()),
        };
        // 官方客户端（`dsh-app://app` 页面）转发来的请求**不带 Origin**（实测），此时只看 Host。
        assert_eq!(check_sound_post(&build("127.0.0.1:123", None, "application/json"), 123), Ok(()));
        // 浏览器发的跨源请求带 Origin：必须与 Host 同源。
        assert_eq!(
            check_sound_post(&build("127.0.0.1:123", Some("http://evil.test"), "application/json"), 123),
            Err((403, "cross-origin"))
        );
        // Host 也被伪造成重绑定域名：拒。
        assert_eq!(
            check_sound_post(&build("evil.example:123", Some("http://evil.example:123"), "application/json"), 123),
            Err((403, "untrusted-host"))
        );
        // localhost / [::1] 两种本机写法都认。
        assert_eq!(check_sound_post(&build("localhost:123", Some("http://localhost:123"), "application/json"), 123), Ok(()));
        assert_eq!(check_sound_post(&build("[::1]:123", Some("http://[::1]:123"), "application/json"), 123), Ok(()));
        // 上传必须声明 JSON：跨源页面发不了这个 content-type 而不触发预检，而路由不答 CORS。
        assert_eq!(check_sound_post(&build("127.0.0.1:123", None, "text/plain"), 123), Err((415, "json-required")));
    }

    #[test]
    fn rejects_invalid_file_names() {
        let home = Path::new("/nonexistent-sound-home");
        assert!(sound_path(home, "../evil", "thinking", true).is_err());
        assert!(sound_path(home, "pet", "idle", true).is_err());
    }
}

/// 给测试用：`Path` 存在性（避免测试里到处 use std::path）。
pub fn path_exists(path: &Path) -> bool {
    path.exists()
}
