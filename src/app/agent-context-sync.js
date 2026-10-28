// One activation owns its native reads. Progress triggers coalesced byte tails;
// no polling loop, model calls, or always-on subagent event subscription.
(function () {
  function create({ request, get, set, current, changed, subagents }) {
    const model = window.OMP_AGENT_CONTEXT;
    const pending = new Map(),
      dirty = new Set(),
      observed = new Map();
    let timer = null;
    const commit = (next) => {
      if (current()) {
        set(next);
        changed();
      }
    };
    function schedule(id) {
      if (!current()) return;
      dirty.add(id);
      if (timer == null) timer = setTimeout(flush, 250);
    }
    function flush() {
      timer = null;
      if (!current()) {
        dirty.clear();
        return;
      }
      let count = pending.size;
      for (const id of dirty) {
        if (count >= 4) break;
        if (pending.has(id)) continue;
        dirty.delete(id);
        count++;
        void load(id).catch(() => {});
      }
    }
    function load(id, full = false) {
      if (!current()) return Promise.resolve(null);
      if (pending.has(id))
        return full
          ? pending.get(id).then(() => load(id, true))
          : pending.get(id);
      const agent = model.get(get(), id);
      if (!agent || (id !== "main" && !agent.sessionFile))
        return Promise.resolve(null);
      const owner = agent.sessionFile;
      const command =
        id === "main"
          ? {
              type: "get_entries",
              ...(!full && agent.cursor ? { since: agent.cursor } : {}),
            }
          : {
              type: "get_subagent_messages",
              subagentId: id,
              fromByte: full ? 0 : agent.nextByte,
            };
      const promise = request(command)
        .then((data) => {
          if (
            !current() ||
            (id !== "main" && model.get(get(), id)?.sessionFile !== owner)
          )
            return null;
          if (data)
            commit(
              model.entries(get(), id, { ...data, reset: full || data.reset }),
            );
          return data;
        })
        .catch((error) => {
          if (
            current() &&
            (id === "main" || model.get(get(), id)?.sessionFile === owner)
          )
            commit(model.failed(get(), id, error));
          throw error;
        })
        .finally(() => {
          pending.delete(id);
          if (current() && dirty.size) flush();
        });
      pending.set(id, promise);
      return promise;
    }
    function refreshAgents() {
      if (!current()) return;
      let next = get();
      for (const id of subagents().order || []) {
        const agent = subagents().byId[id];
        if (observed.get(id) === agent) continue;
        observed.set(id, agent);
        next = model.register(next, { ...agent, label: id });
        if (agent.sessionFile) schedule(id);
      }
      set(next);
    }
    function observe(frame) {
      if (!current()) return;
      if (["subagent_lifecycle", "subagent_progress"].includes(frame.type))
        refreshAgents();
      else if (
        [
          "agent_start",
          "agent_end",
          "turn_end",
          "tool_execution_end",
          "config_update",
        ].includes(frame.type) ||
        (frame.type === "message_end" && frame.message?.role === "custom")
      )
        schedule("main");
    }
    return {
      current,
      observe,
      refreshAgents,
      loadMain: () => load("main", true),
      dispose() {
        clearTimeout(timer);
        timer = null;
        dirty.clear();
      },
    };
  }
  window.OMP_AGENT_CONTEXT_SYNC = { create };
})();
