/**
 * Vendor bundle entry — the Live2D rendering stack the model mount needs.
 * esbuild emits it as an IIFE that publishes 'window.__dshLive2dPetVendor',
 * which the client bundle lazy-loads after the user-supplied Cubism Core
 * runtime ('window.Live2DCubismCore') is already present.
 *
 * Both dependencies are MIT-licensed and therefore redistributable inside
 * this plugin. The proprietary Cubism Core runtime is NEVER bundled here: it
 * stays a user-supplied script (see README).
 */
import { Application, Assets, Point, extensions } from 'pixi.js'
import {
  MotionPriority,
  configureCubismSDK,
  Live2DModel,
  Live2DPlugin,
} from 'untitled-pixi-live2d-engine/cubism'

const globalScope = globalThis as unknown as Record<string, unknown>
globalScope.__dshLive2dPetVendor = {
  Application,
  // 'Assets' 是 Pixi 的资源加载门面。客户端要靠它把贴图从「blob Worker 里取」切成
  // 「主线程取」—— 有的外壳（如 DSH NEXT 的 dsh-app: 协议）只给主线程的请求补能力
  // 令牌，Worker 发出的请求一律 403（issue #10）。
  Assets,
  Point,
  extensions,
  MotionPriority,
  configureCubismSDK,
  Live2DModel,
  Live2DPlugin,
}
