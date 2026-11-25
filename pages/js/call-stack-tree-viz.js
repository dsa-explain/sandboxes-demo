// call-stack-tree-viz.js
// Plays the same call/return trace as the call-stack sandbox, but draws each
// call as a node in a tree. Parameters sit inside the node. A new call grows
// a child. When that call returns, the node turns grey and an arrow shows the
// value going back to its caller.

import { getPyodide } from "./utils/pyodide-loader.js";
import { formatCapturedOutput } from "./utils/py-harness-utils.js";
import { createPlaybackTimer } from "./utils/frame-playback.js";
import { buildCallStackHarness } from "./call-stack-viz.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const LEVEL = 112;
const H_GAP = 26;
const SIDE_PAD = 32;
const TOP_PAD = 22;
const BOTTOM_PAD = 28;
const ARGS_LIMIT = 26;
const RETURN_LIMIT = 14;

let mountSeq = 0;

export const callTreeStarterCode = [
  "def recursive_function(n):",
  "    if n <= 1:",
  "        return n",
  "    left = recursive_function(n - 1)",
  "    right = recursive_function(n - 2)",
  "    return left + right",
  "",
  "print(recursive_function(4))",
].join("\n");

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function cloneNode(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    args: node.args,
    phase: node.phase,
    value: node.value,
    children: node.children.map(cloneNode),
  };
}

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

function doneMessage(roots, error) {
  let count = 0;
  let stillRunning = false;
  walk(roots, (node) => {
    count += 1;
    if (node.phase === "live") stillRunning = true;
  });
  if (error === "TOO_MANY_CALLS") {
    return "Stopped after too many calls. The tree below is where tracing stopped.";
  }
  if (error) {
    return count
      ? `${error}. These calls were still in the tree.`
      : String(error);
  }
  if (stillRunning) return "Tracing finished with calls still in the tree.";
  if (count) return "Finished.";
  return "Finished. The call tree is empty.";
}

function visibleArgs(node) {
  const args = String(node.args ?? "").trim();
  return truncate(args || node.name || "function", ARGS_LIMIT);
}

export function visibleReturn(value) {
  return truncate(value ?? "", RETURN_LIMIT);
}

function radiusAlong(rx, ry, ux, uy) {
  const denom = (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry);
  return denom > 0 ? 1 / Math.sqrt(denom) : Math.max(rx, ry);
}

/** Short arrow from a finished call back toward its caller, with the value beside it. */
export function arrowGeometry(node, parent) {
  const label = visibleReturn(node.value);
  if (!parent) {
    const x1 = node.x;
    const y1 = node.y - node.ry - 8;
    const x2 = node.x;
    const y2 = y1 - 30;
    return {
      x1,
      y1,
      x2,
      y2,
      lx: x1 + 12,
      ly: (y1 + y2) / 2,
      label,
      anchor: "start",
    };
  }

  const dx = parent.x - node.x;
  const dy = parent.y - node.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let px = -uy;
  let py = ux;
  const side = node.x < parent.x - 0.5 ? -1 : 1;
  if (px * side < 0 || (Math.abs(node.x - parent.x) <= 0.5 && px < 0)) {
    px = -px;
    py = -py;
  }

  const dist = radiusAlong(node.rx, node.ry, ux, uy) + 9;
  const arrowLen = Math.min(32, Math.max(18, len * 0.28));
  const x1 = node.x + ux * dist + px * 12;
  const y1 = node.y + uy * dist + py * 12;
  const x2 = x1 + ux * arrowLen;
  const y2 = y1 + uy * arrowLen;
  return {
    x1,
    y1,
    x2,
    y2,
    lx: (x1 + x2) / 2 + px * 14,
    ly: (y1 + y2) / 2 + py * 14,
    label,
  };
}

