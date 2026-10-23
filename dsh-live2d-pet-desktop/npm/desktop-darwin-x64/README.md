# 桌面端二进制的平台子包（macOS x64 / Intel）

这个目录里装的是**随主包分发的那个二进制**，一份 `package.json` + 一个构建产物：

```
npm/desktop-darwin-x64/
  package.json                     ← 进仓库（声明 os/cpu 的那份清单）
  bin/dsh-pet-live2d-desktop       ← 不进仓库（由 tools/npm-prepare-subpackage.mjs 铺）
```

和 `npm/desktop-darwin-arm64/` 是同一套东西、同一份源码，只有三处不同：

| 项 | macOS arm64 | macOS x64 |
|---|---|---|
| 产物 | `dsh-pet-live2d-desktop`（Mach-O，无扩展名） | 同左，架构是 `x86_64` |
| 构建机 | CI `macos-14`（Apple Silicon） | CI `macos-15-intel`（Intel） |
| 装到哪 | `os: darwin` + `cpu: arm64` | `os: darwin` + `cpu: x64` |

两份都是**未签名**的裸二进制。和 arm64 一样，装了主包的 Intel Mac 会自动带上这一份
（`optionalDependencies` + `os`/`cpu` 让不匹配的架构**静默跳过**）。

## 怎么构建

```bash
# 在 macOS（x64）上，或直接让 CI 跑（macos-15-intel）：
cd dsh-live2d-pet-desktop
npm ci --prefix ../tools/browser-test   # build.rs 要嵌 React UMD
cargo build --release --bin dsh-pet-live2d-desktop
node tools/build-portable.mjs --skip-suite   # 出 dist/dsh-pet-live2d-desktop
node tools/npm-prepare-subpackage.mjs --sub darwin-x64
npm pack --pack-destination dist ./npm/desktop-darwin-x64   # ← 必须在 macOS 上打
```

Intel Mac 上 `cargo build` 的目标三元组就是 `x86_64-apple-darwin`，不用额外 `--target`。
**不要**从 Apple Silicon 用 `--target x86_64-apple-darwin` 交叉编译这一份：Tauri 的依赖里
有要编 Objective-C 的 crate，交叉编译要把 x86_64 的 macOS SDK 也装齐，比让 CI 开一个
Intel runner 麻烦得多，而且产出的东西没人验过。

### ⚠️ tarball **必须在 macOS 上打**

和 arm64 那份同一个坑：**Windows 上的 `tar` 与 `npm` 不记 Unix 权限位**，打出来的
`bin/dsh-pet-live2d-desktop` 是 `644`，装到 mac 上被插件拉起时 `spawn` 直接 `EACCES`。
CI 打完会立刻用 `tools/check-tarball-mode.mjs ... --expect-exec package/bin/dsh-pet-live2d-desktop`
断言执行位；发布时把 CI 的 `.tgz` 取回来**原样** `npm publish`，不要在本机重打。

## 发布纪律（两步，顺序不能反）

主包 `optionalDependencies` 里已经有这一行。发布时：

1. 先把子包发上 npm：`node ~/.dsh/pet-publish-dir.mjs <CI 给的 .tgz>`（版本必须与主包逐字相同）；
2. 再发主包。

反过来做的话，主包上线时那个版本的子包还不存在 —— npm 遇 `optionalDependencies` 里
**不存在**的版本会**静默跳过**，用户装完桌面端凭空消失、且一句错都不报。

## 已知代价（macOS 特有）

- **没有签名与公证**：第一次打开会被 Gatekeeper 拦（"无法验证开发者"）。
  用户要右键→打开，或者 `xattr -dr com.apple.quarantine <路径>`。想让双击就能开，
  需要 Apple Developer ID（$99/年）+ 公证。
- **只在 CI 上构建，未在真机验证**：Intel 这一份的"能不能点、能不能穿透、跟不跟手"
  属于**未验证区**。有人真的在 Intel Mac 上跑过之后，再把结论写进主 README。
- `macos-15-intel` 是 GitHub 给 Intel Mac 的迁移标签（`macos-13` 已下线），
  公共仓库可用；如果哪天它不可用了，把矩阵里那一行换回当时在架的 Intel 标签即可。
