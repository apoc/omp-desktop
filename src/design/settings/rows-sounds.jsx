/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-sounds.jsx — Settings → Session's custom `sounds`
   row (window.OMP_SETTINGS_ROWS, docs/architecture/notification-sounds.md
   D6): one line per cue — a segment of `none` plus the catalogue
   (OMP_NOTIFY_SOUND.SOUNDS) and a ▶ preview at the current volume. Picking
   a sound previews it too; a preview ignores the `notifySound` mode. Each
   line resets on its own (like the plugin switches in rows-layout.jsx).
   ═════════════════════════════════════════════════════════════════════ */

// `key`: the owned tweak; `pref`: its field in OMP_NOTIFY_SOUND.prefsFrom.
const _SRSND_CUES = [
  { key: "soundAttention", pref: "attention", label: "Question waiting", desc: "Plays when an agent asks you something: a question, a tool approval or a form." },
  { key: "soundFinished", pref: "finished", label: "Turn finished", desc: "Plays when an agent's turn ends, including one you aborted." },
];

function _SRSND_Sounds({ ctx, query }) {
  const { SettingsRow: Row, SettingsSeg: Seg, SettingsButton: Button, Icon } = window;
  const { NONE, SOUNDS, play, prefsFrom } = window.OMP_NOTIFY_SOUND;
  const defaults = window.TWEAK_DEFAULTS;
  const prefs = prefsFrom(ctx.t, defaults);
  const options = [{ value: NONE, label: "none" }, ...SOUNDS.map(s => ({ value: s.id, label: s.label }))];
  return (
    <>
      {_SRSND_CUES.map(({ key, pref, label, desc }) => {
        const value = prefs[pref];
        const pick = id => { ctx.setTweak(key, id); play(id, prefs.volume); };
        return (
          <Row key={key} stack label={label} desc={desc} query={query}
            modified={key in ctx.t && ctx.t[key] !== defaults[key]} onReset={() => ctx.setTweak(key, defaults[key])}
            aside={(
              <Button disabled={value === NONE || prefs.volume === 0} onClick={() => play(value, prefs.volume)}
                title={value === NONE ? undefined : OMP_TR("Preview {sound}", { sound: OMP_TR(SOUNDS.find(s => s.id === value).label) })}>
                <Icon name="play" size={11} />
              </Button>
            )}>
            <Seg value={value} options={options} label={label} onChange={pick} />
          </Row>
        );
      })}
    </>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, { sounds: _SRSND_Sounds });
