// Local native-extension transport. Metadata edits never start an agent turn.
(function () {
  const PREFIX = "OMP_DESKTOP_EVIDENCE:";
  const COMMAND = /^omp-desktop-evidence-([a-zA-Z0-9-]+)$/;
  let sequence = 0;
  const privateFrame = (frame) =>
    frame?.type === "extension_ui_request" &&
    frame.method === "notify" &&
    typeof frame.message === "string" &&
    frame.message.startsWith(PREFIX);

  function create({ request, current, profileId, changed }) {
    let state = { view: null, loading: false, saving: false, error: null };
    let command = null,
      loading = null,
      disposed = false;
    const pending = new Map();
    const valid = () => !disposed && current();
    const check = () => {
      if (!valid())
        throw new Error("Conversation changed; reopen its Evidence inspector.");
    };
    const publish = (patch) => {
      if (valid()) {
        state = { ...state, ...patch };
        changed(state);
      }
    };
    function accept(view) {
      if (!view || view.version !== 1 || view.profileId !== profileId)
        throw new Error(
          "Evidence belongs to another profile or uses an unsupported format.",
        );
      if (view.supported === false) return view;
      if (
        typeof view.epoch !== "string" ||
        !COMMAND.test(`omp-desktop-evidence-${view.epoch}`) ||
        typeof view.sessionId !== "string" ||
        typeof view.branchToken !== "string" ||
        !Number.isSafeInteger(view.revision) ||
        !Array.isArray(view.outcomes) ||
        !Array.isArray(view.records)
      )
        throw new Error("Native Evidence response is incomplete.");
      const candidate = `omp-desktop-evidence-${view.epoch}`;
      if (command && command !== candidate)
        throw new Error(
          "Evidence came from a replaced agent process; refresh the conversation.",
        );
      command = candidate;
      return view;
    }
    function restore(view) {
      if (!valid()) return;
      try {
        const next = accept(view),
          previous = state.view;
        if (
          previous?.epoch === next.epoch &&
          Number.isSafeInteger(previous.sequence) &&
          Number.isSafeInteger(next.sequence) &&
          next.sequence < previous.sequence
        )
          return;
        publish({ view: next, error: null });
      } catch (error) {
        publish({ error: error.message });
      }
    }
    async function discover() {
      if (command) return true;
      const data = await request({ type: "get_available_commands" });
      check();
      const commands = (data?.commands || []).filter(
        (item) => item.source === "extension" && COMMAND.test(item.name),
      );
      if (commands.length !== 1) return false;
      command = commands[0].name;
      return true;
    }
    async function dispatch(input) {
      check();
      if (!(await discover()))
        throw new Error(
          "This process has no desktop Evidence extension. Restart its agent with the updated Desktop build.",
        );
      check();
      const id = `evidence-${++sequence}`;
      let timer;
      const result = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              "Evidence was not confirmed; refresh before retrying. The operation may already have been saved.",
            ),
          );
        }, 45000);
        pending.set(id, { resolve, reject });
      });
      try {
        const [ack, view] = await Promise.all([
          request(
            {
              type: "prompt",
              message: `/${command} ${JSON.stringify({ ...input, id, profileId })}`,
            },
            45000,
            "evidence-",
          ),
          result,
        ]);
        check();
        if (ack?.agentInvoked === true)
          throw new Error("omp did not handle the Evidence command locally.");
        return accept(view);
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    }
    function load() {
      check();
      if (loading) return loading;
      publish({ loading: true, error: null });
      loading = dispatch({ op: "get" })
        .then(
          (view) => {
            restore(view);
            publish({ loading: false });
            return state.view;
          },
          (error) => {
            publish({ loading: false, error: error.message });
            throw error;
          },
        )
        .finally(() => {
          loading = null;
        });
      return loading;
    }
    async function mutate(input) {
      check();
      if (!state.view?.supported)
        throw new Error("Load this conversation's Evidence before editing it.");
      if (state.saving || loading)
        throw new Error("An Evidence operation is already in progress.");
      publish({ saving: true, error: null });
      try {
        const view = await dispatch({
          ...input,
          revision: state.view.revision,
          sessionId: state.view.sessionId,
          file: state.view.file,
          branchToken: state.view.branchToken,
        });
        restore(view);
        publish({ saving: false });
        return state.view;
      } catch (error) {
        publish({ saving: false, error: error.message });
        throw error;
      }
    }
    function observe(frame) {
      if (!privateFrame(frame)) return false;
      if (!valid()) return true;
      try {
        const data = JSON.parse(frame.message.slice(PREFIX.length));
        if (
          data.version !== 1 ||
          !COMMAND.test(data.command) ||
          data.command !== `omp-desktop-evidence-${data.epoch}` ||
          (command && command !== data.command)
        )
          return true;
        command = data.command;
        const waiting = pending.get(data.id);
        if (data.view) restore(data.view);
        if (waiting) {
          if (data.error) waiting.reject(new Error(data.error));
          else waiting.resolve(data.view);
        } else if (data.error) publish({ error: String(data.error) });
      } catch (error) {
        publish({ error: `Invalid native Evidence update: ${error.message}` });
      }
      return true;
    }
    return {
      load,
      mutate,
      observe,
      restore,
      snapshot: () => state,
      dispose() {
        disposed = true;
        for (const item of pending.values())
          item.reject(
            new Error("Conversation changed before Evidence was confirmed."),
          );
        pending.clear();
      },
    };
  }
  window.OMP_EVIDENCE_CLIENT = {
    PREFIX,
    privateFrame,
    privateCommand: (name) => COMMAND.test(name),
    create,
  };
})();