function nodeSize(node, showName) {
  const main = visibleArgs(node);
  const name = showName ? truncate(node.name || "function", ARGS_LIMIT) : "";
  const textW = Math.max(main.length * 8.1, name.length * 6.6);
  const ry = showName ? 34 : 28;
  const rx = Math.max(ry, textW / 2 + 16);
  const returned = node.phase === "return" || node.phase === "raise";
  const extra = returned
    ? Math.min(110, Math.max(18, visibleReturn(node.value).length * 8.4 + 12))
    : 0;
  return { rx, ry, box: rx * 2 + extra };
}

function layoutNode(node, showName) {
  const size = nodeSize(node, showName);
  node.rx = size.rx;
  node.ry = size.ry;
  if (!node.children.length) {
    node.subtree = size.box;
    return;
  }
  for (const child of node.children) layoutNode(child, showName);
  const kids = node.children.reduce((sum, child) => sum + child.subtree, 0)
    + H_GAP * (node.children.length - 1);
  node.subtree = Math.max(size.box, kids);
  let cursor = -kids / 2;
  for (const child of node.children) {
    child.offsetX = cursor + child.subtree / 2;
    cursor += child.subtree + H_GAP;
  }
}

function place(node, x, depth, acc) {
  node.x = x;
  node.y = node.ry + depth * LEVEL;
  acc.push(node);
  for (const child of node.children) place(child, x + child.offsetX, depth + 1, acc);
}

function layoutForest(roots, showName) {
  if (!roots.length) return { width: 280, height: 180 };
  for (const root of roots) layoutNode(root, showName);

  const nodes = [];
  const total = roots.reduce((sum, root) => sum + root.subtree, 0)
    + H_GAP * (Math.max(roots.length - 1, 0));
  let left = -total / 2;
  for (const root of roots) {
    place(root, left + root.subtree / 2, 0, nodes);
    left += root.subtree + H_GAP;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const node of nodes) {
    include(node.x - node.rx, node.y - node.ry);
    include(node.x + node.rx, node.y + node.ry);
    if (node.phase !== "return" && node.phase !== "raise") continue;
    const parent = node.parentId == null ? null : byId.get(node.parentId);
    const arrow = arrowGeometry(node, parent ?? null);
    include(arrow.x1, arrow.y1);
    include(arrow.x2, arrow.y2);
    const textW = arrow.label.length * 8.4 + 8;
    if (arrow.anchor === "start") {
      include(arrow.lx, arrow.ly - 11);
      include(arrow.lx + textW, arrow.ly + 11);
    } else {
      include(arrow.lx - textW / 2, arrow.ly - 11);
      include(arrow.lx + textW / 2, arrow.ly + 11);
    }
  }

  const shiftX = SIDE_PAD - minX;
  const shiftY = TOP_PAD - minY;
  for (const node of nodes) {
    node.x += shiftX;
    node.y += shiftY;
  }
  return {
    width: Math.ceil(maxX + shiftX + SIDE_PAD),
    height: Math.ceil(maxY + shiftY + BOTTOM_PAD),
  };
}

function stampPositions(nodes, positions) {
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (pos) {
      node.x = pos.x;
      node.y = pos.y;
      node.rx = pos.rx;
      node.ry = pos.ry;
    }
    stampPositions(node.children, positions);
  }
}

