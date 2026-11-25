// list-viz.js
// Runs student Python and plays back the list named `arr` plus integer
// pointer variables whose names start with `p` (p0, p1, pleft, …).
// List changes and pointer moves each become a frame.

import { getPyodide } from "./utils/pyodide-loader.js";
import { formatCapturedOutput } from "./utils/py-harness-utils.js";
import { createPlaybackTimer } from "./utils/frame-playback.js";
import { truncateCellText } from "./stack-viz.js";

const MAX_SAMPLES = 400;
const MAX_ITEMS = 200;
const MAX_REPR = 20000;
const MAX_POINTERS = 24;

const SKIP_NAMES = new Set([
  "arr",
  "True",
  "False",
  "None",
  "print",
  "len",
  "range",
  "enumerate",
  "zip",
  "min",
  "max",
  "sum",
  "sorted",
  "list",
  "int",
  "str",
  "bool",
  "dict",
  "set",
  "tuple",
]);

export const listStarterCode = [
  "arr = [3, 1, 4, 1, 5, 9, 2, 6]",
  "",
  "pleft = 0",
  "pright = len(arr) - 1",
  "",
  "while pleft < pright:",
  "    arr[pleft], arr[pright] = arr[pright], arr[pleft]",
  "    pleft += 1",
  "    pright -= 1",
].join("\n");

