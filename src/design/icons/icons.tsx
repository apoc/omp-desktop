// icons.tsx — OMP Icon Pack v1
// 16x16 grid, 1.5 stroke, round caps/joins. Every glyph has a single accent dot.
// Usage: <Icon name="plan" size={14} color="var(--fg-2)" dotColor="var(--accent)" />

import * as React from "react";

export type IconName =
  | "plus"
  | "minus"
  | "close"
  | "check"
  | "play"
  | "pause"
  | "stop"
  | "refresh"
  | "copy"
  | "trash"
  | "file"
  | "folder"
  | "edit"
  | "diff"
  | "bash"
  | "search"
  | "grep"
  | "test"
  | "build"
  | "web"
  | "plan"
  | "thinking"
  | "agent"
  | "sparkle"
  | "bolt"
  | "radar"
  | "voice"
  | "context"
  | "tokens"
  | "cost"
  | "arrow"
  | "arrowUp"
  | "chev"
  | "chevR"
  | "home"
  | "back"
  | "external"
  | "sidebar"
  | "split"
  | "grid"
  | "minimap"
  | "layers"
  | "focus"
  | "circle"
  | "dot"
  | "warn"
  | "info"
  | "clock"
  | "live"
  | "branch"
  | "merge"
  | "commit"
  | "diff2"
  | "command"
  | "image"
  | "link"
  | "send"
  | "cog";

