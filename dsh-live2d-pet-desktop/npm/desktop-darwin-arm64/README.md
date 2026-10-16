# 桌面端二进制的平台子包（macOS arm64）

这个目录里装的是**随主包分发的那个二进制**，一份 `package.json` + 一个构建产物：

```
npm/desktop-darwin-arm64/
  package.json                     ← 进仓库（声明 os/cpu 的那份清单）
  bin/dsh-pet-live2d-desktop       ← 不进仓库（由 tools/npm-prepare-subpackage.mjs 铺）
```

和 Windows 那份（`npm/desktop-win32-x64/`）是同一个套路，只是三处不同：

| 项 | Windows | macOS arm64 |
|---|---|---|
| 产物 | `DSH桌宠.exe` | `dsh-pet-live2d-desktop`（Mach-O，无扩展名） |
| 构建机 | 本机 / `windows-latest` | **只能**在 macOS 上构建（`macos-14`） |
| 要不要签名 | SmartScreen 警告 | 未签名时 Gatekeeper 直接拦（见下） |

## 怎么构建

```bash
# 在 macOS（arm64）上：
cd dsh-live2d-pet-desktop
npm run build:portable        # 编 release → dist/DSH桌宠.app + dist/dsh-pet-live2d-desktop
node tools/npm-prepare-subpackage.mjs --sub darwin-arm64
npm pack --pack-destination dist ./npm/desktop-darwin-arm64   # ← 必须在 macOS 上打
```

Windows 上跑不了这个平台（`cargo build` 需要 macOS SDK）。CI 那边是
`.github/workflows/desktop-mac.yml`（`macos-14` runner），上面每一步都在里面，产物同时作为
workflow artifact 与 Release 附件。

### ⚠️ tarball **必须在 macOS 上打**

**Windows 上的 `tar` 与 `npm` 不记 Unix 权限位。** 在 Windows 上对本目录 `npm pack`，打出来的
`bin/dsh-pet-live2d-desktop` 是 `644`；装到 mac 上被插件拉起时 `spawn` 直接 `EACCES`。

这件事**看不出来、也不报错** —— tarball 结构正常、大小正常、解出来文件也在，只有那三位权限位
是错的。实测（同一个 9,791,472 字节的二进制）：

| 渠道 | 谁打的包 | tar 里的权限位 |
|---|---|---|
| Release 的 `.tar.gz` | CI（macOS） | `0755` ✓ |
| npm 子包的 `.tgz` | Windows 本机 | `0644` ✗ |

所以：**CI 打 tarball → 挂 Release → 本机取回来原样 `npm publish`**，不要在本机重打。
判据是 `node tools/check-tarball-mode.mjs <tarball> --expect-exec package/bin/dsh-pet-live2d-desktop`
（CI 与 `~/.dsh/pet-darwin.mjs` 都会跑它，退出码非 0 就拦下发布）。

> 3.3.1 与 3.3.2 的 darwin 子包都是 `644` 发出去的。用户之所以还能用，是因为插件侧
> `resolveDesktopBinary()` 在返回前补了一次 `chmod 0755`（那是兜底，不是"发布物没问题"）。

## 发布纪律（两步，顺序不能反）

主包 `optionalDependencies` 里**已经有**这一行（3.1.1 起）。发布时：

1. 先把子包发上 npm：`node ~/.dsh/pet-publish-dir.mjs <CI 给的 .tgz>`（版本必须与主包逐字相同，
   `npm-prepare-subpackage.mjs` 与 `pet-darwin.mjs` 都会校验）；
2. 再发主包。

反过来做的话，主包上线时那个版本的子包还不存在 —— npm 遇 `optionalDependencies` 里
**不存在**的版本会**静默跳过**，用户装完桌面端凭空消失、且一句错都不报。

## 已知代价（macOS 特有）

- **没有签名与公证**：从 Release 下载的产物会被 Gatekeeper 拦下（"无法验证开发者"）。
  用户要右键→打开，或者 `xattr -dr com.apple.quarantine <路径>`。想让双击就能开，
  需要 Apple Developer ID（$99/年）+ 公证，这一步在 CI 里也能做，但要先有证书。
- **只在 Apple Silicon 上构建与验证**：Intel Mac（`darwin-x64`）要另加一个
  `macos-15-intel` runner 的矩阵项 —— 清单与代码都已经按平台表写好了，加一行即可。
- **真机行为尚未验证**：本项目的开发与全部驱动都跑在 Windows 上。
  mac 上"能不能点、能不能穿透、跟不跟手"属于**未验证区**，别在 README 里当既成事实写。
