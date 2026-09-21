// Readiness handshake shared by every driver.
//
// Each driver used to carry a fixed `await sleep(3000)` after the harness set
// title=done. That number was the worst case someone measured once, and every
// driver paid it on every run: profiling showed the model and its click mask are
// already painted by the time the title flips, so all of it was dead time —
// roughly 30s of a 7-minute suite, and it grows with every driver added.
//
// Polling a real condition costs nothing when the condition is already true and
// stays correct when the machine is slow, which a fixed sleep never is.

/** Resolve once the pet has loaded and produced its click mask. */
export async function waitReady(ev, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let ok = false
    try {
      ok = await ev('!!(window.__dshLive2dPet && window.__dshLive2dPet.maskInfo && window.__dshLive2dPet.maskInfo().present)')
    } catch {
      ok = false
    }
    if (ok === true) {
      // Pause the scheduled fidget once, here, so no driver has to remember.
      // A 摸鱼 rewrites the slot selections every 12-26s — exactly what a slow
      // assertion is watching — which made four drivers look broken under
      // parallel load and pass when run alone.
      try { await ev('window.__dshLive2dPet.setFidgetEnabled && window.__dshLive2dPet.setFidgetEnabled(false)') } catch {}
      return true
    }
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * Open the control panel the way a user does: right-click the pet.
 *
 * The pet has no toolbar any more — a hover-revealed bar covered the character
 * and hover is a poor fit for a click-through overlay — so every driver that
 * needs the panel uses this instead of clicking a button that no longer exists.
 */
export async function openPanel(ev) {
  return ev('(() => {'
    + ' const h = document.querySelector("[data-dsh-live2d-pet] [data-hit]")'
    + '   || document.querySelector("[data-dsh-live2d-pet] [data-stage]");'
    + ' if (!h) return false;'
    + ' h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));'
    + ' return true })()')
}

/** Close the panel through its own close button. */
export async function closePanel(ev) {
  return ev('(() => {'
    + ' const b = document.querySelector("[data-dsh-live2d-pet] [data-panel] [data-close]");'
    + ' if (!b) return false; b.click(); return true })()')
}

/** Click a control in the panel footer by its visible label. */
export async function panelFooter(ev, label) {
  return ev('(() => {'
    + ' const bs = Array.from(document.querySelectorAll("[data-dsh-live2d-pet] [data-panel] footer button"));'
    + ' const b = bs.find((x) => x.textContent === ' + JSON.stringify(label) + ');'
    + ' if (!b) return false; b.click(); return true })()')
}

/**
 * Stop the SCHEDULED idle fidget for the rest of the run.
 *
 * A 摸鱼 fires every 12-26s and rewrites the slot selections — which is exactly
 * what a slow assertion is usually watching. Four drivers looked broken under
 * parallel load and passed when run alone because of it. Forced fidgets
 * (fidgetNow) still work, so the drivers that TEST the fidget are unaffected.
 */
/**
 * 页面里有没有未捕获异常。
 *
 * 这是**第一条该看的信号**：处理器里抛异常时，功能会静默失效（表现是「点了没反应」），
 * 而 DOM/参数看起来一切正常。曾有过一次：pointermove 里 DRAG_SLOP_PX 未定义，
 * 每次移动都抛异常，拖动整个失效，而 __errors 里一直躺着那行 ReferenceError，
 * 我却查了七八轮才想起来看它。
 */
export async function pageErrors(ev) {
  try {
    return JSON.parse(await ev('JSON.stringify(window.__errors ?? [])') ?? '[]')
  } catch {
    return []
  }
}
export async function pauseFidget(ev) {
  return ev('window.__dshLive2dPet.setFidgetEnabled(false)')
}
