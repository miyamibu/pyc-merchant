import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/index.js", import.meta.url), "utf8");
const lifecycle = source.slice(source.indexOf("function stopMotionTimer()"), source.indexOf("async function loadRuntimeConfig()"));

function harness({ reducedMotion = false, hidden = false } = {}) {
  const documentListeners = new Map();
  const mediaListeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const button = { addEventListener() {} };
  const context = vm.createContext({
    motionState: { sceneIndex: 0, phaseIndex: 0, timer: null, playing: !reducedMotion, pausedByUser: false },
    motionMediaQuery: {
      matches: reducedMotion,
      addEventListener: (type, callback) => mediaListeners.set(type, callback),
    },
    document: {
      visibilityState: hidden ? "hidden" : "visible",
      activeElement: null,
      addEventListener: (type, callback) => documentListeners.set(type, callback),
    },
    el: {
      motionCanvas: {},
      motionPauseBtn: button,
      motionSceneButtons: [],
      motionPhaseTrack: { contains: (node) => node === button, addEventListener() {} },
    },
    MOTION_SCENES: [{ id: "success", phases: [{}, {}] }, { id: "review", phases: [{}, {}] }],
    renderMotionScene() {},
    syncMotionPauseButton() {},
    announceMotion() {},
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(lifecycle, context);
  context.initMotionShowcase();
  return {
    context,
    timers,
    visibility(hidden) {
      context.document.visibilityState = hidden ? "hidden" : "visible";
      documentListeners.get("visibilitychange")();
    },
    reduced(matches) {
      context.motionMediaQuery.matches = matches;
      mediaListeners.get("change")();
    },
    tick() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test("hidden prototype keeps its phase and resumes without catch-up or duplicate timers", () => {
  const ui = harness();
  ui.tick();
  assert.equal(ui.context.motionState.phaseIndex, 1);
  ui.visibility(true);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.context.motionState.phaseIndex, 1);
  ui.visibility(false);
  ui.visibility(false);
  assert.equal(ui.timers.size, 1);
  ui.tick();
  assert.equal(ui.context.motionState.sceneIndex, 1);
  assert.equal(ui.context.motionState.phaseIndex, 0);
});

test("user pause survives visibility and reduced-motion changes", () => {
  const ui = harness();
  ui.context.toggleMotionPlayback();
  ui.visibility(true);
  ui.reduced(true);
  ui.reduced(false);
  ui.visibility(false);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.context.motionState.playing, false);
  ui.context.toggleMotionPlayback();
  assert.equal(ui.timers.size, 1);
});

test("reduced motion stops autoplay including a queued callback and resumes only when visible", () => {
  const ui = harness();
  const pending = ui.timers.values().next().value;
  ui.reduced(true);
  assert.equal(ui.timers.size, 0);
  pending();
  assert.equal(ui.context.motionState.phaseIndex, 0);
  ui.visibility(true);
  ui.reduced(false);
  assert.equal(ui.timers.size, 0);
  ui.visibility(false);
  assert.equal(ui.timers.size, 1);

  const initiallyReduced = harness({ reducedMotion: true });
  assert.equal(initiallyReduced.timers.size, 0);
  initiallyReduced.reduced(false);
  assert.equal(initiallyReduced.timers.size, 1);
});

test("explicit play works with reduced motion and its later pause survives OS changes", () => {
  const ui = harness({ reducedMotion: true });
  assert.equal(ui.timers.size, 0);
  ui.context.toggleMotionPlayback();
  assert.equal(ui.context.motionState.playing, true);
  assert.equal(ui.timers.size, 1);
  ui.tick();
  assert.equal(ui.context.motionState.phaseIndex, 1);
  ui.visibility(true);
  ui.visibility(false);
  assert.equal(ui.timers.size, 1);
  ui.context.toggleMotionPlayback();
  assert.equal(ui.timers.size, 0);
  ui.reduced(false);
  ui.reduced(true);
  ui.reduced(false);
  assert.equal(ui.context.motionState.playing, false);
  assert.equal(ui.timers.size, 0);
});

test("phase focus still blocks advancement and manual scene selection works while suspended", () => {
  const ui = harness();
  ui.context.document.activeElement = ui.context.el.motionPauseBtn;
  ui.tick();
  assert.equal(ui.context.motionState.phaseIndex, 0);
  assert.equal(ui.timers.size, 1);
  ui.visibility(true);
  ui.context.jumpToMotionScene("review");
  ui.context.jumpToMotionPhase(1);
  assert.equal(ui.context.motionState.sceneIndex, 1);
  assert.equal(ui.context.motionState.phaseIndex, 1);
  assert.equal(ui.timers.size, 0);
});

test("all four training scenes render every current phase without replacing the control nodes", () => {
  const makeNode = () => ({ textContent: "", dataset: {}, classList: { toggle() {} }, setAttribute() {} });
  const nodes = new Map();
  const elements = new Proxy({}, { get: (_target, key) => {
    if (!nodes.has(key)) nodes.set(key, makeNode());
    return nodes.get(key);
  } });
  const context = vm.createContext({
    el: elements,
    motionState: { sceneIndex: 0, phaseIndex: 0, playing: false },
    setText: (node, value) => { node.textContent = value; },
    setPill: (node, label) => { node.textContent = label; },
    renderList() {}, renderOpsCard() {}, renderMotionPhaseTrack() {},
    syncMotionButtons() {}, syncMotionPauseButton() {}, announceMotion() {},
  });
  const scenes = source.slice(source.indexOf("const MOTION_SCENES ="), source.indexOf("function setStatus"));
  const renderer = source.slice(source.indexOf("function renderMotionScene"), source.indexOf("function stopMotionTimer"));
  vm.runInContext(`${scenes}\n${renderer}\nthis.scenesForTest = MOTION_SCENES;`, context);
  assert.deepEqual(Array.from(context.scenesForTest, (scene) => scene.id), ["success", "review", "late", "settlement"]);
  const phaseNode = elements.motionCurrentPhaseText;
  for (const [sceneIndex, scene] of context.scenesForTest.entries()) {
    for (const [phaseIndex, phase] of scene.phases.entries()) {
      context.motionState.sceneIndex = sceneIndex;
      context.motionState.phaseIndex = phaseIndex;
      context.renderMotionScene();
      assert.equal(elements.motionCurrentPhaseText, phaseNode);
      assert.equal(phaseNode.textContent, `${phase.label}：${phase.terminalAction}`);
      assert.equal(elements.motionActiveStepPill.textContent, `${phaseIndex + 1} / ${scene.phases.length}`);
      assert.equal(elements.motionScenarioBadge.textContent, scene.label);
      assert.equal(elements.motionCanvas.dataset.motionScene, scene.id);
    }
  }
});

test("training demo controls require the query, development environment and explicit flag together", () => {
  for (const demoQuery of ["0", "1"]) {
    for (const appEnv of ["production", "development"]) {
      for (const flag of [false, true]) {
        let removed = false;
        const node = { classList: { remove() {} }, remove() { removed = true; } };
        const context = vm.createContext({
          state: { demoEnabled: false }, query: { get: () => demoQuery },
          el: { demoControlsSection: node, demoModeBadge: node, demoGuardNote: { textContent: "" } },
        });
        const guard = source.slice(source.indexOf("function guardDemoControls"), source.indexOf("function bindBaseEvents"));
        vm.runInContext(guard, context);
        context.guardDemoControls({ app_env: appEnv, demo_controls_enabled: flag });
        const allowed = demoQuery === "1" && appEnv !== "production" && flag;
        assert.equal(context.state.demoEnabled, allowed);
        assert.equal(removed, !allowed);
      }
    }
  }
});