function sameItems(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function samePointers(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function copyPointers(pointers) {
  const out = {};
  if (!pointers || typeof pointers !== "object") return out;
  for (const [name, value] of Object.entries(pointers)) {
    out[name] = Number(value);
  }
  return out;
}

function pointersAt(pointers, index) {
  const names = [];
  if (!pointers) return names;
  for (const [name, value] of Object.entries(pointers)) {
    if (value === index) names.push(name);
  }
  names.sort();
  return names;
}

function formatPointerMap(pointers) {
  const entries = Object.entries(pointers || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return "";
  return entries.map(([name, value]) => `${name}=${value}`).join(", ");
}

function firstChangedIndex(before, after) {
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i += 1) {
    if (before[i] !== after[i]) return i;
  }
  if (after.length !== before.length) return Math.min(before.length, after.length);
  return -1;
}

function pointerDiff(before, after) {
  const prev = before || {};
  const next = after || {};
  const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const added = [];
  const moved = [];
  const removed = [];
  for (const name of [...names].sort()) {
    const had = Object.prototype.hasOwnProperty.call(prev, name);
    const has = Object.prototype.hasOwnProperty.call(next, name);
    if (!had && has) added.push({ name, value: next[name] });
    else if (had && !has) removed.push({ name, value: prev[name] });
    else if (prev[name] !== next[name]) moved.push({ name, from: prev[name], to: next[name] });
  }
  return { added, moved, removed };
}

/**
 * @param {string[] | null} beforeItems
 * @param {string[]} afterItems
 * @param {Record<string, number> | null} beforePointers
 * @param {Record<string, number>} afterPointers
 */
export function classifyListChange(beforeItems, afterItems, beforePointers, afterPointers) {
  const itemsChanged = beforeItems == null || !sameItems(beforeItems, afterItems);
  const pointersChanged = !samePointers(beforePointers, afterPointers);
  if (!itemsChanged && !pointersChanged) return null;

  const n = afterItems.length;
  const noun = n === 1 ? "item" : "items";
  const parts = [];

  if (beforeItems == null) {
    if (afterItems.length === 0) parts.push("Created an empty list.");
    else parts.push(`Set arr to ${n} ${noun}.`);
  } else if (itemsChanged) {
    if (afterItems.length === 0 && beforeItems.length > 0) {
      parts.push("Cleared arr.");
    } else if (afterItems.length === beforeItems.length + 1) {
      parts.push(`Appended / inserted ${afterItems[firstChangedIndex(beforeItems, afterItems)]}.`);
    } else if (afterItems.length === beforeItems.length - 1) {
      const idx = firstChangedIndex(afterItems, beforeItems);
      parts.push(`Removed ${beforeItems[idx]} from arr.`);
    } else if (afterItems.length === beforeItems.length) {
      const idx = firstChangedIndex(beforeItems, afterItems);
      if (idx >= 0) parts.push(`Updated arr[${idx}] to ${afterItems[idx]}.`);
      else parts.push(`Updated arr (${n} ${noun}).`);
    } else {
      parts.push(`Set arr to ${n} ${noun}.`);
    }
  }

  if (pointersChanged) {
    const diff = pointerDiff(beforePointers, afterPointers);
    for (const entry of diff.added) {
      parts.push(`${entry.name} points to index ${entry.value}.`);
    }
    for (const entry of diff.moved) {
      parts.push(`Moved ${entry.name} from ${entry.from} to ${entry.to}.`);
    }
    for (const entry of diff.removed) {
      parts.push(`Dropped pointer ${entry.name}.`);
    }
  }

  return {
    action: itemsChanged && pointersChanged
      ? "update"
      : itemsChanged
        ? "list"
        : "pointers",
    message: parts.join(" ") || "Updated.",
  };
}

function doneMessage(error, snapshots) {
  if (error === "LIST_LIMIT") {
    return "Stopped after too many changes to arr / pointers.";
  }
  if (error === "LIST_TOO_BIG") {
    return "Stopped because arr has too many items.";
  }
  if (error === "POINTER_LIMIT") {
    return "Stopped because too many integer pointers were in scope.";
  }
  if (error) return String(error);
  const drew = snapshots.some((snap) => snap.kind !== "done" && snap.kind !== "invalid" && snap.kind !== "missing");
  if (!drew) return "No list named arr to draw. Create one with arr = [].";
  return "Finished.";
}

/**
 * @param {Array<{line?: number, items?: string[] | null, pointers?: Record<string, number>, type?: string, detail?: string}>} samples
 * @param {string | null} [error]
 */
export function snapshotsFromSamples(samples, error = null) {
  const list = Array.isArray(samples) ? samples : [];
  const snapshots = [];
  let beforeItems = null;
  let beforePointers = null;
  let seenList = false;

  for (const sample of list) {
    const line = Number.isFinite(Number(sample?.line)) ? Number(sample.line) : null;
    const typeName = sample?.type || "value";
    const afterItems = Array.isArray(sample?.items)
      ? sample.items.map((item) => String(item))
      : null;
    const afterPointers = copyPointers(sample?.pointers);

    if (afterItems == null) {
      const missing = typeName === "missing";
      snapshots.push({
        kind: missing ? "missing" : "invalid",
        line,
        message: missing
          ? "arr was deleted."
          : `arr is a ${typeName}${sample?.detail ? ` (${sample.detail})` : ""}, not a list.`,
        items: [],
        pointers: afterPointers,
        animate: false,
      });
      beforeItems = null;
      beforePointers = afterPointers;
      seenList = false;
      continue;
    }

    const change = classifyListChange(
      seenList ? beforeItems : null,
      afterItems,
      seenList ? beforePointers : null,
      afterPointers,
    );
    if (!change) {
      beforeItems = afterItems.slice();
      beforePointers = afterPointers;
      seenList = true;
      continue;
    }

    snapshots.push({
      kind: change.action,
      line,
      message: change.message,
      items: afterItems.slice(),
      pointers: afterPointers,
      animate: Boolean(seenList && beforeItems && afterItems.length > beforeItems.length),
      changedIndex: seenList && beforeItems
        ? firstChangedIndex(beforeItems, afterItems)
        : -1,
    });
    beforeItems = afterItems.slice();
    beforePointers = afterPointers;
    seenList = true;
  }

  const items = beforeItems ? beforeItems.slice() : [];
  snapshots.push({
    kind: "done",
    line: null,
    message: doneMessage(error, snapshots),
    items,
    pointers: beforePointers ? copyPointers(beforePointers) : {},
    animate: false,
    changedIndex: -1,
  });
  return snapshots;
}

export function buildListHarness(userSrc) {
  const srcLit = JSON.stringify(userSrc ?? "");
  const skipLit = JSON.stringify([...SKIP_NAMES]);
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
_MAX_POINTERS = ${MAX_POINTERS}
_SKIP_COMP = {"<listcomp>", "<dictcomp>", "<setcomp>", "<genexpr>"}
_SKIP_NAMES = set(${skipLit})
_MISSING = object()

def _ig_list_main():
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
            raise RuntimeError("LIST_TOO_BIG")
        return [_repr(item) for item in seq]

    def _lookup_arr(frame):
        try:
            if "arr" in frame.f_locals:
                return frame.f_locals["arr"]
            return frame.f_globals.get("arr", _MISSING)
        except Exception:
            return _MISSING

    def _collect_pointers(frame):
        found = {}
        try:
            scopes = (frame.f_globals, frame.f_locals)
        except Exception:
            return found
        for scope in scopes:
            try:
                items = list(scope.items())
            except Exception:
                continue
            for name, value in items:
                if not isinstance(name, str):
                    continue
                if name.startswith("_") or name in _SKIP_NAMES:
                    continue
                # Pointers are ints whose names start with "p" (p0, p1, pleft, …).
                if not name.startswith("p"):
                    continue
                if type(value) is int:
                    found[name] = int(value)
        if len(found) > _MAX_POINTERS:
            raise RuntimeError("POINTER_LIMIT")
        return found

    def _add(sample):
        if len(samples) >= _MAX_SAMPLES:
            raise RuntimeError("LIST_LIMIT")
        samples.append(sample)

    def _emit(frame, line):
        nonlocal last_sig
        value = _lookup_arr(frame)
        pointers = _collect_pointers(frame)
        if value is _MISSING:
            signature = ("missing", tuple(sorted(pointers.items())))
            sample = {
                "line": line,
                "items": None,
                "type": "missing",
                "pointers": pointers,
            }
        else:
            items = _as_items(value)
            if items is None:
                signature = ("bad", type(value).__name__, _repr(value), tuple(sorted(pointers.items())))
                sample = {
                    "line": line,
                    "items": None,
                    "type": type(value).__name__,
                    "detail": _repr(value),
                    "pointers": pointers,
                }
            else:
                signature = ("ok", tuple(items), tuple(sorted(pointers.items())))
                sample = {
                    "line": line,
                    "items": items,
                    "type": type(value).__name__,
                    "pointers": pointers,
                }
        if signature == last_sig:
            return
        if signature[0] == "missing" and not samples:
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
        if code.co_filename != "<user>" or code.co_name in _SKIP_COMP:
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
        if code_name in ("LIST_LIMIT", "LIST_TOO_BIG", "POINTER_LIMIT"):
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

_ig_list_main()
`.trim();
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

function renderSlot(text, index, pointerNames, { enter = false } = {}) {
  const { full, shown, truncated } = truncateCellText(text);
  const highlighted = pointerNames.length > 0;

  const slot = document.createElement("div");
  slot.className = "lst-slot" + (highlighted ? " lst-slot-hl" : "");

  const ptr = document.createElement("div");
  ptr.className = "lst-ptr" + (highlighted ? " lst-ptr-on" : "");
  ptr.textContent = highlighted ? pointerNames.join(", ") : "\u00a0";
  if (highlighted) ptr.title = pointerNames.join(", ");

  const cell = document.createElement("div");
  cell.className = "lst-cell"
    + (highlighted ? " lst-cell-hl" : "")
    + (enter ? " lst-cell-in" : "");
  cell.textContent = shown;
  if (truncated) {
    cell.classList.add("lst-cell-more");
    cell.tabIndex = 0;
    cell.dataset.full = full;
    cell.setAttribute("aria-label", full);
  }

  const idx = document.createElement("div");
  idx.className = "lst-idx" + (highlighted ? " lst-idx-hl" : "");
  idx.textContent = String(index);

  slot.append(ptr, cell, idx);
  return slot;
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
export function mountListViz(container, options = {}) {
  if (!container) return null;

  const editor = options.editor ?? null;
  const stepDelayMs = options.stepDelayMs ?? 780;
  const buildHarness = options.buildHarness ?? buildListHarness;
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
  const playback = createPlaybackTimer();

  container.innerHTML = "";
  container.classList.add("lst-root");

  const heading = document.createElement("div");
  heading.className = "lst-heading";
  heading.textContent = "list";

  const narration = document.createElement("div");
  narration.className = "lst-narration";
  narration.setAttribute("role", "status");
  narration.setAttribute("aria-live", "polite");

  const stage = document.createElement("div");
  stage.className = "lst-stage";

  const block = document.createElement("div");
  block.className = "lst-block";

  const scroll = document.createElement("div");
  scroll.className = "lst-scroll";

  const cellsBox = document.createElement("div");
  cellsBox.className = "lst-cells";
  scroll.append(cellsBox);

  const varLabel = document.createElement("div");
  varLabel.className = "lst-var";
  varLabel.textContent = "arr";

  const pointerBar = document.createElement("div");
  pointerBar.className = "lst-pointer-bar";

  block.append(scroll, varLabel, pointerBar);
  stage.append(block);

  const tip = document.createElement("div");
  tip.className = "lst-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;

  const controls = document.createElement("div");
  controls.className = "lst-controls";

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
  stepLabel.className = "lst-step-label";

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
    const cell = event.target.closest?.(".lst-cell");
    if (!cell || !cellsBox.contains(cell)) return;
    showTip(cell);
  });
  cellsBox.addEventListener("mouseout", (event) => {
    const cell = event.target.closest?.(".lst-cell");
    if (!cell) return;
    const next = event.relatedTarget?.closest?.(".lst-cell");
    if (next === cell) return;
    hideTip();
  });
  cellsBox.addEventListener("focusin", (event) => {
    const cell = event.target.closest?.(".lst-cell");
    if (cell) showTip(cell);
  });
  cellsBox.addEventListener("focusout", () => hideTip());

  function showEmpty() {
    const empty = document.createElement("div");
    empty.className = "lst-empty";
    empty.textContent = "empty";
    cellsBox.append(empty);
  }

  function drawPointersBar(pointers) {
    const text = formatPointerMap(pointers);
    if (!text) {
      pointerBar.textContent = "no pointers";
      pointerBar.classList.add("lst-pointer-bar-empty");
      return;
    }
    pointerBar.classList.remove("lst-pointer-bar-empty");
    pointerBar.textContent = text;
  }

  function drawList(snap) {
    hideTip();
    cellsBox.replaceChildren();
    const items = snap?.items ?? [];
    const pointers = snap?.pointers ?? {};
    const animate = Boolean(snap?.animate);
    const changedIndex = Number.isInteger(snap?.changedIndex) ? snap.changedIndex : -1;

    drawPointersBar(pointers);

    if (!items.length) {
      showEmpty();
      return;
    }

    for (let i = 0; i < items.length; i += 1) {
      const names = pointersAt(pointers, i);
      cellsBox.append(renderSlot(items[i], i, names, {
        enter: animate && i === changedIndex,
      }));
    }
  }

  function idleMessage() {
    if (snapshots.length) return "Press Run to watch arr and its pointers.";
    return "Create a list named arr and pointers named p… (p0, p1, pleft, …), then press Run.";
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
      drawList(null);
    } else {
      narration.textContent = snap.message;
      drawList(snap);
      if (snap.kind === "done") {
        editor?.clearLineHighlight?.();
        if (editor?.locked) editor.unlock();
      } else if (snap.line != null) {
        editor?.highlightLine?.(snap.line, { scroll: false });
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

  async function compile() {
    const code = getCode();
    if (!code.trim()) {
      snapshots = toSnapshots([], null);
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
    drawList(null);
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
      if (captured) {
        editor?.setStdout?.(captured, {
          isError: Boolean(payload.error)
            && payload.error !== "LIST_LIMIT"
            && payload.error !== "LIST_TOO_BIG"
            && payload.error !== "POINTER_LIMIT",
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
    if (frameIndex >= snapshots.length - 1) {
      frameIndex = -1;
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
    }
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
    editor?.unlock?.();
    editor?.clearLineHighlight?.();
    render();
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

  return {
    play,
    step: stepForward,
    reset: rewind,
    discardRun,
  };
}
