/* ui/use-drag-reorder.js — pointer drag-to-reorder (#40), shared by the tab
   bar (projects, and a group chip's member list) and the project sidebar.

   const reorder = useDragReorder(onDrop):
   - `reorder.onPointerDown` goes on a container; the items inside it carry
     `reorder.itemProps(list, id, axis)` (`axis` "x" or "y"). A press on an
     item becomes a drag once it travels OMP_DRAG_REORDER's threshold, so a
     click still selects. Only items of the same `list` are drop targets: a
     member row never lands among projects.
   - `reorder.dropClass(list, id)` is " reorder-src" for the dragged item,
     " drop-before" / " drop-after" for the slot's neighbour, else "".
   - Releasing over a slot calls `onDrop(list, id, targetId, after)`, in
     display order. The click that release produces is swallowed, so a drop
     never also selects a tab or closes the dropdown. Escape cancels until
     the button is released.

   Pointer events, not HTML5 drag and drop: on Windows, Tauri's native file
   drop (`dragDropEnabled`, on by default) swallows HTML5 drag events. The
   pointer is captured on the item, so a release outside the window still
   ends the drag. Wrapped as an IIFE (AGENTS.md "IIFE rule"). */

(function () {
  const { pastThreshold, dropSlot } = window.OMP_DRAG_REORDER;
  // Controls inside an item that keep their own press. `data-no-reorder`
  // marks a region inside an item (a dropdown) that only its own nested
  // items may drag from.
  const NO_DRAG = "input, textarea, .tab-close, .tab-group-trigger, .psb-act, .psb-chev, [data-no-reorder]";

  function span(el, axis) {
    const r = el.getBoundingClientRect();
    return axis === "y"
      ? { id: el.dataset.reorderId, start: r.top, end: r.bottom }
      : { id: el.dataset.reorderId, start: r.left, end: r.right };
  }

  function useDragReorder(onDrop) {
    // `{ list, id, targetId, after }` while a drag is past the threshold.
    const [drag, setDrag] = React.useState(null);
    const onDropRef = React.useRef(onDrop);
    onDropRef.current = onDrop;
    const endRef = React.useRef(null);
    React.useEffect(() => () => endRef.current?.(), []);

    const onPointerDown = React.useCallback(e => {
      if (e.button !== 0 || !e.isPrimary || endRef.current) return;
      const container = e.currentTarget;
      const item = e.target.closest("[data-reorder-id]");
      if (!item || !container.contains(item)) return;
      const stop = e.target.closest(NO_DRAG);
      if (stop && item.contains(stop)) return;
      const { reorderList: list, reorderId: id } = item.dataset;
      const axis = item.dataset.reorderAxis === "y" ? "y" : "x";
      const { pointerId, clientX: x0, clientY: y0 } = e;
      let started = false;
      let cancelled = false;
      let slot = null;

      const show = next => setDrag(prev => (prev && next && prev.targetId === next.targetId && prev.after === next.after ? prev : next));
      const move = ev => {
        if (ev.pointerId !== pointerId || cancelled) return;
        if (!started) {
          if (!pastThreshold(ev.clientX - x0, ev.clientY - y0)) return;
          started = true;
          try { item.setPointerCapture(pointerId); } catch (_) { /* pointer already gone */ }
          document.body.classList.add("reordering");
          window.getSelection()?.removeAllRanges();
        }
        const items = [...container.querySelectorAll("[data-reorder-id]")]
          .filter(el => el.dataset.reorderList === list)
          .map(el => span(el, axis));
        slot = dropSlot(items, id, axis === "y" ? ev.clientY : ev.clientX);
        show({ list, id, targetId: slot ? slot.targetId : null, after: !!slot?.after });
      };
      const end = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", lost, true);
        window.removeEventListener("keydown", key, true);
        item.removeEventListener("lostpointercapture", lost);
        try { if (item.hasPointerCapture(pointerId)) item.releasePointerCapture(pointerId); } catch (_) { /* detached */ }
        document.body.classList.remove("reordering");
        endRef.current = null;
        setDrag(null);
      };
      const up = ev => {
        if (ev.pointerId !== pointerId) return;
        end();
        if (!started) return;
        const swallow = c => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", swallow, true);
        // The release's click, if any, is dispatched before this runs.
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        if (!cancelled && slot) onDropRef.current(list, id, slot.targetId, slot.after);
      };
      // Capture lost (the item unmounted) or the gesture cancelled: no drop.
      const lost = ev => { if (ev.pointerId === pointerId) end(); };
      const key = ev => {
        if (ev.key !== "Escape" || !started) return;
        // Before the window keymap, which would interrupt the turn.
        ev.preventDefault();
        ev.stopPropagation();
        cancelled = true;
        slot = null;
        show(null);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", lost, true);
      window.addEventListener("keydown", key, true);
      item.addEventListener("lostpointercapture", lost);
      endRef.current = end;
    }, []);

    const itemProps = (list, id, axis) => ({
      "data-reorder-list": list, "data-reorder-id": id, "data-reorder-axis": axis,
    });
    const dropClass = (list, id) => {
      if (!drag || drag.list !== list) return "";
      if (drag.id === id) return " reorder-src";
      if (drag.targetId === id) return drag.after ? " drop-after" : " drop-before";
      return "";
    };
    return { onPointerDown, itemProps, dropClass };
  }

  window.useDragReorder = useDragReorder;
})();
