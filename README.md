# SSH Dream

A Bitvise-style SSH client for Windows, built with **Tauri v2**, **React** and **Rust**. One window gives you a terminal, a full SFTP file manager and an RDP launcher for every saved server.

> **Status:** personal project, Windows only. Expect rough edges.

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/747a89cc-2004-4810-9aad-2de8832db4a3" alt="SSH Dream terminal tab" width="49%" />
  <img src="https://github.com/user-attachments/assets/306ba419-280d-444b-9e5c-c67c94b78cb7" alt="SSH Dream SFTP file manager with bookmarks" width="49%" />
</p>

## Features

**Profiles & security**
- Saved server profiles with a quick profile switcher; import / export.
- Password or public-key login (with optional key passphrase).
- Secrets live in the **Windows Credential Manager** (keyring), never in the profile file.
- Host key verification: unknown or changed keys raise a trust prompt, and trusted fingerprints are remembered.

**Terminal**
- xterm.js terminals over real SSH channels, several per profile, each in its own sub-tab.
- Scrollback and running programs survive tab and profile switching.
- Find in terminal (`Ctrl+Shift+F`), rename tabs, configurable font and size.

**SFTP file manager**
- Virtualized file list that stays fast with very large folders, sortable columns, folders always on top.
- Explorer-style selection: click, `Ctrl`/`Shift` click, **rubber-band (drag) selection**, `Ctrl+A`, type-to-find.
- **Drag files out** of the window into Windows Explorer; Explorer pulls the bytes straight from the server (virtual files, no temp copies, no size cap).
- **Drag files in** from Explorer to upload; drag rows onto a folder, breadcrumb or bookmark to move them.
- **Drag a folder onto the Bookmarks sidebar to pin it.**
- Double-click a file to open it in its default Windows app; every save is uploaded back automatically (with a conflict check if the server copy changed).
- Transfer queue with progress, cancel, and overwrite / skip conflict handling. Files are written as `.part` and renamed on success, so interrupted transfers never look complete.
- Bookmarks, breadcrumb path bar (`Ctrl+L` to type a path), back / forward (`Alt+Left/Right` or mouse side buttons), context menus, rename, delete, new folder (`Ctrl+Shift+N`).

**RDP**
- Launches Windows' built-in `mstsc.exe` for the same profile, with a temporary credential so the password never appears on a command line.

**Appearance**
- Follow Windows, Light, Dark, or Catppuccin Latte. The terminal palette matches.

## Keyboard shortcuts

| Where | Keys | Action |
|---|---|---|
| Terminal | `Ctrl+Shift+W` | Close terminal tab |
| Terminal | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous terminal tab |
| Terminal | `Ctrl+Shift+F` | Find in terminal |
| SFTP | `Enter` / `Backspace` | Open / go up |
| SFTP | `F2` / `Del` / `F5` | Rename / delete / refresh |
| SFTP | `Ctrl+Shift+N` | New folder |
| SFTP | `Ctrl+L` | Type a path |
| SFTP | `Alt+Left` / `Alt+Right` | Back / forward |

## Download

Grab the latest installer (`.exe` or `.msi`) from the [Releases](../../releases) page. The installers are not code-signed, so Windows SmartScreen may warn you: click **More info**, then **Run anyway**.

## Requirements

- Windows 10 or 11 (the credential store, drag-out to Explorer and RDP launcher are Windows-specific)
- [Node.js](https://nodejs.org/) 18 or newer
- [Rust](https://www.rust-lang.org/tools/install) (stable) with the MSVC toolchain
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) ("Desktop development with C++")
- [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (already present on current Windows 11)

See the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) if anything is missing.

## Getting started

```powershell
git clone <your-repo-url> ssh-dream
cd ssh-dream
npm install
npm run tauri dev
```

The first run compiles the Rust backend, which takes a few minutes.

### Build an installer

```powershell
npm run tauri build
```

The MSI and NSIS installers end up in `src-tauri/target/release/bundle/`.

### Other scripts

| Command | What it does |
|---|---|
| `npm run dev` | Frontend only (Vite, port 1420) |
| `npm run typecheck` | TypeScript check without emitting |
| `cargo test` (in `src-tauri/`) | Rust unit tests |

## Project layout

```
src/                  React + TypeScript frontend
  tabs/               Login, Terminal, SFTP, RDP, Options pages
  components/         Shared UI (dialogs, toasts, file table, context menu, ...)
  store/              Zustand stores (profiles, sessions, SFTP state, prefs, theme)
  api/                Typed wrappers around Tauri commands
src-tauri/            Rust backend
  src/ssh/            SSH sessions (russh), host keys, terminal channels
  src/sftp/           SFTP (russh-sftp), transfers, drag-out, open-in-app
  src/rdp.rs          mstsc launcher
  src/secrets.rs      Windows Credential Manager access
docs/                 Design notes for the trickier features
```

Design notes:
- [Drag-out to Explorer](docs/DRAG-OUT.md)
- [Open in default app](docs/OPEN-IN-APP.md)

## Built with

[Tauri 2](https://tauri.app/) · [React 18](https://react.dev/) · [Vite](https://vitejs.dev/) · [Zustand](https://zustand-demo.pmnd.rs/) · [xterm.js](https://xtermjs.org/) · [TanStack Table / Virtual](https://tanstack.com/) · [russh](https://github.com/Eugeny/russh) · [russh-sftp](https://github.com/AspectUnk/russh-sftp)

## License

No license has been chosen yet. Until one is added, all rights are reserved by the author.
