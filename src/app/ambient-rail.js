// Ambient card identities and ordering. Visibility uses the existing tweak
// keys so Settings and the inline controls share the same lifecycle effects.
(function () {
  const BUILT_INS = [
    { id: "showContext", label: "Context gauge" },
    { id: "showRadar", label: "Agent radar" },
    { id: "showSubagents", label: "Subagents" },
    { id: "showAgentContext", label: "Agent context" },
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

  window.OMP_AMBIENT_RAIL = { items, ordered, move };
})();
