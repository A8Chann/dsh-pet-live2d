// Wait for the plugin bundle to register, apply it with a stub context, then
// poll the DOM for the rendered pet and publish the verdict.
const report = { core: typeof window.Live2DCubismCore, vendor: typeof window.__dshLive2dPetVendor, applied: false, error: null, net: [], dom: null };

function finish(verdict) {
  report.dom = verdict;
  let node = document.getElementById('__result');
  if (node === null) { node = document.createElement('pre'); node.id = '__result'; document.body.appendChild(node); }
  node.textContent = 'RESULT ' + JSON.stringify(report);
  document.title = 'done';
}

// Record every fetch the plugin makes and its status.
const realFetch = window.fetch;
window.fetch = function (...args) {
  const url = String(args[0]);
  return realFetch.apply(this, args).then((response) => {
    report.net.push(response.status + ' ' + url);
    return response;
  }, (error) => {
    report.net.push('ERR ' + url + ' :: ' + (error && error.message));
    throw error;
  });
};

async function main() {
  for (let i = 0; i < 100 && window.__pluginExports === undefined; i++) await new Promise(r => setTimeout(r, 50));
  const exports = window.__pluginExports && window.__pluginExports['dsh-pet-live2d'];
  if (exports === undefined) { report.error = window.__bootError || 'plugin bundle did not register'; return finish(null); }
  try {
    exports.apply({ effect: (fn) => { try { return fn(); } catch { return () => {}; } } });
    report.applied = true;
  } catch (error) { report.error = String(error && error.stack || error); return finish(null); }

  let stage = null;
  let canvas = null;
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 100));
    stage = document.querySelector('[data-dsh-live2d-pet-root] [data-stage]');
    canvas = stage && stage.querySelector('canvas');
    if (canvas !== null) break;
  }
  const bubble = document.querySelector('[data-dsh-live2d-pet-root] [data-bubble]');
  const hint = document.querySelector('[data-dsh-live2d-pet-root] [data-hint]');
  const verdict = {
    stage: stage !== null,
    canvas: canvas !== null,
    canvasW: canvas === null ? 0 : canvas.width,
    canvasH: canvas === null ? 0 : canvas.height,
    webgl: (() => { try { return canvas !== null && (canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null); } catch { return false; } })(),
    bubble: bubble === null ? null : bubble.textContent,
    hint: hint === null ? null : hint.textContent,
    errors: window.__errors,
  };
  // Leave the UI untouched: the driver exercises it after the verdict lands.
  await new Promise(r => setTimeout(r, 400));
  finish(verdict);
}

main();
