// call-stack-viz.js
// Runs student Python under sys.settrace and plays the call stack back as
// frames. Each call is one frame; parameters stay inside that frame. A note
// above the stack says when a function is called and what it returned.

import { getPyodide } from "./utils/pyodide-loader.js";
import { formatCapturedOutput } from "./utils/py-harness-utils.js";
import { createPlaybackTimer } from "./utils/frame-playback.js";

const MAX_EVENTS = 400;

export const callStackStarterCode = [
  "def recursive_function(param):",
  "    if param <= 1:",
  "        return param",
  "    return recursive_function(param - 1) + recursive_function(param - 2)",
  "",
  "print(recursive_function(3))",
].join("\n");

function cloneStack(stack) {
  return stack.map((frame) => ({ ...frame }));
}

function doneMessage(stack, error) {
  if (error === "TOO_MANY_CALLS") {
    return "Stopped after too many calls. The frames below are where tracing stopped.";
  }
  if (error) {
    return stack.length
      ? `${error}. These frames were still on the stack.`
      : String(error);
  }
  const stillRunning = stack.some((frame) => frame.phase === "live");
  if (stillRunning) return "Tracing finished with frames still on the stack.";
  if (stack.length) return "Finished.";
  return "Finished. The call stack is empty.";
}

/** Turn raw trace events into one drawable stack snapshot per step. */
export function eventsToSnapshots(events, error = null) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    return [{
      kind: "done",
      line: null,
      message: error
        ? String(error)
        : "No function calls to show. Define a function and call it from the editor.",
      stack: [],
    }];
  }

  const stack = [];
  const snapshots = [];

  for (const ev of list) {
    const name = ev?.name || "function";
    const args = ev?.args ?? "";
    const line = Number.isFinite(Number(ev?.line)) ? Number(ev.line) : null;

    if (ev?.type === "call") {
      stack.push({ name, args, phase: "live" });
      snapshots.push({
        kind: "call",
        line,
        message: `${name} called with parameters [${args}]`,
        stack: cloneStack(stack),
      });
      continue;
    }

    if (ev?.type !== "return" && ev?.type !== "raise") continue;

    const phase = ev.type;
    const value = phase === "return" ? (ev.value ?? "None") : (ev.error ?? "Exception");
    let target = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].phase === "live") {
        target = i;
        break;
      }
    }
    if (target >= 0) stack[target] = { ...stack[target], phase, value };
    const message = phase === "return"
      ? `${name} call from [${args}] returned ${value}`
      : `${name} call from [${args}] raised ${value}`;
    snapshots.push({ kind: phase, line, message, stack: cloneStack(stack) });
  }

  snapshots.push({
    kind: "done",
    line: null,
    message: doneMessage(stack, error),
    stack: cloneStack(stack),
  });
  return snapshots;
}

export function buildCallStackHarness(userSrc) {
  const srcLit = JSON.stringify(userSrc ?? "");
  return `
import io
import json
import sys
import traceback

_USER_SRC = ${srcLit}
_MAX_EVENTS = ${MAX_EVENTS}
_SKIP = {"<module>", "<listcomp>", "<dictcomp>", "<setcomp>", "<genexpr>"}

def _ig_call_stack_main():
    events = []
    error = None
    pending = {}
    saved_args = {}
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
        if len(text) > 80:
            text = text[:77] + "..."
        return text

    def _args(frame):
        code = frame.f_code
        names = code.co_varnames
        npos = code.co_argcount
        nkw = code.co_kwonlyargcount
        parts = []
        for name in names[:npos]:
            parts.append(name + "=" + _repr(frame.f_locals.get(name)))
        for name in names[npos:npos + nkw]:
            if name in frame.f_locals:
                parts.append(name + "=" + _repr(frame.f_locals[name]))
        idx = npos + nkw
        flags = code.co_flags
        if flags & 0x04:
            name = names[idx]
            parts.append("*" + name + "=" + _repr(frame.f_locals.get(name)))
            idx += 1
        if flags & 0x08:
            name = names[idx]
            parts.append("**" + name + "=" + _repr(frame.f_locals.get(name)))
        return ", ".join(parts)

    def _record(event):
        if len(events) >= _MAX_EVENTS:
            raise RuntimeError("CALL_STACK_LIMIT")
        events.append(event)

    def _tracer(frame, event, arg):
        nonlocal error
        code = frame.f_code
        if code.co_filename != "<user>" or code.co_name in _SKIP:
            return None
        if in_repr:
            return _tracer
        try:
            fid = id(frame)
            name = getattr(code, "co_qualname", code.co_name).replace(".<locals>.", ".")
            if event == "call":
                arg_text = _args(frame)
                saved_args[fid] = arg_text
                caller = frame.f_back
                if caller is not None and caller.f_code.co_filename == "<user>":
                    call_line = caller.f_lineno
                else:
                    call_line = frame.f_lineno
                _record({
                    "type": "call",
                    "name": name,
                    "args": arg_text,
                    "line": call_line,
                })
            elif event == "line":
                pending.pop(fid, None)
            elif event == "exception":
                exc = arg[1] if arg and len(arg) > 1 else None
                if exc is None:
                    pending[fid] = "Exception"
                else:
                    pending[fid] = type(exc).__name__ + ": " + str(exc)
            elif event == "return":
                arg_text = saved_args.pop(fid, "")
                raised = pending.pop(fid, None)
                if raised:
                    _record({
                        "type": "raise",
                        "name": name,
                        "args": arg_text,
                        "error": raised,
                        "line": frame.f_lineno,
                    })
                else:
                    _record({
                        "type": "return",
                        "name": name,
                        "args": arg_text,
                        "value": _repr(arg),
                        "line": frame.f_lineno,
                    })
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
        if str(exc) == "CALL_STACK_LIMIT":
            error = "TOO_MANY_CALLS"
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
        "events": events,
        "error": error,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    })

_ig_call_stack_main()
`.trim();
}

