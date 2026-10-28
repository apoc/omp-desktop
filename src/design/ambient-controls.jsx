// Shared by the inline Ambient controls and Settings → Rail → Card order.
function AmbientCardList({ items, tweaks, onChange, visibility = true }) {
  const { Icon } = window;
  const model = window.OMP_AMBIENT_RAIL;
  const ordered = model.ordered(items, tweaks.railOrder);
  const [announcement, announce] = React.useState("");
  const move = (id, targetId, after) => {
    const next = model.move(items, tweaks.railOrder, id, targetId, after);
    if (next === tweaks.railOrder) return;
    onChange("railOrder", next);
    const position = model
      .ordered(items, next)
      .findIndex((item) => item.id === id);
    announce(
      `${items.find((item) => item.id === id).label} moved to position ${position + 1} of ${items.length}`,
    );
  };
  const reorder = window.useDragReorder((list, id, targetId, after) =>
    move(id, targetId, after),
  );
  return (
    <>
      <ol
        className="ambient-card-list"
        aria-label="Ambient card order"
        onPointerDown={(e) => {
          if (e.target.closest(".ambient-grip")) reorder.onPointerDown(e);
        }}
      >
        {ordered.map((item, index) => (
          <li
            key={item.id}
            className={`ambient-control-row${reorder.dropClass("ambient", item.id)}`}
            {...reorder.itemProps("ambient", item.id, "y")}
          >
            <span
              className="ambient-grip"
              aria-hidden="true"
              title="Drag to reorder"
            >
              ⠿
            </span>
            {visibility ? (
              <label className="ambient-control-label">
                <input
                  type="checkbox"
                  checked={tweaks[item.id] !== false}
                  onChange={(e) => onChange(item.id, e.target.checked)}
                />
                <span>
                  {item.label}
                  {item.source && <small>{item.source}</small>}
                </span>
              </label>
            ) : (
              <span className="ambient-control-label">{item.label}</span>
            )}
            <span className="ambient-move-buttons">
              <button
                type="button"
                aria-label={`Move ${item.label} up`}
                title="Move up"
                aria-disabled={index === 0}
                onClick={() => {
                  if (index > 0) move(item.id, ordered[index - 1].id, false);
                }}
              >
                <Icon name="arrowUp" size={11} />
              </button>
              <button
                type="button"
                aria-label={`Move ${item.label} down`}
                title="Move down"
                aria-disabled={index === ordered.length - 1}
                onClick={() => {
                  if (index < ordered.length - 1)
                    move(item.id, ordered[index + 1].id, true);
                }}
              >
                <span className="ambient-down">
                  <Icon name="arrowUp" size={11} />
                </span>
              </button>
            </span>
          </li>
        ))}
      </ol>
      <span className="ambient-announcement" role="status">
        {announcement}
      </span>
    </>
  );
}

window.AmbientCardList = AmbientCardList;
