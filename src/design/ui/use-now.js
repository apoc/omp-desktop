// ui/use-now.js — a local clock for views that age on their own.
//
// useNow(active, ms): `[now, setNow]`, starting at Date.now(). While `active`
// is truthy the clock resets to now and then ticks every `ms`; changing
// `active` restarts it and setting it falsy stops the timer. Used by
// persona-strip.jsx and persona-inbox-card.jsx (so "in 12 min" stays true
// while the window idles) and app/use-conversation-tree.jsx (its
// warm → expiring → cold countdowns), which also bumps it after a fetch.
//
// Wrapped in an IIFE so `useNow` doesn't leak into document scope.
(function () {
  const DEFAULT_MS = 30_000;

  function useNow(active, ms = DEFAULT_MS) {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
      if (!active) return undefined;
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), ms);
      return () => clearInterval(timer);
    }, [active, ms]);
    return [now, setNow];
  }

  window.useNow = useNow;
})();
