# 桌面端二进制的平台子包

这个目录里装的是**随主包分发的那个 exe**，一份 `package.json` + 一个构建产物：

```
npm/desktop-win32-x64/
  package.json                    ← 进仓库（声明 os/cpu 的那份清单）
  bin/dsh-pet-live2d-desktop.exe  ← 不进仓库（9MB，由 tools/npm-prepare-subpackage.mjs 铺）
```

## 为什么是子包，而不是把 exe 塞进主包

主包 `dsh-pet-live2d` 是**跨平台**的：macOS / Linux 用户一样要装它，但今天只有 Windows
构建。把 9MB 的 Windows 二进制塞进主包，等于让所有非 Windows 用户为一个跑不了的东西买单。

npm 的 `os` / `cpu` 字段正好解决这件事：不匹配的平台会**静默跳过**这个子包（不报错、
不下载）。于是同一句安装命令，三种机器三种结果：

| 系统 | `dsh plugin --profile web add dsh-pet-live2d` 之后 | 用户感受 |
|---|---|---|
| Windows x64 | 主包 + 本子包（带 exe） | 设置里选「桌面」，她直接出现在桌面上 |
| macOS / Linux | 主包照常装，本子包被跳过 | 插件功能完全正常，只是没有「桌面」这一项 |
| 将来加了 macOS 构建 | 再发一个 `…-darwin-arm64`，主包加一行 | 同样无感 |

## 怎么构建与验证

```bash
cd dsh-live2d-pet-desktop
npm run build:portable      # 先出 exe（dist/DSH桌宠.exe）
npm run npm:prepare         # 把 exe 铺进来（会校验版本与主包一致）
npm run npm:verify          # 17 项检查：清单/尺寸/平台跳过/解析器/端到端 --attach
```

`npm:verify` 不需要发布、不需要联网 GitHub —— 它 `npm pack` 出真 tarball、装进一个临时
profile、跑主包里的解析器、最后让装好的 exe 真的 `--attach` 起来对一次 catalog。

## 版本纪律

**子包版本必须与主包版本逐字相同**（主包的 `optionalDependencies` 写的就是它）。
`npm:prepare` 会校验这一点，不一致直接失败。

发布顺序：**先子包、后主包** —— 反过来的话，主包上线时那个版本的子包还不存在，
用户装的时候会拿不到 exe（不会报错，只是桌面版不可用）。

## 已知代价

未签名的 exe 会触发 Windows SmartScreen（"Windows 已保护你的电脑"）。
这和有签名有关，和从 npm 还是从 GitHub Release 下无关；只有代码签名证书能解。
