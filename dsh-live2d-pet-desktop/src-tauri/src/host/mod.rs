// 宿主半区：宠物目录扫描、资产路由、相位流、页面分发。
//
// 这个模块是**整个 Node sidecar 的替代品**。翻成 Rust 的动机只有一个字：体积。
// sidecar 那条路（deno compile）实测 86MB，`deno compile` 没有 `--strip`、
// `llvm-strip` 也压不动 —— 那 86MB 是 V8 运行时本体。翻成 Rust 之后整个 exe 回到
// 十几 MB 量级。
//
// 代价是**第二份实现**，所以配了一条对拍驱动（`tools/probe-catalog.mjs`）：同时跑
// JS 版与 Rust 版，把两份 catalog 逐字段比、把闭包里每个资产逐字节比。翻错了会立刻红，
// 而不是等用户发现装扮少了一个槽位。
pub mod catalog;
pub mod display;
pub mod dsh_link;
pub mod embed;
pub mod http;
pub mod settings;
pub mod shared;

pub use http::{page_url, serve};
