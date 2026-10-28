// Ambient card identities and ordering. Visibility uses the existing tweak
// keys so Settings and the inline controls share the same lifecycle effects.
(function () {
  const BUILT_INS = [
    { id: "showContext", label: "Context" },
    { id: "showRadar", label: "Agent radar" },
    { id: "showSubagents", label: "Subagents" },
    { id: "showChanges", label: "Changes" },
  ];
  const MINIMAP = { id: "showMinimap", label: "Minimap" };

  function items(plugins, extensions) {
    return [
      ...BUILT_INS,
      ...plugins.map((p) => ({
        id: window.OMP_WIDGETS.tweakKey(p.id),
        label: p.title,
        source: "Plugin",
      })),
      ...extensions.map((e) => ({
        id: e.tweak,
        label: e.label,
        source: "Extension",
      })),
      MINIMAP,
    ];
  }

  function savedIds(saved) {
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id) => typeof id === "string"))]
      : [];
  }

  // Merge the former gauge/inventory cards once, preserving either visible
  // surface and the first of their saved positions. Remove the obsolete key.
  function migrate(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return {};
    const legacy = Object.prototype.hasOwnProperty.call(values, "showAgentContext");
    const orderedLegacy = Array.isArray(values.railOrder) && values.railOrder.includes("showAgentContext");
    if (!legacy && !orderedLegacy) return values;
    const { showAgentContext, ...next } = values;
    if (legacy) next.showContext = values.showContext !== false || showAgentContext !== false;
    if (orderedLegacy) next.railOrder = savedIds(values.railOrder.map(id => id === "showAgentContext" ? "showContext" : id));
    return next;
  }

  /** Missing/new cards retain their default order; stale ids render nothing. */
  function ordered(items, saved) {
    const remaining = new Map(items.map((item) => [item.id, item]));
    const result = [];
    for (const id of savedIds(saved)) {
      if (!remaining.has(id)) continue;
      result.push(remaining.get(id));
      remaining.delete(id);
    }
    return result.concat([...remaining.values()]);
  }

  /** Keep absent widgets' slots so moving a card in one tab does not erase
   * another tab's layout. Hidden cards remain in the order too. */
  function move(items, saved, id, targetId, after) {
    if (
      id === targetId ||
      !items.some((item) => item.id === id) ||
      !items.some((item) => item.id === targetId)
    )
      return saved;
    const order = savedIds(saved);
    const known = new Set(order);
    for (const item of items) {
      if (!known.has(item.id)) {
        order.push(item.id);
        known.add(item.id);
      }
    }
    order.splice(order.indexOf(id), 1);
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id);
    return order;
  }

  window.OMP_AMBIENT_RAIL = { items, ordered, move, migrate };
})();
