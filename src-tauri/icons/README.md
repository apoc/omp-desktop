# OMP Desktop — Application Icon

Drop the contents of `app-icons/` into your Tauri project at `src-tauri/icons/`.

## ⚠️ Manual rename after copy

This sandbox can't write `@` in filenames. **Rename one file** after extracting:

```
256x256.png  →  128x128@2x.png
```

(Tauri specifically looks for that `@2x` filename.)

## Required Tauri files (already provided)

| File              | Size       | Purpose                          |
|-------------------|------------|----------------------------------|
| `32x32.png`       | 32×32      | Tauri default                    |
| `128x128.png`     | 128×128    | Tauri default                    |
| `128x128@2x.png`* | 256×256    | Tauri @2x — **rename from `256x256.png`** |
| `icon.png`        | 1024×1024  | Source for icns/ico generation   |

## To generate icns + ico (macOS + Windows binaries)

The fastest path is Tauri's CLI:

```bash
npx @tauri-apps/cli icon ./app-icons/icon.png
```

That command takes the 1024 source and produces:
- `icon.icns` (macOS app bundle)
- `icon.ico` (Windows installer)
- All Square*Logo.png Windows Store sizes
- The PNG ladder

It writes everything into `src-tauri/icons/` automatically. Use the `icon.png` from this pack as the input.

## tauri.conf.json snippet

```json
{
  "tauri": {
    "bundle": {
      "icon": [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico"
      ]
    }
  }
}
```

## Design notes

- **Squircle** (Apple superellipse) — matches macOS Big Sur+ icon language
- **Deep blue-black gradient** with a **warm orange glow** climbing from the bottom-right — echoes the app's accent
- **Mark:** thick rounded chevron `>` — terminal/agent prompt visual
- **Signature dot** — orange accent dot above-right of the chevron, a "cursor blink" / status pip. Same dot motif as the in-app icon pack.
- **Faint scan-grid** texture — readable as technical only at large sizes, invisible at 16px
- **Inner border + top highlight** — Apple-style depth without being skeuomorphic

The mark is tuned to hold up at 16×16 (favicon, taskbar, alt-tab) — chevron + dot read clearly.
