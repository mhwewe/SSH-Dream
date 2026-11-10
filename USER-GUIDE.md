# SSH Clone — User Guide

## Add a profile
1. Click the profile name at the top (▾) → **New profile**.
2. **Login** tab: enter Host, Port (22), Username. Choose **password** or **public key** (then pick the private key file).
3. Optionally tick **Log in automatically when the app starts** (works best together with a stored password; otherwise the app asks for it at launch).
   Tick **Store encrypted password in profile** if you want the app to remember the password (or key passphrase).
   It is stored in Windows Credential Manager, never in the profile file.
4. **Save profile** (left bar). Use **Save profile as** / the menu's *Duplicate…* to make copies.

You can keep several profiles logged in at once and switch between them from the top bar; switching never disconnects.

## Log in
Press **Log in**. The first time you connect to a server you are shown its host key fingerprint — accept it only if it
matches what you expect. If the key later **changes** you get a red warning: do not continue unless you know why.
If no password is stored you will be asked for it.

## Automatic start
The profile you used last always logs in when the app opens; other profiles do so when **Also connect this profile on start** is ticked. Then the
SFTP pane and a first terminal open by themselves. Profiles are handled one after another; if a password is not stored you are asked for it.

## Tabs
* **Terminal** — **+** opens another terminal on the same connection. Select text to copy; right-click or Ctrl+Shift+V pastes.
* **SFTP** — one pane showing the server's files.
  * Double-click a folder (or Enter) to open it, Backspace = up, F5 = refresh, F2 = rename, Delete = delete.
  * **◀ Back / ▶ Forward** (toolbar, Alt+Left / Alt+Right, or the mouse side buttons) walk through the folders you visited.
  * The app **remembers the last folder** of each profile and opens it again the next time you log in, even after a restart.
  * **New folder** (button or Ctrl+Shift+N) creates the folder at once and lets you type its name in place; F2 / **Rename** edits a name the same way (Enter saves, Esc cancels).
  * Back / Forward act the moment you press the button (or mouse side button).
  * **Bookmarks**: click ☆ next to the path to bookmark the current folder (★ = already bookmarked; click again to remove).
    The **Bookmarks panel** on the left lists them: click to jump, ✎ renames, × removes. The toolbar's **★ Bookmarks** button shows/hides the panel.
  * **Upload files… / Upload folder…** pick local items; you can also **drag files from Windows Explorer** onto the file list.
  * **Drop onto a folder**: drop Explorer files on a folder row to upload *into* that folder (the row highlights); anywhere else in the list uploads to the current folder.
  * **Move on the server**: drag selected rows onto a folder row, the **⬆ Up** button (parent folder) or a bookmark. Esc cancels the drag.
  * Select rows and press **Download**, then choose the destination folder. Folders are transferred recursively.
  * The **Transfers** panel shows progress and speed; **Cancel** stops a transfer and removes its partial file.
  * If a file already exists you can **Skip**, **Keep both (rename)** or **Overwrite** (optionally for all).
* **RDP** — **Connect** starts Windows' Remote Desktop (`mstsc.exe`). Empty host/user reuse the SSH values.
  * **Smart resize** (on by default): resize the Remote Desktop window (drag an edge, maximize) and the remote desktop
    changes to the new size. Needs Windows 8.1 / Server 2012 R2 or newer on the remote side.
  * **Resolution**: the size the session starts with, e.g. `1920x1080` (pick from the list or type `WIDTHxHEIGHT`, 200-8192).
    Empty = Windows' default. With Smart resize on you can still resize the window afterwards.

## Where data is stored
* Profiles: `%APPDATA%\<app identifier>\profiles\<id>.json` (default identifier `com.sshclone.app`), plus `known_hosts.json`
  and `ui_state.json` in the same folder. Profile files contain **no passwords**.
* SFTP last folder and bookmarks: `sftp_prefs.json` in the same folder (plain folder paths, no secrets).
* Passwords/passphrases: Windows Credential Manager (Control Panel → Credential Manager → Windows Credentials).

## Uninstall and remove saved credentials
1. Windows Settings → Apps → *SSH Clone* → Uninstall.
2. Optionally delete the data folder above.
3. Credential Manager → Windows Credentials: remove the entries whose name ends with `.ssh-clone`
   (one per stored password, named after the profile id and kind: `ssh`, `rdp`, `key_passphrase`).

## Notes
The installer is **not code-signed**, so Windows SmartScreen may warn on first run ("More info" → "Run anyway").

## Layout notes
* Log in / Log out is the top button of the left bar (no Exit button: close the window).
* Drag the right edge of the Bookmarks panel, or the top edge of the Log pane, to resize them; sizes are remembered.
* Tab order: Login, Terminal, SFTP, Options, RDP.
