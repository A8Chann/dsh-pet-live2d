// 一次性重构：把 tray.rs 的泛型收窄到这个壳唯一用到的运行时（Wry）。
//
// 起因：`monitor_index_at` 收窄在具体类型上，而托盘那边是 `AppHandle<R>`；
// `app.app_handle()` **不做**泛型→具体的转换（编译期 E0308）。这个壳只有 Wry 一个运行时，
// 所以托盘这边直接用具体类型最省事，也不必到处写 `R: Runtime`。
//
//   node tools/narrow-tray-generics.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP } from './paths.mjs'

const dry = process.argv.includes('--dry')
const path = join(DESKTOP, 'src-tauri', 'src', 'tray.rs')
let source = readFileSync(path, 'utf8')

const replacements = [
  // 导入：需要 Arc/Mutex 来描述管理进去的状态类型；`Shared` 在 host::shared 里。
  [
    "use tauri::{App, AppHandle, Manager, Runtime};\n\nuse crate::host::Shared;\nuse crate::pet_window;",
    "use std::sync::{Arc, Mutex};\n\nuse tauri::{App, AppHandle, Manager};\n\nuse crate::host::shared::Shared;\nuse crate::pet_window;",
  ],
  ['fn build_menu<R: Runtime>(app: &AppHandle<R>, current: usize)', 'fn build_menu(app: &AppHandle, current: usize)'],
  ['fn build_screen_submenu<R: Runtime>(app: &AppHandle<R>, current: usize)', 'fn build_screen_submenu(app: &AppHandle, current: usize)'],
  ['pub(crate) fn refresh<R: Runtime>(app: &AppHandle<R>)', 'pub(crate) fn refresh(app: &AppHandle)'],
  ['fn current_monitor_index<R: Runtime>(app: &AppHandle<R>)', 'fn current_monitor_index(app: &AppHandle)'],
  ['fn shared<R: Runtime>(app: &AppHandle<R>)', 'fn shared(app: &AppHandle)'],
  ['fn push<R: Runtime>(app: &AppHandle<R>, command: &str)', 'fn push(app: &AppHandle, command: &str)'],
  ['fn hidden_by_user<R: Runtime>(app: &AppHandle<R>)', 'fn hidden_by_user(app: &AppHandle)'],
  ['fn set_hidden_by_user<R: Runtime>(app: &AppHandle<R>, hidden: bool)', 'fn set_hidden_by_user(app: &AppHandle, hidden: bool)'],
  ['fn quit<R: Runtime>(app: &AppHandle<R>)', 'fn quit(app: &AppHandle)'],
  ['Option<tauri::State<\'_, Arc<std::sync::Mutex<Shared>>>>', "Option<tauri::State<'_, Arc<Mutex<Shared>>>>"],
  ['app.try_state::<Arc<std::sync::Mutex<Shared>>>()', 'app.try_state::<Arc<Mutex<Shared>>>()'],
  ['pet_window::monitor_index_at(app.app_handle(), position.x, position.y)', 'pet_window::monitor_index_at(app, position.x, position.y)'],
  ['MenuItem<R>', 'MenuItem'],
  ['tauri::menu::IsMenuItem<R>', 'tauri::menu::IsMenuItem'],
]

const applied = []
for (const [from, to] of replacements) {
  if (!source.includes(from)) continue
  source = source.split(from).join(to)
  applied.push(from.slice(0, 60))
}

if (!dry) writeFileSync(path, source)
console.log((dry ? '（--dry）' : '') + '应用了 ' + applied.length + ' 处替换：')
for (const item of applied) console.log('  ' + item)
