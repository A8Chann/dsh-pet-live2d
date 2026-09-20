// Regenerate the DBG variant from the live client source.
//
// The variant is a copy with a diagnostic hook appended, so it goes stale the
// moment client.js changes — which silently broke cdp-motion once. Drivers that
// need the hook should run this first, or the suite's runner does it for them.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, PLUGIN } from './paths.mjs'

const ANCHOR = "        model = loaded;\n        modelRef.current = loaded;"
const HOOK = `
        if (typeof window !== "undefined") {
          window.__PET_DBG = {
            app,
            get model() { return app.stage.children.find((c) => c.internalModel !== undefined) ?? null; },
            get core() { const m = app.stage.children.find((c) => c.internalModel !== undefined); return m ? m.internalModel.coreModel : null; },
          };
        }`

const source = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
if (!source.includes(ANCHOR)) throw new Error('client.js: variant anchor not found')
writeFileSync(join(HERE, 'variants', 'client-DBG.js'), source.replace(ANCHOR, ANCHOR + HOOK))
