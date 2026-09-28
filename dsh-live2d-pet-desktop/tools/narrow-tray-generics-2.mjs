// 上一步（narrow-tray-generics）之后剩下的泛型参数：`MenuItem` / `Submenu` /
// `IsMenuItem` / 托盘事件闭包都要显式写运行时类型 `tauri::Wry`。
//
//   node tools/narrow-tray-generics-2.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const path = join(DESKTOP, 'src-tauri', 'src', 'tray.rs')
let source = readFileSync(path, 'utf8')

const replacements = [
  ['let mut items: Vec<MenuItem> = Vec::new();', 'let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();'],
  ["let refs: Vec<&dyn tauri::menu::IsMenuItem> =", "let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> ="],
  ['items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem).collect()', 'items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect()'],
  ['.on_menu_event(|app, event| {', '.on_menu_event(|app: &AppHandle, event| {'],
  ['.on_tray_icon_event(|tray, event| {', '.on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event| {'],
  ['fn build_screen_submenu(app: &AppHandle, current: usize) -> tauri::Result<Submenu> {', 'fn build_screen_submenu(app: &AppHandle, current: usize) -> tauri::Result<Submenu<tauri::Wry>> {'],
  ['fn build_menu(app: &AppHandle, current: usize) -> tauri::Result<Menu> {', 'fn build_menu(app: &AppHandle, current: usize) -> tauri::Result<Menu<tauri::Wry>> {'],
  ['"（没检测到屏幕）",\n            false,\n            None::<&str>,\n        )?);', '"（没检测到屏幕）",\n            false,\n            None::<&str>,\n        )?);'],
]

const applied = []
for (const [from, to] of replacements) {
  if (!source.includes(from)) continue
  source = source.split(from).join(to)
  applied.push(from.slice(0, 62))
}
writeFileSync(path, source)
console.log('应用了 ' + applied.length + ' 处替换：')
for (const item of applied) console.log('  ' + item)