/** Turn raw trace events into one drawable call tree per step. */
export function eventsToTreeSnapshots(events, error = null) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    return [{
      kind: "done",
      line: null,
      message: error
        ? String(error)
        : "No function calls to show. Define a function and call it from the editor.",
      roots: [],
      activeId: null,
      focusId: null,
      showName: false,
      width: 280,
      height: 180,
    }];
  }

  const roots = [];
  const stack = [];
  const snapshots = [];
  let nextId = 1;

  for (const ev of list) {
    const name = ev?.name || "function";
    const args = ev?.args ?? "";
    const line = Number.isFinite(Number(ev?.line)) ? Number(ev.line) : null;

    if (ev?.type === "call") {
      const parent = stack.length ? stack[stack.length - 1] : null;
      const node = {
        id: nextId,
        parentId: parent ? parent.id : null,
        name,
        args,
        phase: "live",
        value: null,
        children: [],
      };
      nextId += 1;
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
      snapshots.push({
        kind: "call",
        line,
        message: `${name} called with parameters [${args}]`,
        roots: roots.map(cloneNode),
        activeId: node.id,
        focusId: node.id,
      });
      continue;
    }

    if (ev?.type !== "return" && ev?.type !== "raise") continue;

    const node = stack.pop();
    if (!node) continue;
    const phase = ev.type === "return" ? "return" : "raise";
    node.phase = phase;
    node.value = phase === "return" ? (ev.value ?? "None") : (ev.error ?? "Exception");
    const active = stack.length ? stack[stack.length - 1] : null;
    const message = phase === "return"
      ? `${node.name} call from [${node.args}] returned ${node.value}`
      : `${node.name} call from [${node.args}] raised ${node.value}`;
    snapshots.push({
      kind: phase,
      line,
      message,
      roots: roots.map(cloneNode),
      activeId: active ? active.id : null,
      focusId: node.id,
    });
  }

  snapshots.push({
    kind: "done",
    line: null,
    message: doneMessage(roots, error),
    roots: roots.map(cloneNode),
    activeId: null,
    focusId: null,
  });

  const names = new Set();
  walk(roots, (node) => names.add(node.name));
  const showName = names.size > 1;
  const laid = layoutForest(roots, showName);
  const positions = new Map();
  walk(roots, (node) => {
    positions.set(node.id, { x: node.x, y: node.y, rx: node.rx, ry: node.ry });
  });
  for (const snap of snapshots) {
    snap.showName = showName;
    snap.width = laid.width;
    snap.height = laid.height;
    stampPositions(snap.roots, positions);
  }
  return snapshots;
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) el.setAttribute(key, String(value));
  }
  return el;
}

