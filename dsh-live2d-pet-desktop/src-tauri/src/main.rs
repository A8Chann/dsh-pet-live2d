// Windows 发布版不弹控制台窗口；sidecar 的 stdout 仍然照读（它是管道）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dsh_pet_live2d_desktop_lib::run()
}
