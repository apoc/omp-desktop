// Local extension commands only: settings edits never become agent prompts.
(function () {
  const PREFIX = "OMP_DESKTOP_CONTEXT_POLICY:";
  const COMMAND = /^omp-desktop-context-policy-[a-zA-Z0-9-]+$/;
  const REFRESH_EVENTS = new Set([
    "config_update",
    "session_info_update",
    "model_changed",
  ]);
  const privateFrame = (frame) =>
    frame?.type === "extension_ui_request" &&
    frame.method === "notify" &&
    typeof frame.message === "string" &&
    frame.message.startsWith(PREFIX);
  let sequence = 0;

  function create({ request, current, profileId, changed }) {
    let state = { policy: null, loading: false, saving: false, error: null };
    let command = null,
      loading = null,
      disposed = false,
      maintenance = null,
      reload = false;
    const pending = new Map();
    const valid = () => !disposed && current();
    const publish = (next) => {
      if (!valid()) return;
      state = { ...state, ...next };
      changed(state);
    };
    const check = () => {
      if (!valid())
        throw new Error("Conversation changed; refresh its context policy.");
    };
    function accept(policy) {
      if (!policy || policy.profileId !== profileId)
        throw new Error("Native context policy belongs to another profile.");
      if (
        policy.supported &&
        (!policy.model ||
          typeof policy.revision !== "string" ||
          !Array.isArray(policy.controls))
      )
        throw new Error("Native context policy response is incomplete.");
      return maintenance ? { ...policy, lastMaintenance: maintenance } : policy;
    }
    async function discover() {
      if (command) return true;
      const data = await request({ type: "get_available_commands" });
      check();
      const commands = (data?.commands || []).filter(
        (item) =>
          typeof item.name === "string" &&
          COMMAND.test(item.name) &&
          item.source === "extension",
      );
      if (commands.length !== 1) return false;
      command = commands[0].name;
      return true;
    }
    async function dispatch(op, fields = {}) {
      check();
      if (!(await discover()))
        return {
          supported: false,
          profileId,
          controls: [],
          reason:
            "This omp session does not support native context-policy editing. Start a new conversation with the updated Desktop extension.",
        };
      check();
      const id = `context-policy-${++sequence}`;
      let timer;
      const result = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              "omp has not confirmed the policy update; refresh before trying again.",
            ),
          );
        }, 30000);
        pending.set(id, { resolve, reject });
      });
      const ack = request(
        {
          type: "prompt",
          message: `/${command} ${JSON.stringify({ ...fields, op, id, profileId })}`,
        },
        30000,
        "context-policy-",
      );
      try {
        const [accepted, policy] = await Promise.all([ack, result]);
        check();
        if (accepted?.agentInvoked === true)
          throw new Error("omp did not handle the settings command locally.");
        return accept(policy);
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    }
    async function load() {
      check();
      if (loading) return loading;
      publish({ loading: true, error: null });
      loading = dispatch("get")
        .then(
          (policy) => {
            publish({ policy, loading: false });
            return policy;
          },
          (error) => {
            publish({ loading: false, error: error.message });
            throw error;
          },
        )
        .finally(() => {
          loading = null;
          if (reload && valid()) {
            reload = false;
            void load().catch(() => {});
          }
        });
      return loading;
    }
    async function apply(input) {
      check();
      if (!state.policy?.supported)
        throw new Error(
          "This omp session does not support context-policy editing.",
        );
      if (state.saving || loading)
        throw new Error("A context-policy operation is already in progress.");
      publish({ saving: true, error: null });
      try {
        const policy = await dispatch("apply", input);
        publish({ policy, saving: false });
        return policy;
      } catch (error) {
        publish({ saving: false, error: error.message });
        throw error;
      }
    }
    function observe(frame) {
      if (privateFrame(frame)) {
        if (!valid()) return true;
        let data;
        try {
          data = JSON.parse(frame.message.slice(PREFIX.length));
        } catch {
          return true;
        }
        if (data.command !== command) return true;
        const waiting = pending.get(data.id);
        if (waiting) {
          if (data.error) waiting.reject(new Error(data.error));
          else waiting.resolve(data.policy);
        } else if (data.id == null && !state.saving) {
          try {
            publish({ policy: accept(data.policy), error: null });
          } catch (error) {
            publish({ error: error.message });
          }
        }
        return true;
      }
      if (!valid()) return false;
      if (
        REFRESH_EVENTS.has(frame.type) &&
        !state.saving &&
        (state.policy || loading)
      ) {
        if (loading) reload = true;
        else void load().catch(() => {});
        return false;
      }
      if (!state.policy) return false;
      if (frame.type === "auto_compaction_start") {
        maintenance = { status: "running", method: frame.action };
        publish({ policy: { ...state.policy, lastMaintenance: maintenance } });
      } else if (frame.type === "auto_compaction_end") {
        maintenance = {
          status: frame.error
            ? "failed"
            : frame.aborted
              ? "aborted"
              : "completed",
          method: frame.result?.method || frame.action,
          error: frame.error,
        };
        publish({ policy: { ...state.policy, lastMaintenance: maintenance } });
        if (!state.saving) void load().catch(() => {});
      }
      return false;
    }
    return {
      load,
      apply,
      observe,
      snapshot: () => state,
      dispose() {
        disposed = true;
        for (const item of pending.values())
          item.reject(
            new Error(
              "Conversation changed or closed; refresh its context policy.",
            ),
          );
        pending.clear();
      },
    };
  }
  window.OMP_CONTEXT_POLICY = {
    PREFIX,
    privateFrame,
    create,
    privateCommand: (name) => COMMAND.test(name),
  };
})();