function drawTree(host, snap, markerPrefix) {
  host.replaceChildren();
  if (!snap?.roots?.length) {
    const empty = document.createElement("div");
    empty.className = "ct-empty";
    empty.textContent = "The call tree is empty.";
    host.append(empty);
    return;
  }

  const svg = svgEl("svg", {
    class: "ct-svg",
    width: snap.width,
    height: snap.height,
    viewBox: `0 0 ${snap.width} ${snap.height}`,
    role: "img",
    "aria-hidden": "true",
  });

  const defs = svgEl("defs");
  const blue = svgEl("linearGradient", { id: `${markerPrefix}-blue`, x1: "0", y1: "0", x2: "0", y2: "1" });
  blue.append(
    svgEl("stop", { offset: "0%", "stop-color": "#5b9bf5" }),
    svgEl("stop", { offset: "58%", "stop-color": "#3b82f6" }),
    svgEl("stop", { offset: "100%", "stop-color": "#3474e0" }),
  );
  const grey = svgEl("linearGradient", { id: `${markerPrefix}-grey`, x1: "0", y1: "0", x2: "0", y2: "1" });
  grey.append(
    svgEl("stop", { offset: "0%", "stop-color": "#ececf2" }),
    svgEl("stop", { offset: "58%", "stop-color": "#d8d8e2" }),
    svgEl("stop", { offset: "100%", "stop-color": "#cccdd6" }),
  );
  const arrowHead = svgEl("marker", {
    id: `${markerPrefix}-arrow`,
    markerUnits: "userSpaceOnUse",
    markerWidth: "14",
    markerHeight: "14",
    refX: "11",
    refY: "7",
    orient: "auto",
  });
  arrowHead.append(svgEl("path", { d: "M2,1.5 L12,7 L2,12.5 Z", fill: "#19162b" }));
  const errorHead = svgEl("marker", {
    id: `${markerPrefix}-arrow-error`,
    markerUnits: "userSpaceOnUse",
    markerWidth: "14",
    markerHeight: "14",
    refX: "11",
    refY: "7",
    orient: "auto",
  });
  errorHead.append(svgEl("path", { d: "M2,1.5 L12,7 L2,12.5 Z", fill: "#9f1239" }));
  defs.append(blue, grey, arrowHead, errorHead);
  svg.append(defs);

  const edges = svgEl("g", { class: "ct-edges" });
  const arrows = svgEl("g", { class: "ct-arrows" });
  const nodes = svgEl("g", { class: "ct-nodes" });
  const byId = new Map();
  walk(snap.roots, (node) => byId.set(node.id, node));

  function appendReturnArrow(node, parent) {
    const arrow = arrowGeometry(node, parent);
    const group = svgEl("g", {
      class: node.id === snap.focusId ? "ct-return ct-return-new" : "ct-return",
    });
    const title = svgEl("title");
    title.textContent = node.phase === "raise"
      ? `${node.name} raised ${node.value}`
      : `${node.name} returned ${node.value}`;
    group.append(title);
    group.append(svgEl("line", {
      x1: arrow.x1,
      y1: arrow.y1,
      x2: arrow.x2,
      y2: arrow.y2,
      class: "ct-return-line",
      "marker-end": `url(#${markerPrefix}-arrow${node.phase === "raise" ? "-error" : ""})`,
    }));
    const labelClass = node.phase === "raise"
      ? "ct-return-label ct-return-label-error"
      : "ct-return-label";
    const label = svgEl("text", {
      x: arrow.lx,
      y: arrow.ly,
      class: arrow.anchor === "start" ? `${labelClass} ct-return-label-start` : labelClass,
    });
    label.textContent = arrow.label;
    group.append(label);
    arrows.append(group);
  }

  for (const node of byId.values()) {
    if (node.parentId == null) continue;
    const parent = byId.get(node.parentId);
    if (!parent) continue;
    const done = node.phase === "return" || node.phase === "raise";
    edges.append(svgEl("line", {
      x1: parent.x,
      y1: parent.y,
      x2: node.x,
      y2: node.y,
      class: done ? "ct-edge ct-edge-done" : "ct-edge",
    }));
    if (done) appendReturnArrow(node, parent);
  }

  for (const node of byId.values()) {
    if (node.parentId == null && (node.phase === "return" || node.phase === "raise")) {
      appendReturnArrow(node, null);
    }

    const done = node.phase === "return" || node.phase === "raise";
    const classes = ["ct-node"];
    if (node.phase === "raise") classes.push("ct-node-error");
    else if (done) classes.push("ct-node-done");
    else classes.push("ct-node-live");
    if (node.id === snap.activeId && node.phase === "live") classes.push("ct-node-active");
    if (node.id === snap.focusId && snap.kind === "call") classes.push("ct-node-new");

    const group = svgEl("g", { class: classes.join(" "), "data-id": node.id });
    const title = svgEl("title");
    const fullArgs = String(node.args ?? "").trim();
    title.textContent = done
      ? `${node.name}(${fullArgs}) → ${node.value}`
      : `${node.name}(${fullArgs})`;
    group.append(title);
    group.append(svgEl("ellipse", {
      cx: node.x,
      cy: node.y,
      rx: node.rx,
      ry: node.ry,
      class: "ct-node-shape",
      fill: done ? `url(#${markerPrefix}-grey)` : `url(#${markerPrefix}-blue)`,
    }));

    if (snap.showName) {
      const name = svgEl("text", {
        x: node.x,
        y: node.y - 9,
        class: "ct-node-label ct-node-name",
      });
      name.textContent = truncate(node.name || "function", ARGS_LIMIT);
      const args = svgEl("text", {
        x: node.x,
        y: node.y + 10,
        class: "ct-node-label",
      });
      args.textContent = visibleArgs(node);
      group.append(name, args);
    } else {
      const args = svgEl("text", {
        x: node.x,
        y: node.y,
        class: "ct-node-label",
      });
      args.textContent = visibleArgs(node);
      group.append(args);
    }
    nodes.append(group);
  }

  svg.append(edges, arrows, nodes);
  host.append(svg);
}