const PATHS: Record<IconName, { paths: string[]; dot: [number, number]; purpose: string }> = {
  plus: {
    paths: ["<path d=\"M8 3v10M3 8h10\"/>"],
    dot: [12, 4],
    purpose: "Create new — new tab, new session, new task in plan.",
  },
  minus: {
    paths: ["<path d=\"M3 8h10\"/>"],
    dot: [12, 8],
    purpose: "Remove / collapse. Pair with plus on a stepper.",
  },
  close: {
    paths: ["<path d=\"M3.5 3.5l9 9M12.5 3.5l-9 9\"/>"],
    dot: [12, 4],
    purpose: "Dismiss. Close a tab, modal, command bridge, or tweaks panel.",
  },
  check: {
    paths: ["<path d=\"M3 8l3 3 7-7\"/>"],
    dot: [13, 4],
    purpose: "Done / completed. Tool call success, plan task finished, approval.",
  },
  play: {
    paths: ["<path d=\"M5 3l8 5-8 5z\"/>"],
    dot: [13, 8],
    purpose: "Run / approve & ship. Kicks off plan execution or replays a tool call.",
  },
  pause: {
    paths: ["<rect x=\"4\" y=\"3\" width=\"3\" height=\"10\"/><rect x=\"9\" y=\"3\" width=\"3\" height=\"10\"/>"],
    dot: [12, 8],
    purpose: "Pause the agent. Holds the loop without killing context.",
  },
  stop: {
    paths: ["<rect x=\"4\" y=\"4\" width=\"8\" height=\"8\" rx=\"1\"/>"],
    dot: [12, 4],
    purpose: "Hard stop. Cancel current run; agent gives back the floor.",
  },
  refresh: {
    paths: ["<path d=\"M3 8a5 5 0 0 1 8.5-3.5L13 6\"/><path d=\"M13 3v3h-3\"/><path d=\"M13 8a5 5 0 0 1-8.5 3.5L3 10\"/><path d=\"M3 13v-3h3\"/>"],
    dot: [13, 3],
    purpose: "Retry. Re-run the same tool call or replay last message.",
  },
  copy: {
    paths: ["<rect x=\"5\" y=\"5\" width=\"8\" height=\"8\" rx=\"1\"/><path d=\"M3 10V4a1 1 0 0 1 1-1h6\"/>"],
    dot: [13, 5],
    purpose: "Copy to clipboard. Used on code blocks, tool args, file paths.",
  },
  trash: {
    paths: ["<path d=\"M3 4h10\"/><path d=\"M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1\"/><path d=\"M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4\"/>"],
    dot: [8, 8],
    purpose: "Delete. Drop a session, message, or plan task. Confirm before destructive.",
  },
  file: {
    paths: ["<path d=\"M4 2h5l3 3v9H4z\"/><path d=\"M9 2v3h3\"/>"],
    dot: [12, 5],
    purpose: "Read file tool call. Pair with cyan tone.",
  },
  folder: {
    paths: ["<path d=\"M2 5l2-2h3l1 1h6v8H2z\"/>"],
    dot: [14, 5],
    purpose: "Directory listing. Project root selector, ls-style tools.",
  },
  edit: {
    paths: ["<path d=\"M2 12V14h2l8-8-2-2-8 8z\"/><path d=\"M9 4l2 2\"/>"],
    dot: [12, 4],
    purpose: "Write tool call. New content / overwrite.",
  },
  diff: {
    paths: ["<path d=\"M5 2v12M11 2v12\"/><path d=\"M3 5h4\"/><path d=\"M9 11h4\"/>"],
    dot: [5, 2],
    purpose: "Edit / patch tool call. Inline diffs and split views.",
  },
  bash: {
    paths: ["<path d=\"M3 4l3 3-3 3\"/><path d=\"M8 11h5\"/>"],
    dot: [6, 7],
    purpose: "Shell / terminal tool call. Pair with amber tone.",
  },
  search: {
    paths: ["<circle cx=\"7\" cy=\"7\" r=\"4\"/><path d=\"M10 10l3 3\"/>"],
    dot: [13, 13],
    purpose: "Generic search. Command bridge, palette.",
  },
  grep: {
    paths: ["<circle cx=\"6\" cy=\"6\" r=\"3.5\"/><path d=\"M8.5 8.5l4 4\"/><path d=\"M4.5 6h3\"/>"],
    dot: [12.5, 12.5],
    purpose: "Code search / grep tool. Distinct from search by the inner equals bar.",
  },
  test: {
    paths: ["<path d=\"M5 2v4l-3 6a2 2 0 0 0 1.7 3h8.6A2 2 0 0 0 14 12l-3-6V2\"/><path d=\"M4 2h8\"/>"],
    dot: [11, 2],
    purpose: "Run tests. Test-runner tool call status.",
  },
  build: {
    paths: ["<rect x=\"2\" y=\"6\" width=\"5\" height=\"8\"/><rect x=\"9\" y=\"2\" width=\"5\" height=\"12\"/>"],
    dot: [14, 2],
    purpose: "Build / compile tool call. Pair with bar-chart growth.",
  },
  web: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M2 8h12\"/><path d=\"M8 2c2 2 2 10 0 12c-2-2-2-10 0-12\"/>"],
    dot: [14, 8],
    purpose: "Web fetch / browser tool. External calls leaving the sandbox.",
  },
  plan: {
    paths: ["<rect x=\"2\" y=\"3\" width=\"3\" height=\"10\"/><rect x=\"6.5\" y=\"3\" width=\"3\" height=\"6\"/><rect x=\"11\" y=\"3\" width=\"3\" height=\"8\"/>"],
    dot: [12.5, 3],
    purpose: "Plan-mode toggle, todo chip, kanban surface entry. The signature feature icon.",
  },
  thinking: {
    paths: ["<path d=\"M5 3a3 3 0 0 1 6 0c0 1.5-1.5 2-1.5 3.5h-3C6.5 5 5 4.5 5 3z\"/><path d=\"M6.5 9.5h3M7 12h2\"/>"],
    dot: [8, 3],
    purpose: "Reasoning / chain-of-thought blocks. Strategy explainers.",
  },
  agent: {
    paths: ["<rect x=\"3\" y=\"5\" width=\"10\" height=\"8\" rx=\"2\"/><path d=\"M8 2v3\"/><circle cx=\"6\" cy=\"9\" r=\".7\" fill=\"currentColor\"/><circle cx=\"10\" cy=\"9\" r=\".7\" fill=\"currentColor\"/>"],
    dot: [8, 2],
    purpose: "Represents the agent itself. Avatar, peer-session card, multi-agent indicators.",
  },
  sparkle: {
    paths: ["<path d=\"M8 2l1.2 3.2L13 6l-3.8 0.8L8 10l-1.2-3.2L3 6l3.8-0.8z\"/>"],
    dot: [12, 12],
    purpose: "AI-generated content marker. Inline beside model output, suggestion chips.",
  },
  bolt: {
    paths: ["<path d=\"M9 1L3 9h4l-1 6 6-8H8z\"/>"],
    dot: [12, 3],
    purpose: "Fast / latency-aware path. Use for low-thinking-effort or cached responses.",
  },
  radar: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"6\"/><circle cx=\"8\" cy=\"8\" r=\"3\"/><path d=\"M8 8l4-3\"/>"],
    dot: [12, 5],
    purpose: "Activity radar widget; ambient telemetry of recent tool calls.",
  },
  voice: {
    paths: ["<rect x=\"6\" y=\"2\" width=\"4\" height=\"8\" rx=\"2\"/><path d=\"M3 8a5 5 0 0 0 10 0M8 13v2\"/>"],
    dot: [8, 2],
    purpose: "Voice / dictation mode in the composer.",
  },
  context: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 8 L8 2 A6 6 0 0 1 13 11 Z\" fill=\"currentColor\" fill-opacity=\".15\" stroke-width=\"0\"/><circle cx=\"8\" cy=\"8\" r=\"6\"/>"],
    dot: [13, 11],
    purpose: "Context window usage gauge. Filled wedge = consumed tokens.",
  },
  tokens: {
    paths: ["<circle cx=\"5\" cy=\"8\" r=\"3\"/><circle cx=\"11\" cy=\"8\" r=\"3\"/>"],
    dot: [11, 8],
    purpose: "Tokens / cost units. Status bar metrics, budget displays.",
  },
  cost: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M10 6H7a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H6\"/><path d=\"M8 4v8\"/>"],
    dot: [8, 4],
    purpose: "Dollar-cost. Plan budget panel, settings billing.",
  },
  arrow: {
    paths: ["<path d=\"M3 8h10\"/><path d=\"M9 4l4 4-4 4\"/>"],
    dot: [13, 8],
    purpose: "Forward / submit. Composer send, next-step CTAs.",
  },
  arrowUp: {
    paths: ["<path d=\"M8 13V3\"/><path d=\"M4 7l4-4 4 4\"/>"],
    dot: [8, 3],
    purpose: "Send message in composer. The default submit affordance.",
  },
  chev: {
    paths: ["<path d=\"M5 6l3 3 3-3\"/>"],
    dot: [8, 9],
    purpose: "Disclose / expand. Selects, accordions, dropdowns.",
  },
  chevR: {
    paths: ["<path d=\"M6 5l3 3-3 3\"/>"],
    dot: [9, 8],
    purpose: "Drill in. Tree expanders, breadcrumb separators.",
  },
  home: {
    paths: ["<path d=\"M2 8l6-5 6 5v6H9v-4H7v4H2z\"/>"],
    dot: [8, 3],
    purpose: "Project home / session list root.",
  },
  back: {
    paths: ["<path d=\"M13 8H3\"/><path d=\"M7 4L3 8l4 4\"/>"],
    dot: [3, 8],
    purpose: "History back. Walk through prior states or messages.",
  },
  external: {
    paths: ["<path d=\"M9 3h4v4\"/><path d=\"M13 3l-6 6\"/><path d=\"M11 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3\"/>"],
    dot: [13, 3],
    purpose: "Opens in a new window or browser. Web-fetch results, doc links.",
  },
  sidebar: {
    paths: ["<rect x=\"2\" y=\"3\" width=\"12\" height=\"10\" rx=\"1\"/><path d=\"M6 3v10\"/>"],
    dot: [6, 3],
    purpose: "Toggle the side rail (sessions list, ambient widgets).",
  },
  split: {
    paths: ["<rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"1\"/><path d=\"M8 2v12\"/>"],
    dot: [8, 2],
    purpose: "Split view. Spawns a peer agent in a second pane.",
  },
  grid: {
    paths: ["<rect x=\"2\" y=\"2\" width=\"5\" height=\"5\"/><rect x=\"9\" y=\"2\" width=\"5\" height=\"5\"/><rect x=\"2\" y=\"9\" width=\"5\" height=\"5\"/><rect x=\"9\" y=\"9\" width=\"5\" height=\"5\"/>"],
    dot: [14, 2],
    purpose: "Multi-session overview. Tab-grouping surfaces.",
  },
  minimap: {
    paths: ["<rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"1\"/><rect x=\"4\" y=\"6\" width=\"8\" height=\"3\"/>"],
    dot: [14, 2],
    purpose: "Session minimap toggle. Scrubbable timeline of the conversation.",
  },
  layers: {
    paths: ["<path d=\"M8 2l6 3-6 3-6-3z\"/><path d=\"M2 8l6 3 6-3M2 11l6 3 6-3\"/>"],
    dot: [14, 5],
    purpose: "Stack of revisions / undo history.",
  },
  focus: {
    paths: ["<path d=\"M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3\"/><circle cx=\"8\" cy=\"8\" r=\"2\"/>"],
    dot: [8, 8],
    purpose: "Focus / fullscreen mode. Hide chrome, max the canvas.",
  },
  circle: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"3\"/>"],
    dot: [8, 8],
    purpose: "Generic status pip. Default neutral state.",
  },
  dot: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"2\"/>"],
    dot: [8, 8],
    purpose: "Compact unread / dirty marker. Tab title indicator.",
  },
  warn: {
    paths: ["<path d=\"M8 2l6 11H2z\"/><path d=\"M8 6v3\"/>"],
    dot: [8, 11],
    purpose: "Risk / caution. Plan-risk chips, destructive previews.",
  },
  info: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 7v4\"/>"],
    dot: [8, 5],
    purpose: "Hint / help. Tooltips, model-help drawer trigger.",
  },
  clock: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 4v4l3 2\"/>"],
    dot: [11, 10],
    purpose: "Wall-time estimate. Plan-budget row, queued tool calls.",
  },
  live: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"2.5\" fill=\"currentColor\"/><circle cx=\"8\" cy=\"8\" r=\"5.5\"/>"],
    dot: [8, 8],
    purpose: "Live / streaming. Pulses while a tool is running. Recording-style.",
  },
  branch: {
    paths: ["<circle cx=\"4\" cy=\"3\" r=\"1.5\"/><circle cx=\"4\" cy=\"13\" r=\"1.5\"/><circle cx=\"12\" cy=\"8\" r=\"1.5\"/><path d=\"M4 4.5v7M4 8h2a4 4 0 0 0 4-4\"/>"],
    dot: [12, 8],
    purpose: "Active git branch. Plan header, branch-from-here action.",
  },
  merge: {
    paths: ["<circle cx=\"4\" cy=\"3\" r=\"1.5\"/><circle cx=\"4\" cy=\"13\" r=\"1.5\"/><circle cx=\"12\" cy=\"13\" r=\"1.5\"/><path d=\"M4 4.5v7M4 8a4 4 0 0 0 4 4h2.5\"/>"],
    dot: [12, 13],
    purpose: "Merge a side-conversation back into the main session.",
  },
  commit: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"3\"/><path d=\"M2 8h3M11 8h3\"/>"],
    dot: [8, 8],
    purpose: "Commit point on the timeline. Snapshot of agent state.",
  },
  diff2: {
    paths: ["<path d=\"M5 2v8l-2-2\"/><path d=\"M5 2l2 2\"/><path d=\"M11 14V6l2 2\"/><path d=\"M11 14l-2-2\"/>"],
    dot: [5, 2],
    purpose: "Compare revisions / before-after. Diff scrubber.",
  },
  command: {
    paths: ["<path d=\"M5 5a2 2 0 1 0-2 2h2zM5 5v6M5 11a2 2 0 1 0 2-2H5zM11 11a2 2 0 1 0 2-2h-2zM11 11V5M11 5a2 2 0 1 0-2 2h2z\"/>"],
    dot: [13, 9],
    purpose: "⌘K command bridge entry point. Power-user palette.",
  },
  image: {
    paths: ["<rect x=\"2\" y=\"3\" width=\"12\" height=\"10\" rx=\"1\"/><circle cx=\"6\" cy=\"7\" r=\"1.2\"/><path d=\"M3 12l3-3 3 2 2-2 4 4\"/>"],
    dot: [14, 3],
    purpose: "Image attachment in composer; image-content message bubbles.",
  },
  link: {
    paths: ["<path d=\"M7 9l-2 2a3 3 0 0 1-4-4l2-2\"/><path d=\"M9 7l2-2a3 3 0 0 1 4 4l-2 2\"/><path d=\"M6 10l4-4\"/>"],
    dot: [14, 5],
    purpose: "Hyperlinks / shareable session URL.",
  },
  send: {
    paths: ["<path d=\"M2 8l12-5-5 12-2-5z\"/>"],
    dot: [14, 3],
    purpose: "Send (alternate to arrowUp). Use when send is a primary surface action.",
  },
  cog: {
    paths: ["<circle cx=\"8\" cy=\"8\" r=\"2\"/><path d=\"M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3\"/>"],
    dot: [8, 8],
    purpose: "Settings. Theme, accent, layout, model defaults.",
  },
};

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
  color?: string;
  dotColor?: string;
}

export const Icon: React.FC<IconProps> = ({
  name,
  size = 14,
  color = "currentColor",
  dotColor = "var(--accent, #ff8a4c)",
  ...rest
}) => {
  const def = PATHS[name];
  if (!def) return null;
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      {...rest}
    >
      <g dangerouslySetInnerHTML={{ __html: def.paths.join("") }} />
      <circle cx={def.dot[0]} cy={def.dot[1]} r={1.6} fill={dotColor} stroke="none" />
    </svg>
  );
};

export const ICON_PURPOSE: Record<IconName, string> = Object.fromEntries(
  Object.entries(PATHS).map(([k, v]) => [k, v.purpose]),
) as Record<IconName, string>;
