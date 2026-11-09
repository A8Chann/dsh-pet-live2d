# 第三方声明 / Third-party notices

本包（`dsh-pet-live2d`）随 `lib/client.js` 分发的四段内置提示音（`done` / `failed` / `asking` / `waiting`），
其音色设计来自：

- **dsh-session-notification** — <https://github.com/dingyi222666/dsh-session-notification>
  作者：**dingyi222666**；许可：**BSD-3-Clause**（以上游仓库 `package.json` 的 `"license"` 字段为准）。
  上游用 Web Audio 现场合成、不随包发布音频文件；本包把同样的音高 / 波形 / 包络离线渲染成
  WAV（22.05 kHz / 单声道 / 16-bit）内嵌进客户端。

  说明：上游仓库目前**没有**附带 LICENSE 文本（根目录没有 LICENSE / COPYING 文件），因此这里无法
  逐字转载其版权声明与免责条款；署名与许可标识保留如上。上游若补充许可证文件，应把完整的
  BSD-3 文本补进本节。

仓库根目录的 `NOTICE.md` 另有完整说明：代码 MIT、美术资源 CC BY-NC-SA 4.0、以及打包进
`lib/live2d-vendor.js` 的 pixi.js / untitled-pixi-live2d-engine（均 MIT）。
