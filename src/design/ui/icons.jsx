/* ui/icons.jsx — OMP Icon Pack v1 (58 icons) + Icon component +
   TOOL_META map (tool name → colour, icon, label). */

// Each icon has a single accent dot. Props: name, size, color, dotColor.
const _ICON_PATHS = {
  plus:    { p: ['<path d="M8 3v10M3 8h10"/>'],                                                                                                                                                                                                d: [12,4]    },
  minus:   { p: ['<path d="M3 8h10"/>'],                                                                                                                                                                                                       d: [12,8]    },
  close:   { p: ['<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>'],                                                                                                                                                                                   d: [12,4]    },
  check:   { p: ['<path d="M3 8l3 3 7-7"/>'],                                                                                                                                                                                                  d: [13,4]    },
  play:    { p: ['<path d="M5 3l8 5-8 5z"/>'],                                                                                                                                                                                                 d: [13,8]    },
  pause:   { p: ['<rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/>'],                                                                                                                                        d: [12,8]    },
  stop:    { p: ['<rect x="4" y="4" width="8" height="8" rx="1"/>'],                                                                                                                                                                           d: [12,4]    },
  refresh: { p: ['<path d="M3 8a5 5 0 0 1 8.5-3.5L13 6"/><path d="M13 3v3h-3"/><path d="M13 8a5 5 0 0 1-8.5 3.5L3 10"/><path d="M3 13v-3h3"/>'],                                                                                            d: [13,3]    },
  copy:    { p: ['<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10V4a1 1 0 0 1 1-1h6"/>'],                                                                                                                                       d: [13,5]    },
  trash:   { p: ['<path d="M3 4h10"/><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4"/>'],                                                                                               d: [8,8]     },
  file:    { p: ['<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>'],                                                                                                                                                                          d: [12,5]    },
  folder:  { p: ['<path d="M2 5l2-2h3l1 1h6v8H2z"/>'],                                                                                                                                                                                        d: [14,5]    },
  edit:    { p: ['<path d="M2 12V14h2l8-8-2-2-8 8z"/><path d="M9 4l2 2"/>'],                                                                                                                                                                  d: [12,4]    },
  diff:    { p: ['<path d="M5 2v12M11 2v12"/><path d="M3 5h4"/><path d="M9 11h4"/>'],                                                                                                                                                         d: [5,2]     },
  bash:    { p: ['<path d="M3 4l3 3-3 3"/><path d="M8 11h5"/>'],                                                                                                                                                                              d: [6,7]     },
  search:  { p: ['<circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/>'],                                                                                                                                                                      d: [13,13]   },
  grep:    { p: ['<circle cx="6" cy="6" r="3.5"/><path d="M8.5 8.5l4 4"/><path d="M4.5 6h3"/>'],                                                                                                                                              d: [12.5,12.5] },
  test:    { p: ['<path d="M5 2v4l-3 6a2 2 0 0 0 1.7 3h8.6A2 2 0 0 0 14 12l-3-6V2"/><path d="M4 2h8"/>'],                                                                                                                                    d: [11,2]    },
  build:   { p: ['<rect x="2" y="6" width="5" height="8"/><rect x="9" y="2" width="5" height="12"/>'],                                                                                                                                        d: [14,2]    },
  web:     { p: ['<circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2 2 2 10 0 12c-2-2-2-10 0-12"/>'],                                                                                                                           d: [14,8]    },
  plan:    { p: ['<rect x="2" y="3" width="3" height="10"/><rect x="6.5" y="3" width="3" height="6"/><rect x="11" y="3" width="3" height="8"/>'],                                                                                             d: [12.5,3]  },
  thinking:{ p: ['<path d="M5 3a3 3 0 0 1 6 0c0 1.5-1.5 2-1.5 3.5h-3C6.5 5 5 4.5 5 3z"/><path d="M6.5 9.5h3M7 12h2"/>'],                                                                                                                   d: [8,3]     },
  agent:   { p: ['<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2v3"/><circle cx="6" cy="9" r=".7" fill="currentColor"/><circle cx="10" cy="9" r=".7" fill="currentColor"/>'],                                                  d: [8,2]     },
  sparkle: { p: ['<path d="M8 2l1.2 3.2L13 6l-3.8 0.8L8 10l-1.2-3.2L3 6l3.8-0.8z"/>'],                                                                                                                                                      d: [12,12]   },
  bolt:    { p: ['<path d="M9 1L3 9h4l-1 6 6-8H8z"/>'],                                                                                                                                                                                       d: [12,3]    },
  radar:   { p: ['<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><path d="M8 8l4-3"/>'],                                                                                                                                           d: [12,5]    },
  voice:   { p: ['<rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3 8a5 5 0 0 0 10 0M8 13v2"/>'],                                                                                                                                    d: [8,2]     },
  context: { p: ['<circle cx="8" cy="8" r="6"/><path d="M8 8 L8 2 A6 6 0 0 1 13 11 Z" fill="currentColor" fill-opacity=".15" stroke-width="0"/><circle cx="8" cy="8" r="6"/>'],                                                             d: [13,11]   },
  tokens:  { p: ['<circle cx="5" cy="8" r="3"/><circle cx="11" cy="8" r="3"/>'],                                                                                                                                                              d: [11,8]    },
  cost:    { p: ['<circle cx="8" cy="8" r="6"/><path d="M10 6H7a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H6"/><path d="M8 4v8"/>'],                                                                                                             d: [8,4]     },
  arrow:   { p: ['<path d="M3 8h10"/><path d="M9 4l4 4-4 4"/>'],                                                                                                                                                                              d: [13,8]    },
  arrowUp: { p: ['<path d="M8 13V3"/><path d="M4 7l4-4 4 4"/>'],                                                                                                                                                                              d: [8,3]     },
  chev:    { p: ['<path d="M5 6l3 3 3-3"/>'],                                                                                                                                                                                                  d: [8,9]     },
  chevR:   { p: ['<path d="M6 5l3 3-3 3"/>'],                                                                                                                                                                                                  d: [9,8]     },
  home:    { p: ['<path d="M2 8l6-5 6 5v6H9v-4H7v4H2z"/>'],                                                                                                                                                                                   d: [8,3]     },
  back:    { p: ['<path d="M13 8H3"/><path d="M7 4L3 8l4 4"/>'],                                                                                                                                                                              d: [3,8]     },
  external:{ p: ['<path d="M9 3h4v4"/><path d="M13 3l-6 6"/><path d="M11 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3"/>'],                                                                                                         d: [13,3]    },
  sidebar: { p: ['<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6 3v10"/>'],                                                                                                                                                      d: [6,3]     },
  split:   { p: ['<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M8 2v12"/>'],                                                                                                                                                      d: [8,2]     },
  grid:    { p: ['<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>'],                                                        d: [14,2]    },
  minimap: { p: ['<rect x="2" y="2" width="12" height="12" rx="1"/><rect x="4" y="6" width="8" height="3"/>'],                                                                                                                                d: [14,2]    },
  layers:  { p: ['<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/>'],                                                                                                                                                      d: [14,5]    },
  focus:   { p: ['<path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"/><circle cx="8" cy="8" r="2"/>'],                                                                                                                                         d: [8,8]     },
  circle:  { p: ['<circle cx="8" cy="8" r="3"/>'],                                                                                                                                                                                             d: [8,8]     },
  dot:     { p: ['<circle cx="8" cy="8" r="2"/>'],                                                                                                                                                                                             d: [8,8]     },
  warn:    { p: ['<path d="M8 2l6 11H2z"/><path d="M8 6v3"/>'],                                                                                                                                                                               d: [8,11]    },
  info:    { p: ['<circle cx="8" cy="8" r="6"/><path d="M8 7v4"/>'],                                                                                                                                                                          d: [8,5]     },
  clock:   { p: ['<circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/>'],                                                                                                                                                                      d: [11,10]   },
  live:    { p: ['<circle cx="8" cy="8" r="2.5" fill="currentColor"/><circle cx="8" cy="8" r="5.5"/>'],                                                                                                                                       d: [8,8]     },
  branch:  { p: ['<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M4 4.5v7M4 8h2a4 4 0 0 0 4-4"/>'],                                                                                d: [12,8]    },
  merge:   { p: ['<circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="13" r="1.5"/><path d="M4 4.5v7M4 8a4 4 0 0 0 4 4h2.5"/>'],                                                                             d: [12,13]   },
  commit:  { p: ['<circle cx="8" cy="8" r="3"/><path d="M2 8h3M11 8h3"/>'],                                                                                                                                                                   d: [8,8]     },
  diff2:   { p: ['<path d="M5 2v8l-2-2"/><path d="M5 2l2 2"/><path d="M11 14V6l2 2"/><path d="M11 14l-2-2"/>'],                                                                                                                              d: [5,2]     },
  command: { p: ['<path d="M5 5a2 2 0 1 0-2 2h2zM5 5v6M5 11a2 2 0 1 0 2-2H5zM11 11a2 2 0 1 0 2-2h-2zM11 11V5M11 5a2 2 0 1 0-2 2h2z"/>'],                                                                                                  d: [13,9]    },
  image:   { p: ['<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="6" cy="7" r="1.2"/><path d="M3 12l3-3 3 2 2-2 4 4"/>'],                                                                                                       d: [14,3]    },
  link:    { p: ['<path d="M7 9l-2 2a3 3 0 0 1-4-4l2-2"/><path d="M9 7l2-2a3 3 0 0 1 4 4l-2 2"/><path d="M6 10l4-4"/>'],                                                                                                                    d: [14,5]    },
  send:    { p: ['<path d="M2 8l12-5-5 12-2-5z"/>'],                                                                                                                                                                                          d: [14,3]    },
  cog:     { p: ['<circle cx="8" cy="8" r="2"/><path d="M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"/>'],                                                                                            d: [8,8]     },
};
const Icon = ({ name, size = 14, color = "currentColor", dotColor = "var(--accent, #ff8a4c)", ...rest }) => {
  const def = _ICON_PATHS[name];
  if (!def) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <g dangerouslySetInnerHTML={{ __html: def.p.join("") }} />
      <circle cx={def.d[0]} cy={def.d[1]} r={1.6} fill={dotColor} stroke="none" />
    </svg>
  );
};

// Tool name → color + icon
const TOOL_META = {
  read:    { color: "var(--cyan)",    icon: "file",   label: "read" },
  search:  { color: "var(--lilac)",   icon: "search", label: "find" },
  edit:    { color: "var(--accent)",  icon: "diff",   label: "edit" },
  bash:    { color: "var(--amber)",   icon: "bash",   label: "bash" },
  write:   { color: "var(--magenta)", icon: "edit",   label: "write" },
  todo:    { color: "var(--lime)",    icon: "plan",  label: "todo"  },
  eval:    { color: "var(--rose)",    icon: "test",  label: "eval"  },
  task:    { color: "var(--cyan)",    icon: "agent", label: "task"  },
  debug:   { color: "var(--amber)",   icon: "bolt",  label: "debug" },
  ask:     { color: "var(--fg-3)",    icon: "circle",label: "ask"   },
};

Object.assign(window, { Icon, TOOL_META });
