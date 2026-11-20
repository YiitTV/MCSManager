import { stripVTControlCharacters } from "node:util";

export const CRASH_OUTPUT_LIMIT = 64 * 1024;
const FRAME_LIMIT = 8;
const JAVA_NAME = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*";
const EXCEPTION = new RegExp(
  `^(?:Caused by:\\s+|Exception in thread "[^"]+"\\s+)?(${JAVA_NAME}(?:Exception|Error|Throwable)|Exception|Error|Throwable)(?::\\s*(.*))?$`
);
const FRAME = new RegExp(`^at\\s+(?:[\\w.$@-]+/)*(?:/)?(${JAVA_NAME}|[<>\\w.$]+)\\(([^()]*)\\)`);

export interface PluginHint {
  jar: string;
  main?: string;
}

export interface CrashDetails {
  exception?: string;
  message?: string;
  frames: string[];
  plugin?: string;
}

interface Frame {
  method: string;
  text: string;
  jar?: string;
}

function findTrace(source: string, last: boolean) {
  let trace: { exception: string; message?: string; frames: Frame[] } | undefined;
  let best: typeof trace;
  for (const raw of source.split("\n")) {
    const line = stripVTControlCharacters(raw)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .trim()
      .replace(/^(?:\[[^\]]{1,100}\]\s*)+(?::\s*)?/, "");
    const exception = EXCEPTION.exec(line);
    if (exception) {
      const causedBy = line.startsWith("Caused by:");
      if (best && !last && !causedBy) break;
      trace = {
        exception: exception[1].slice(0, 256),
        message: exception[2]?.slice(0, 400),
        frames: []
      };
      if (!best || causedBy || last) best = trace;
      continue;
    }
    const frame = FRAME.exec(line);
    if (trace && frame && trace.frames.length < FRAME_LIMIT) {
      const jar = /\[([^\]/\\:]+?\.jar)(?::[^\]]*)?\]/i.exec(line.slice(frame[0].length))?.[1];
      trace.frames.push({ method: frame[1], text: frame[0].slice(0, 300), jar });
    } else if (line && !frame && !line.startsWith("... ")) {
      trace = undefined;
    }
  }
  return best;
}

function pluginScore(frame: Frame, hint: PluginHint) {
  if (frame.jar?.toLowerCase() === hint.jar.toLowerCase()) return 300;
  const mainPackage = hint.main?.split(".").slice(0, -1).join(".");
  if (mainPackage && frame.method.startsWith(mainPackage + ".")) {
    return 200 + Math.min(mainPackage.split(".").length, 50);
  }

  const jarName = hint.jar
    .toLowerCase()
    .replace(/\.jar$/, "")
    .replace(/[-_.]?v?\d.*$/, "");
  const parts = frame.method.toLowerCase().split(".").slice(0, -2);
  const name = jarName.replace(/[^a-z]/g, "");
  for (let i = 0; name.length >= 4 && i < parts.length; i++) {
    if (parts[i] === name || parts[i] + parts[i + 1] === name) return 100;
  }
  return 0;
}

export function parseCrash(report: string, output: string, plugins: PluginHint[]): CrashDetails {
  const reportTrace = findTrace(report, false);
  const outputTrace = findTrace(output.replace(/\n$/, "").split("\n").slice(-300).join("\n"), true);
  const trace = reportTrace ?? outputTrace;
  const frames = trace?.frames.length
    ? trace.frames
    : outputTrace?.exception === trace?.exception
    ? outputTrace?.frames ?? []
    : [];
  let plugin: string | undefined;
  let score = 0;
  for (const [index, frame] of frames.entries()) {
    for (const hint of plugins) {
      const match = pluginScore(frame, hint);
      if (match && match - index > score) {
        score = match - index;
        plugin = hint.jar;
      }
    }
  }
  return {
    exception: trace?.exception,
    message: trace?.message,
    frames: frames.map((frame) => frame.text),
    plugin
  };
}
