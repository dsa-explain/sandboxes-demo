// stack-viz.js
// Runs student Python and plays back the list named `stack`.
// Each append / pop (and any other change to that list) is one frame.
// Adding or removing an item also leaves a history record, logged for now.

import { getPyodide } from "./utils/pyodide-loader.js";
import { formatCapturedOutput } from "./utils/py-harness-utils.js";
import { createPlaybackTimer } from "./utils/frame-playback.js";

const MAX_SAMPLES = 400;
const MAX_ITEMS = 500;
const MAX_REPR = 20000;

/** Cells kept in view before the stack scroller appears. */
export const VISIBLE_STACK_CELLS = 6;

/** Shown characters before a cell is cut and the rest is hover-only. */
export const CELL_CHAR_LIMIT = 50;

/** How long playback holds the orange blink before the cell leaves. */
export const POP_BLINK_MS = 2600;

const HISTORY_ACTIONS = new Set([
  "push",
  "pop",
  "insert",
  "remove",
  "assign",
  "clear",
  "update",
]);

export const stackStarterCode = [
  "stack = []",
  "",
  'stack.append("plate")',
  'stack.append("bowl")',
  'stack.append("cup")',
  'stack.append("fork")',
  'stack.append("spoon")',
  'stack.append("knife")',
  'stack.append("napkin")',
  'print("popped", stack.pop())',
  'stack.append("pancakes with strawberries, syrup, and a very long note")',
].join("\n");

export function truncateCellText(text) {
  const full = String(text ?? "");
  if (full.length <= CELL_CHAR_LIMIT) {
    return { full, shown: full, truncated: false };
  }
  return {
    full,
    shown: `${full.slice(0, CELL_CHAR_LIMIT)}…`,
    truncated: true,
  };
}