/**
 * @param {HTMLElement} container
 * @param {{ editor?: object, stepDelayMs?: number }} [options]
 */
export function mountCallStackTreeViz(container, options = {}) {
  if (!container) return null;

  const editor = options.editor ?? null;
  const stepDelayMs = options.stepDelayMs ?? 820;
  const markerPrefix = `ct${mountSeq += 1}`;
  const getCode = () => editor?.getCode?.() ?? "";

  let snapshots = [];
  let frameIndex = -1;
  let compiledCode = null;
  let playable = false;
  let compiling = false;
  const playback = createPlaybackTimer();

  container.innerHTML = "";
  container.classList.add("ct-root");

  const heading = document.createElement("div");
  heading.className = "ct-heading";
  heading.textContent = "Call tree";

  const narration = document.createElement("div");
  narration.className = "ct-narration";
  narration.setAttribute("role", "status");
  narration.setAttribute("aria-live", "polite");

  const stage = document.createElement("div");
  stage.className = "ct-stage";

  const treeWrap = document.createElement("div");
  treeWrap.className = "ct-tree-wrap";
  stage.append(treeWrap);

  const controls = document.createElement("div");
  controls.className = "ct-controls";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "ht-nav-btn";

  const stepBtn = document.createElement("button");
  stepBtn.type = "button";
  stepBtn.className = "ht-nav-btn";
  stepBtn.textContent = "Step";

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "ht-nav-btn ht-nav-btn-ghost";
  resetBtn.textContent = "Reset tree";

  const stepLabel = document.createElement("div");
  stepLabel.className = "ct-step-label";

  controls.append(playBtn, stepBtn, resetBtn, stepLabel);
  container.append(heading, narration, stage, controls);

  function pinFocus(snap) {
    if (!snap) {
      treeWrap.scrollTop = 0;
      treeWrap.scrollLeft = 0;
      return;
    }
    const id = snap.focusId ?? snap.activeId;
    const node = id == null ? null : treeWrap.querySelector(`[data-id="${id}"]`);
    if (!node) return;
    const margin = 36;
    const wrapRect = treeWrap.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (nodeRect.left < wrapRect.left + margin) {
      treeWrap.scrollLeft -= wrapRect.left + margin - nodeRect.left;
    } else if (nodeRect.right > wrapRect.right - margin) {
      treeWrap.scrollLeft += nodeRect.right - (wrapRect.right - margin);
    }
    if (nodeRect.top < wrapRect.top + margin) {
      treeWrap.scrollTop -= wrapRect.top + margin - nodeRect.top;
    } else if (nodeRect.bottom > wrapRect.bottom - margin) {
      treeWrap.scrollTop += nodeRect.bottom - (wrapRect.bottom - margin);
    }
  }

  function idleMessage() {
    if (snapshots.length) return "Press Run to watch the call tree.";
    return "Write a function, call it, then press Run.";
  }

  function runLabel() {
    if (compiling) return "Running…";
    if (playback.isPlaying()) return "Pause";
    if (frameIndex >= 0 && frameIndex < snapshots.length - 1) return "Play";
    return "Run";
  }

  function render() {
    const snap = frameIndex >= 0 && frameIndex < snapshots.length ? snapshots[frameIndex] : null;
    if (!snap) {
      narration.textContent = idleMessage();
      drawTree(treeWrap, null, markerPrefix);
    } else {
      narration.textContent = snap.message;
      drawTree(treeWrap, snap, markerPrefix);
      if (snap.kind === "done") {
        editor?.clearLineHighlight?.();
        if (editor?.locked) editor.unlock();
      } else if (snap.line != null) {
        editor?.highlightLine?.(snap.line);
      }
    }
    if (!snapshots.length) stepLabel.textContent = "";
    else if (frameIndex < 0) stepLabel.textContent = `0 / ${snapshots.length}`;
    else stepLabel.textContent = `${frameIndex + 1} / ${snapshots.length}`;
    playBtn.textContent = runLabel();
    playBtn.disabled = compiling;
    stepBtn.disabled = compiling || playback.isPlaying();
    resetBtn.disabled = compiling;
    requestAnimationFrame(() => pinFocus(snap));
  }

  async function compile() {
    const code = getCode();
    if (!code.trim()) {
      snapshots = eventsToTreeSnapshots([], null);
      playable = false;
      compiledCode = code;
      frameIndex = 0;
      editor?.clearStdout?.();
      return false;
    }

    compiling = true;
    playBtn.disabled = true;
    stepBtn.disabled = true;
    resetBtn.disabled = true;
    playBtn.textContent = "Running…";
    narration.textContent = "Loading Python…";
    drawTree(treeWrap, null, markerPrefix);

    try {
      const pyodide = await getPyodide();
      narration.textContent = "Running your code…";
      const rawJson = await pyodide.runPythonAsync(buildCallStackHarness(code));
      const payload = JSON.parse(typeof rawJson === "string" ? rawJson : String(rawJson));
      const captured = formatCapturedOutput(payload.stdout, payload.stderr);
      const events = Array.isArray(payload.events) ? payload.events : [];
      snapshots = eventsToTreeSnapshots(events, payload.error);
      playable = events.length > 0;
      compiledCode = code;
      frameIndex = playable ? -1 : 0;
      if (captured) {
        editor?.setStdout?.(captured, {
          isError: Boolean(payload.error) && payload.error !== "TOO_MANY_CALLS",
        });
      } else {
        editor?.clearStdout?.();
      }
      return playable;
    } catch (err) {
      console.error(err);
      snapshots = eventsToTreeSnapshots([], String(err));
      playable = false;
      compiledCode = code;
      frameIndex = 0;
      editor?.setStdout?.(String(err), { isError: true });
      return false;
    } finally {
      compiling = false;
    }
  }

  async function ensureSnapshots() {
    const code = getCode();
    if (compiledCode === code && snapshots.length) return playable;
    return compile();
  }

  function tick() {
    if (!playback.isPlaying()) return;
    if (frameIndex >= snapshots.length - 1) {
      playback.stop();
      render();
      return;
    }
    frameIndex += 1;
    render();
    if (playback.isPlaying() && frameIndex < snapshots.length - 1) {
      playback.schedule(tick, stepDelayMs);
    } else {
      playback.stop();
      render();
    }
  }

  async function play() {
    if (compiling) return;
    if (playback.isPlaying()) {
      playback.stop();
      render();
      return;
    }
    editor?.lock?.();
    const ok = await ensureSnapshots();
    if (!ok) {
      if (editor?.locked) editor.unlock();
      render();
      return;
    }
    if (frameIndex >= snapshots.length - 1) frameIndex = -1;
    playback.start();
    tick();
  }

  async function stepForward() {
    if (compiling || playback.isPlaying()) return;
    editor?.lock?.();
    const ok = await ensureSnapshots();
    if (!ok) {
      if (editor?.locked) editor.unlock();
      render();
      return;
    }
    if (frameIndex >= snapshots.length - 1) frameIndex = -1;
    frameIndex += 1;
    render();
  }

  function rewind() {
    playback.stop();
    frameIndex = playable ? -1 : (snapshots.length ? 0 : -1);
    editor?.unlock?.();
    editor?.clearLineHighlight?.();
    render();
  }

  if (editor && typeof editor.reset === "function") {
    const originalReset = editor.reset.bind(editor);
    editor.reset = () => {
      playback.stop();
      snapshots = [];
      playable = false;
      compiledCode = null;
      frameIndex = -1;
      originalReset();
      render();
    };
  }

  playBtn.addEventListener("click", () => {
    play();
  });
  stepBtn.addEventListener("click", () => {
    stepForward();
  });
  resetBtn.addEventListener("click", () => {
    rewind();
  });

  render();
  getPyodide().catch(() => {});

  return { play, step: stepForward, reset: rewind };
}
