---
name: client-state
description: >
  插件客户端（手写 React bundle）里跨 render / 跨 effect 共享状态必须用 ref，
  以及 useCallback 依赖数组漏项导致的"静默 undefined"。
whenToUse: >
  写或改 lib/client.js 的组件状态、把诊断/回调挂到控制器上、加 useEffect 或
  useCallback、出现"功能没反应但也不报错"时
---

# 客户端状态：ref vs 普通值

## 跨 render 存活的东西必须是 ref

`const x = ...` 和 `const x = { ... }` 在**每次重渲染时都重建**。
如果一个 effect 的依赖是 `[]`（挂 API、订阅），另一个是 `[ready, pet]`
（干活），两边闭包里的 `x` **不是同一个对象** —— 各改各的，读的那个永远是空的。

**这个错误我在同一天里犯了三次**，每次都表现为"功能正常但读数是 0/undefined"：

| 症状 | 原因 |
|---|---|
| `slotSelections()` 返回 undefined | 引用了组件作用域的 ref，却挂在控制器的 API 上 |
| `fidgetNow()` 永远不生效 | `fidgetLive` 是 `let`，每次 render 重置为 false |
| 摸鱼计数永远是 `{}` | `fidgetTally` 是普通对象，API 与 fire() 各持一个 |

规则：
- 要跨 effect / 跨 render 共享 → `useRef`
- 要在组件外（控制器的 API 对象）被读 → 在**组件的 useEffect 里挂载**，
  不要在控制器内部引用组件作用域的变量（那是 ReferenceError，
  但对外表现是**静默的 undefined，不是报错**）

## useCallback 的依赖数组漏项 = 闭包永远拿到旧值

`chooseSlotOption` 的依赖是 `[applyExpressions]`，**没有 `pet`**。
它在 catalog 还没加载完时就创建了闭包，于是永久持有 `pet === undefined`，
所有 `pet?.expressionSlots ?? []` 查询**静默地看到空数组**。

表现：点"写本本"什么都不发生；`clears`（要清另一个槽位）一直是坏的；
互斥选项永远不互斥。**全都没有报错。**

修法：要么把 `pet` 加进依赖，要么在回调里读 `petRef.current`（推荐后者，
避免每次 catalog 变化都重建回调和重新订阅）。

## 排查手法

"功能没反应但不报错"时，按这个顺序查：

1. 那个函数**真的被调用了吗**？在最顶端加一个 ref 计数器，读它。
2. 它读的状态**是同一个对象吗**？把关键值也暴露成诊断读一下。
3. 回调**依赖数组**里有没有它读的每一个外部值？
4. 是不是**作用域错了**（组件的东西被控制器引用，或反之）？

第 3、4 条都不报错，只能靠"把中间值暴露出来看"发现。

## 顺带：诊断本身也会骗人

计数器/标志位如果不是 ref，同样的坑会让人误判产品。
**加诊断时先用一个小探针确认诊断自己是对的**，再去改产品。