function sameItems(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPrefix(shorter, longer) {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return n;
}

/** Index in `after` of the single inserted item, or -1. */
function insertedAt(before, after) {
  if (after.length !== before.length + 1) return -1;
  const idx = firstDiff(before, after);
  for (let i = idx; i < before.length; i += 1) {
    if (before[i] !== after[i + 1]) return -1;
  }
  return idx;
}

/** Index in `before` of the single removed item, or -1. */
function removedAt(before, after) {
  if (before.length !== after.length + 1) return -1;
  const idx = firstDiff(after, before);
  for (let i = idx; i < after.length; i += 1) {
    if (after[i] !== before[i + 1]) return -1;
  }
  return idx;
}

/**
 * Describe how `stack` changed.
 * `before === null` means the name was not a list yet.
 * @param {string[] | null} before
 * @param {string[]} after
 */
export function classifyStackChange(before, after) {
  if (before == null) {
    if (after.length === 0) return { action: "init", value: null };
    if (after.length === 1) return { action: "push", value: after[0] };
    return { action: "assign", value: null };
  }
  if (sameItems(before, after)) return null;
  if (after.length === before.length + 1 && isPrefix(before, after)) {
    return { action: "push", value: after[after.length - 1] };
  }
  if (before.length === after.length + 1 && isPrefix(after, before)) {
    return { action: "pop", value: before[before.length - 1] };
  }
  const inserted = insertedAt(before, after);
  if (inserted >= 0) return { action: "insert", value: after[inserted] };
  const removed = removedAt(before, after);
  if (removed >= 0) return { action: "remove", value: before[removed] };
  if (after.length === 0) return { action: "clear", value: null };
  return { action: "update", value: null };
}

function messageFor(change, after) {
  const n = after.length;
  const noun = n === 1 ? "item" : "items";
  switch (change.action) {
    case "init":
      return "Created an empty stack.";
    case "push":
      return `Pushed ${change.value} onto stack.`;
    case "pop":
      return `Popped ${change.value} from stack.`;
    case "insert":
      return `Inserted ${change.value} into stack.`;
    case "remove":
      return `Removed ${change.value} from stack.`;
    case "clear":
      return "Cleared stack.";
    case "assign":
      return `Set stack to ${n} ${noun}.`;
    case "update":
      return `Updated stack (${n} ${noun}).`;
    default:
      return "Updated stack.";
  }
}

function doneMessage(error, snapshots) {
  if (error === "STACK_LIMIT") {
    return "Stopped after too many changes to stack.";
  }
  if (error === "STACK_TOO_BIG") {
    return "Stopped because stack has too many items.";
  }
  if (error) return String(error);
  const drew = snapshots.some((snap) => snap.kind !== "done" && snap.kind !== "invalid" && snap.kind !== "missing");
  if (!drew) return "No list named stack to draw. Create one with stack = [].";
  return "Finished.";
}

/**
 * @param {Array<{line?: number, items?: string[] | null, type?: string, detail?: string}>} samples
 * @param {string | null} [error]
 */
export function snapshotsFromSamples(samples, error = null) {
  const list = Array.isArray(samples) ? samples : [];
  const snapshots = [];
  let before = null;
  let seenList = false;
  let historyStep = 0;

  for (const sample of list) {
    const line = Number.isFinite(Number(sample?.line)) ? Number(sample.line) : null;
    const typeName = sample?.type || "value";
    const after = Array.isArray(sample?.items) ? sample.items.map((item) => String(item)) : null;

    if (after == null) {
      const missing = typeName === "missing";
      snapshots.push({
        kind: missing ? "missing" : "invalid",
        line,
        message: missing
          ? "stack was deleted."
          : `stack is a ${typeName}${sample?.detail ? ` (${sample.detail})` : ""}, not a list.`,
        items: [],
        history: null,
        animate: false,
      });
      before = null;
      seenList = false;
      continue;
    }

    const change = classifyStackChange(seenList ? before : null, after);
    if (!change) {
      before = after.slice();
      seenList = true;
      continue;
    }

    let history = null;
    if (HISTORY_ACTIONS.has(change.action)) {
      historyStep += 1;
      history = {
        step: historyStep,
        action: change.action,
        value: change.value,
        before: seenList ? (before ? before.slice() : []) : null,
        stack: after.slice(),
        line,
      };
    }

    if ((change.action === "pop" || change.action === "remove") && seenList && before?.length) {
      const leavingIndex = change.action === "pop" ? before.length - 1 : removedAt(before, after);
      if (leavingIndex >= 0) {
        snapshots.push({
          kind: "popping",
          line,
          message: change.action === "pop"
            ? `Popping ${change.value} from stack.`
            : `Removing ${change.value} from stack.`,
          items: before.slice(),
          leavingIndex,
          history: null,
          animate: false,
        });
      }
    }

    snapshots.push({
      kind: change.action,
      line,
      message: messageFor(change, after),
      items: after.slice(),
      leavingIndex: -1,
      exitItem: (change.action === "pop" || change.action === "remove") ? change.value : null,
      exitIndex: (change.action === "pop" || change.action === "remove") && seenList && before?.length
        ? (change.action === "pop" ? before.length - 1 : removedAt(before, after))
        : -1,
      history,
      animate: change.action === "push" || change.action === "insert" || change.action === "assign",
    });
    before = after.slice();
    seenList = true;
  }

  const items = before ? before.slice() : [];
  snapshots.push({
    kind: "done",
    line: null,
    message: doneMessage(error, snapshots),
    items,
    history: null,
    animate: false,
  });
  return snapshots;
}

export function buildStackHarness(userSrc) {
  const srcLit = JSON.stringify(userSrc ?? "");
  return `
import json
import sys
import io
import traceback
from collections import deque

_USER_SRC = ${srcLit}
_MAX_SAMPLES = ${MAX_SAMPLES}
_MAX_ITEMS = ${MAX_ITEMS}
_MAX_REPR = ${MAX_REPR}
_SKIP = {"<listcomp>", "<dictcomp>", "<setcomp>", "<genexpr>"}
_MISSING = object()

def _ig_stack_main():
    samples = []
    error = None
    last_sig = None
    frame_state = {}
    in_repr = False
    stdout = io.StringIO()
    stderr = io.StringIO()

    def _repr(value):
        nonlocal in_repr
        in_repr = True
        try:
            try:
                text = repr(value)
            except Exception:
                text = "<unrepresentable>"
        finally:
            in_repr = False
        if len(text) > _MAX_REPR:
            text = text[:_MAX_REPR] + "…"
        return text

    def _as_items(value):
        if isinstance(value, (list, tuple)):
            seq = value
        elif isinstance(value, deque):
            seq = value
        else:
            return None
        if len(seq) > _MAX_ITEMS:
            raise RuntimeError("STACK_TOO_BIG")
        return [_repr(item) for item in seq]

    def _lookup(frame):
        # The picture is the list assigned to the name stack in this code,
        # including append and pop done from inside a function.
        try:
            return frame.f_globals.get("stack", _MISSING)
        except Exception:
            return _MISSING

    def _add(sample):
        if len(samples) >= _MAX_SAMPLES:
            raise RuntimeError("STACK_LIMIT")
        samples.append(sample)

    def _emit(frame, line):
        nonlocal last_sig
        value = _lookup(frame)
        if value is _MISSING:
            signature = ("missing",)
            sample = {"line": line, "items": None, "type": "missing"}
        else:
            items = _as_items(value)
            if items is None:
                signature = ("bad", type(value).__name__, _repr(value))
                sample = {
                    "line": line,
                    "items": None,
                    "type": type(value).__name__,
                    "detail": _repr(value),
                }
            else:
                signature = ("ok", tuple(items))
                sample = {
                    "line": line,
                    "items": items,
                    "type": type(value).__name__,
                }
        if signature == last_sig:
            return
        if signature == ("missing",) and not samples:
            last_sig = signature
            return
        last_sig = signature
        _add(sample)

    def _capture_completed(frame):
        line = frame_state.get(id(frame))
        if line is None:
            return
        _emit(frame, line)

    def _tracer(frame, event, arg):
        nonlocal error
        if in_repr:
            return _tracer
        code = frame.f_code
        if code.co_filename != "<user>" or code.co_name in _SKIP:
            return None
        try:
            if event == "line":
                _capture_completed(frame)
                frame_state[id(frame)] = frame.f_lineno
            elif event == "return":
                _capture_completed(frame)
                frame_state.pop(id(frame), None)
        except RuntimeError:
            raise
        except Exception as exc:
            error = "tracer failed: " + type(exc).__name__ + ": " + str(exc)
            return None
        return _tracer

    ns = {"__name__": "__main__"}
    old_out, old_err = sys.stdout, sys.stderr
    old_trace = sys.gettrace()
    try:
        sys.stdout = stdout
        sys.stderr = stderr
        sys.settrace(_tracer)
        exec(compile(_USER_SRC, "<user>", "exec"), ns)
    except RuntimeError as exc:
        code_name = str(exc)
        if code_name in ("STACK_LIMIT", "STACK_TOO_BIG"):
            error = code_name
        else:
            error = type(exc).__name__ + ": " + str(exc)
            traceback.print_exc(file=stderr)
    except Exception as exc:
        error = type(exc).__name__ + ": " + str(exc)
        traceback.print_exc(file=stderr)
    finally:
        sys.settrace(old_trace)
        sys.stdout = old_out
        sys.stderr = old_err

    return json.dumps({
        "samples": samples,
        "error": error,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    })

_ig_stack_main()
`.trim();
}

function renderCell(text, { isTop = false, enter = false, blink = false, exit = false } = {}) {
  const { full, shown, truncated } = truncateCellText(text);
  const el = document.createElement("div");
  el.className = "stk-cell"
    + (isTop && !blink ? " stk-cell-top" : "")
    + (enter ? " stk-cell-in" : "")
    + (blink ? " stk-cell-blink" : "")
    + (exit ? " stk-cell-out" : "");
  el.textContent = shown;
  if (truncated) {
    el.classList.add("stk-cell-more");
    el.tabIndex = 0;
    el.dataset.full = full;
    el.setAttribute("aria-label", full);
  }
  return el;
}

function placeTip(tip, anchor) {
  const margin = 8;
  tip.hidden = false;
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tipRect = tip.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  let left = rect.left + (rect.width - tipRect.width) / 2;
  let top = rect.bottom + margin;
  if (top + tipRect.height > window.innerHeight - margin) {
    top = rect.top - margin - tipRect.height;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
  top = Math.max(margin, top);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   editor?: object,
 *   stepDelayMs?: number,
 *   buildHarness?: (code: string) => string,
 *   toSnapshots?: (samples: unknown[], error: string | null) => Array<object>,
 *   onResult?: (payload: object) => void,
 *   onFrame?: (snap: object | null) => void,
 *   onReset?: () => void,
 * }} [options]
 */
export function mountStackViz(container, options = {}) {
  if (!container) return null;

  const editor = options.editor ?? null;
  const stepDelayMs = options.stepDelayMs ?? 780;
  const buildHarness = options.buildHarness ?? buildStackHarness;
  const toSnapshots = options.toSnapshots ?? snapshotsFromSamples;
  const onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
  const onResult = typeof options.onResult === "function" ? options.onResult : null;
  const onReset = typeof options.onReset === "function" ? options.onReset : null;
  const getCode = () => editor?.getCode?.() ?? "";

  let snapshots = [];
  let frameIndex = -1;
  let compiledCode = null;
  let playable = false;
  let compiling = false;
  let lastLogged = -1;
  const playback = createPlaybackTimer();

  container.innerHTML = "";
  container.classList.add("stk-root");

  const heading = document.createElement("div");
  heading.className = "stk-heading";
  heading.textContent = "stack";

  const narration = document.createElement("div");
  narration.className = "stk-narration";
  narration.setAttribute("role", "status");
  narration.setAttribute("aria-live", "polite");

  const stage = document.createElement("div");
  stage.className = "stk-stage";

  const block = document.createElement("div");
  block.className = "stk-block";

  const topLabel = document.createElement("div");
  topLabel.className = "stk-end stk-end-top";
  topLabel.textContent = "top";

  const scroll = document.createElement("div");
  scroll.className = "stk-scroll";

  const cellsBox = document.createElement("div");
  cellsBox.className = "stk-cells";
  scroll.append(cellsBox);

  const bottomLabel = document.createElement("div");
  bottomLabel.className = "stk-end stk-end-bottom";
  bottomLabel.textContent = "bottom";

  const varLabel = document.createElement("div");
  varLabel.className = "stk-var";
  varLabel.textContent = "stack";

  block.append(topLabel, scroll, bottomLabel, varLabel);
  stage.append(block);

  const tip = document.createElement("div");
  tip.className = "stk-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;

  const controls = document.createElement("div");
  controls.className = "stk-controls";

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
  resetBtn.textContent = "Reset";

  const stepLabel = document.createElement("div");
  stepLabel.className = "stk-step-label";

  controls.append(playBtn, stepBtn, resetBtn, stepLabel);
  container.append(heading, narration, stage, controls, tip);

  function hideTip() {
    tip.hidden = true;
    tip.textContent = "";
  }

  function showTip(anchor) {
    const full = anchor?.dataset?.full;
    if (!full) {
      hideTip();
      return;
    }
    tip.textContent = full;
    placeTip(tip, anchor);
  }

  cellsBox.addEventListener("mouseover", (event) => {
    const cell = event.target.closest?.(".stk-cell");
    if (!cell || !cellsBox.contains(cell)) return;
    showTip(cell);
  });
  cellsBox.addEventListener("mouseout", (event) => {
    const cell = event.target.closest?.(".stk-cell");
    if (!cell) return;
    const next = event.relatedTarget?.closest?.(".stk-cell");
    if (next === cell) return;
    hideTip();
  });
  cellsBox.addEventListener("focusin", (event) => {
    const cell = event.target.closest?.(".stk-cell");
    if (cell) showTip(cell);
  });
  cellsBox.addEventListener("focusout", () => hideTip());
  scroll.addEventListener("scroll", hideTip, { passive: true });

  function fitScroll() {
    const cells = [...cellsBox.querySelectorAll(".stk-cell")];
    if (cells.length <= VISIBLE_STACK_CELLS) {
      if (scroll.style.maxHeight !== "") scroll.style.maxHeight = "";
      return;
    }
    const gapRaw = getComputedStyle(cellsBox).rowGap || getComputedStyle(cellsBox).gap || "0";
    const gap = Number.parseFloat(gapRaw) || 0;
    let height = 0;
    for (let i = 0; i < VISIBLE_STACK_CELLS; i += 1) {
      height += cells[i].getBoundingClientRect().height;
    }
    height += (VISIBLE_STACK_CELLS - 1) * gap;
    const next = `${Math.ceil(height)}px`;
    if (scroll.style.maxHeight !== next) scroll.style.maxHeight = next;
  }

  function showEmpty() {
    const empty = document.createElement("div");
    empty.className = "stk-empty";
    empty.textContent = "empty";
    cellsBox.append(empty);
    scroll.style.maxHeight = "";
  }

  function drawStack(snap) {
    hideTip();
    cellsBox.replaceChildren();
    const items = snap?.items ?? [];
    const animate = Boolean(snap?.animate);
    const leavingIndex = Number.isInteger(snap?.leavingIndex) ? snap.leavingIndex : -1;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const exitItem = !reduceMotion && snap?.exitItem != null ? snap.exitItem : null;
    const exitIndex = Number.isInteger(snap?.exitIndex) ? snap.exitIndex : -1;
    const showGhost = exitItem != null && exitIndex >= 0;

    if (!items.length && !showGhost) {
      showEmpty();
      return;
    }

    const total = items.length + (showGhost ? 1 : 0);
    for (let old = total - 1; old >= 0; old -= 1) {
      if (showGhost && old === exitIndex) {
        const ghost = renderCell(exitItem, { exit: true });
        ghost.addEventListener("animationend", () => {
          if (!ghost.isConnected) return;
          ghost.remove();
          if (!cellsBox.querySelector(".stk-cell")) showEmpty();
          else fitScroll();
        });
        cellsBox.append(ghost);
        continue;
      }
      const index = showGhost && old > exitIndex ? old - 1 : old;
      const isTop = index === items.length - 1;
      const blink = index === leavingIndex;
      cellsBox.append(renderCell(items[index], {
        isTop,
        enter: animate && isTop,
        blink,
      }));
    }
    fitScroll();
    const blinkEl = cellsBox.querySelector(".stk-cell-blink") || cellsBox.querySelector(".stk-cell-out");
    if (!blinkEl) {
      scroll.scrollTop = 0;
      return;
    }
    const cellTop = blinkEl.offsetTop;
    const cellBottom = cellTop + blinkEl.offsetHeight;
    if (cellTop < scroll.scrollTop) scroll.scrollTop = cellTop;
    else if (cellBottom > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = cellBottom - scroll.clientHeight;
    }
  }

  function idleMessage() {
    if (snapshots.length) return "Press Run to watch stack.";
    return "Create a list named stack, then press Run.";
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
      drawStack(null);
    } else {
      narration.textContent = snap.message;
      drawStack(snap);
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
    onFrame?.(snap);
  }

  function logHistory(index) {
    const record = snapshots[index]?.history;
    if (!record || lastLogged === index) return;
    lastLogged = index;
    console.log("stack history", {
      step: record.step,
      action: record.action,
      value: record.value,
      before: record.before ? record.before.slice() : record.before,
      stack: record.stack.slice(),
      line: record.line,
    });
  }

  async function compile() {
    const code = getCode();
    if (!code.trim()) {
      snapshots = toSnapshots([], null);
      playable = false;
      compiledCode = code;
      frameIndex = 0;
      lastLogged = -1;
      editor?.clearStdout?.();
      return false;
    }

    compiling = true;
    playBtn.disabled = true;
    stepBtn.disabled = true;
    resetBtn.disabled = true;
    playBtn.textContent = "Running…";
    narration.textContent = "Loading Python…";
    drawStack(null);
    onFrame?.(null);

    try {
      const pyodide = await getPyodide();
      narration.textContent = "Running your code…";
      const rawJson = await pyodide.runPythonAsync(buildHarness(code));
      const payload = JSON.parse(typeof rawJson === "string" ? rawJson : String(rawJson));
      const captured = formatCapturedOutput(payload.stdout, payload.stderr);
      const samples = Array.isArray(payload.samples) ? payload.samples : [];
      onResult?.(payload);
      snapshots = toSnapshots(samples, payload.error ?? null);
      playable = snapshots.some((snap) => snap.kind !== "done");
      compiledCode = code;
      frameIndex = playable ? -1 : 0;
      lastLogged = -1;
      if (captured) {
        editor?.setStdout?.(captured, {
          isError: Boolean(payload.error) && payload.error !== "STACK_LIMIT" && payload.error !== "STACK_TOO_BIG",
        });
      } else {
        editor?.clearStdout?.();
      }
      return playable;
    } catch (err) {
      console.error(err);
      snapshots = toSnapshots([], String(err));
      playable = false;
      compiledCode = code;
      frameIndex = 0;
      lastLogged = -1;
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
    logHistory(frameIndex);
    render();
    if (playback.isPlaying() && frameIndex < snapshots.length - 1) {
      const hold = snapshots[frameIndex]?.kind === "popping" ? POP_BLINK_MS : stepDelayMs;
      playback.schedule(tick, hold);
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
    if (frameIndex >= snapshots.length - 1) {
      frameIndex = -1;
      lastLogged = -1;
    }
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
    if (frameIndex >= snapshots.length - 1) {
      frameIndex = -1;
      lastLogged = -1;
    }
    frameIndex += 1;
    logHistory(frameIndex);
    render();
  }

  function rewind() {
    playback.stop();
    frameIndex = playable ? -1 : (snapshots.length ? 0 : -1);
    lastLogged = -1;
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
      lastLogged = -1;
      originalReset();
      onReset?.();
      render();
    };
  }

  function discardRun() {
    playback.stop();
    snapshots = [];
    playable = false;
    compiledCode = null;
    frameIndex = -1;
    lastLogged = -1;
    editor?.unlock?.();
    editor?.clearLineHighlight?.();
    render();
  }

  let lastStageWidth = -1;
  const resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect?.width ?? 0;
    if (width === lastStageWidth) return;
    lastStageWidth = width;
    fitScroll();
  });
  resizeObserver.observe(stage);

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

  return {
    play,
    step: stepForward,
    reset: rewind,
    discardRun,
    getHistory() {
      return snapshots
        .map((snap) => snap.history)
        .filter(Boolean)
        .map((record) => ({
          step: record.step,
          action: record.action,
          value: record.value,
          before: record.before ? record.before.slice() : record.before,
          stack: record.stack.slice(),
          line: record.line,
        }));
    },
  };
}
