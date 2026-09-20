# model-packs

宠物构建的**源模型包**，用于 `tools/build-pet.mjs` 生成可安装的宠物包。

## DS鼠控版

| | |
|---|---|
| 模型 | DS鲸鱼娘 |
| 作者 | B站@氵六青（[11272072](https://space.bilibili.com/11272072)，交流群 645169617） |
| 授权 | 无偿分享。商用直播 ✅ 自印物料 ✅；**禁止盗用及出售**。已获作者转载授权。 |

原始文件名是中文（`脸红.exp3.json` 等），**不能直接当宠物用** —— DSH 的 manifest
校验只允许 `[A-Za-z0-9._-]` 的路径片段，中文会让整个宠物加载失败。
`tools/build-pet.mjs` 负责把文件名转成 ASCII slug，并生成完整的
`model3.json`（源文件里既没有 `Motions` 也没有 `Expressions` 声明）。

用法：

```bash
# 构建到 %DSH_HOME%/pets/ds-whale-girl
node tools/build-pet.mjs

# 或指定源包 / 输出位置
node tools/build-pet.mjs --src model-packs/DS鼠控版 --dest ./examples/ds-whale-girl
```

仓库里的 `examples/ds-whale-girl/` 就是这个命令的产物。
