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
    if (ok === true) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}
