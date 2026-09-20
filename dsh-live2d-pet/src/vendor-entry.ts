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
import { Application, Point, extensions } from 'pixi.js'
import {
  MotionPriority,
  configureCubismSDK,
  Live2DModel,
  Live2DPlugin,
} from 'untitled-pixi-live2d-engine/cubism'

const globalScope = globalThis as unknown as Record<string, unknown>
globalScope.__dshLive2dPetVendor = {
  Application,
  Point,
  extensions,
  MotionPriority,
  configureCubismSDK,
  Live2DModel,
  Live2DPlugin,
}