function renderParamFrame(frame, isActive) {
  const el = document.createElement("div");
  const fulfilled = frame.phase === "return" || frame.phase === "raise";
  el.className = "cs-frame"
    + (isActive ? " cs-frame-top" : "")
    + (fulfilled ? " cs-frame-done" : "");

  const args = document.createElement("div");
  args.className = "cs-frame-args";
  args.textContent = `${frame.args ?? ""}`;
  el.append(args);
  return el;
}

function renderFrame(frame, isActive) {
  const param = renderParamFrame(frame, isActive);
  const fulfilled = frame.phase === "return" || frame.phase === "raise";
  if (!fulfilled) return param;

  const row = document.createElement("div");
  row.className = "cs-return-row cs-return-done";

  const arrow = document.createElement("div");
  arrow.className = "cs-arrow";
  arrow.textContent = "→";

  const output = document.createElement("div");
  output.className = "cs-output cs-output-done" + (frame.phase === "raise" ? " cs-output-error" : "");
  output.textContent = String(frame.value ?? "");

  row.append(param, arrow, output);
  return row;
}

/**
 * @param {HTMLElement} container
 * @param {{ editor?: object, stepDelayMs?: number }} [options]
 */
export function mountCallStackViz(container, options = {}) {
  if (!container) return null;

  const editor = options.editor ?? null;
  const stepDelayMs = options.stepDelayMs ?? 780;
  const getCode = () => editor?.getCode?.() ?? "";

  let snapshots = [];
  let frameIndex = -1;
  let compiledCode = null;
  let playable = false;
  let compiling = false;
  const playback = createPlaybackTimer();

  container.innerHTML = "";
  container.classList.add("cs-root");

  const heading = document.createElement("div");
  heading.className = "cs-heading";
  heading.textContent = "Call stack";

  const stage = document.createElement("div");
  stage.className = "cs-stage";

  const narration = document.createElement("div");
  narration.className = "cs-narration";
  narration.setAttribute("role", "status");
  narration.setAttribute("aria-live", "polite");

  const stackWrap = document.createElement("div");
  stackWrap.className = "cs-stack-wrap";

  const stackEl = document.createElement("div");
  stackEl.className = "cs-stack";
  stackWrap.append(stackEl);
  stage.append(stackWrap);

  const controls = document.createElement("div");
  controls.className = "cs-controls";

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
  resetBtn.textContent = "Reset stack";

  const stepLabel = document.createElement("div");
  stepLabel.className = "cs-step-label";

  controls.append(playBtn, stepBtn, resetBtn, stepLabel);
  container.append(heading, narration, stage, controls);

  function pinNewest() {
    const top = stackEl.querySelector(".cs-frame-top");
    if (!top) return;
    const wrapRect = stackWrap.getBoundingClientRect();
    const frameRect = top.getBoundingClientRect();
    if (frameRect.top < wrapRect.top) {
      stackWrap.scrollTop -= wrapRect.top - frameRect.top + 8;
    }
  }

  function drawStack(stack) {
    stackEl.replaceChildren();
    if (!stack?.length) {
      const empty = document.createElement("div");
      empty.className = "cs-empty";
      empty.textContent = "The call stack is empty.";
      stackEl.append(empty);
      return;
    }
    let activeIndex = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].phase === "live") {
        activeIndex = i;
        break;
      }
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      stackEl.append(renderFrame(stack[i], i === activeIndex));
    }
    requestAnimationFrame(pinNewest);
  }

  function idleMessage() {
    if (snapshots.length) return "Press Run to watch the call stack.";
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
      drawStack([]);
    } else {
      narration.textContent = snap.message;
      drawStack(snap.stack);
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
  }

  async function compile() {
    const code = getCode();
    if (!code.trim()) {
      snapshots = eventsToSnapshots([], null);
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
    drawStack([]);

    try {
      const pyodide = await getPyodide();
      narration.textContent = "Running your code…";
      const rawJson = await pyodide.runPythonAsync(buildCallStackHarness(code));
      const payload = JSON.parse(typeof rawJson === "string" ? rawJson : String(rawJson));
      const captured = formatCapturedOutput(payload.stdout, payload.stderr);
      const events = Array.isArray(payload.events) ? payload.events : [];
      snapshots = eventsToSnapshots(events, payload.error);
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
      snapshots = eventsToSnapshots([], String(err));
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
