# TurboScratch IDE

A Scratch mod that combines **TurboWarp's** fast compiler, addons and advanced
settings with **real-time collaboration**: several people can edit the same
project at the same time, like in Gandi IDE.

![logo](branding/turboscratch-icon.svg)

## Online

- Website: **https://turboscratch-ide.github.io**
- Editor: **https://turboscratch-ide.github.io/Turboscratch_IDE/editor.html**

The editor is rebuilt and published automatically by GitHub Actions
(`.github/workflows/deploy-pages.yml`) every time `main` is pushed.

GitHub Pages only hosts the editor's web pages; it can't run the collaboration
server. Because the website uses https, browsers only let it connect to a
**secure `wss://` server**. It can't reach a server on your own computer
(`ws://localhost` is blocked). So:

- To collaborate on the same Wi-Fi without hosting anything, use the local editor
  (`start-turboscratch.command`, below).
- To collaborate and use accounts on the website, run the server online. The
  easiest free setup is [Render](https://render.com) plus a free
  [Neon](https://neon.tech) PostgreSQL database: open
  `https://render.com/deploy?repo=https://github.com/TurboScratch-IDE/Turboscratch_IDE`,
  paste the Neon connection string as `DATABASE_URL`, and deploy (see `render.yaml`).
  Then set a repository variable
  `TSC_COLLAB_SERVER` (Settings → Secrets and variables → Actions → Variables) to that
  `wss://` address so the website uses it by default. You can set
  `ALLOWED_ORIGINS=https://turboscratch-ide.github.io` on the server to only accept
  connections from the website.

## Start it on your computer

Double-click **`start-turboscratch.command`** (or run it in Terminal). It
starts two things:

| What | Address |
| --- | --- |
| The editor | http://localhost:8601/editor.html |
| The collaboration server | ws://localhost:8090 |

The first start builds the editor, which takes 1–3 minutes. Press `Ctrl+C` in
the window to stop.

## Work together

1. Click **Collaborate** in the menu bar.
2. Type your name and a room code (or click **New code**), then **Join room**.
   - **New room:** your current project becomes the shared project.
   - **Existing room:** your editor switches to the room's project, so save
     your own work first.
3. Click **Copy invite link** and send it to your friends.

Friends on the same Wi-Fi must open the editor using your computer's network
address (the launcher prints it, for example `http://192.168.1.20:8601/editor.html`),
not `localhost`. To work together over the internet, the collaboration server
needs to run somewhere everyone can reach (a VPS or a hosting service with
WebSocket support). Then enter its `wss://` address under **Server** in the
Collaborate dialog.

## Accounts, posting, friends and studios

Click **Sign in** (top right) to create an account with a **nickname and a
password**. With an account you can:

- **Post** your project so everyone on the server can find and open it
  (**Explore**), and later save new versions of it.
- **Add friends** by nickname; they accept or decline your request.
- **Make studios**: shared collections of projects. The owner invites people by
  nickname, members add their projects, and the owner can remove members.

Passwords are never stored: the server keeps only a salted scrypt hash. Sign-in
attempts are rate-limited. There's no email, so a forgotten password can't be
reset yet, and there are no moderation or report tools yet. Keep that in mind
before inviting people you don't know.

Accounts live on the TurboScratch server. On your computer they're stored in
`collab-server/data/community.sqlite`. Online they need a PostgreSQL database
(`DATABASE_URL`), because free hosting forgets files when it sleeps.

### What syncs live

- Blocks: adding, moving, deleting, editing numbers/text/dropdowns, custom blocks
- Variables and lists (local and global), comments
- Sprites: add, upload, duplicate, delete (and restore), rename, reorder,
  position/size/direction/visibility
- Costumes and backdrops: add, upload, paint-editor changes, rename, delete,
  duplicate, reorder
- Sounds: add, record/upload, sound-editor changes, rename, delete, duplicate, reorder
- Blocks dragged onto another sprite, extensions, TurboWarp's advanced settings
  (FPS, interpolation, limits, stage size)
- Loading a different project (File → Load / New) replaces the project for everyone
- Presence (who is editing which sprite) and a room chat

Rooms are saved in `collab-server/data/` so they survive a server restart.

### Known limitations

- If two people change the *same* thing at the same moment, the last change wins.
- An open paint or sound editor doesn't redraw when someone else edits that same
  costume/sound; you'll see a notice. Click another costume or sound and back to
  see their change.
- Not synced: monitors (variable displays on the stage), which costume is
  selected, sprite layer order, the project title, turbo mode.
- Anyone who knows a room code can join it. Only share codes with people you trust.
- The "Sprite folders" addon is off by default because it renames and reorders
  things differently on each person's screen, which breaks syncing.
- When something looks out of sync, click **Resync project** in the Collaborate
  dialog to reload the room's copy.

## Folders

| Folder | What's inside |
| --- | --- |
| `editor/` | The editor: TurboWarp's `scratch-gui` plus TurboScratch changes |
| `editor/src/lib/tsc-collab/` | Collaboration engine (session, VM sync, ID-preserving project export) |
| `editor/src/components/tsc-collab/` | Collaborate dialog and menu-bar button |
| `editor/src/lib/themes/accent/turbo.js` | The TurboScratch color theme (default) |
| `collab-server/` | The collaboration server (`npm start`, tests with `npm test`) |
| `branding/` | Logo and app icons |

## Updating from TurboWarp

`editor/` started from TurboWarp/scratch-gui commit
`757231893bb887d9c20379be8937fe97784b3392`. To pull in newer TurboWarp changes,
compare against that commit.

## License and credits

TurboScratch IDE is based on [TurboWarp](https://turbowarp.org/) by Thomas Weber
and contributors, which is based on [Scratch](https://scratch.mit.edu/) by the
Scratch Foundation and MIT. TurboWarp's changes are licensed under GPL-3.0, so
TurboScratch IDE is GPL-3.0 too: if you share it, share the source code as well.
Scratch is a project of the Scratch Foundation; TurboScratch IDE is not affiliated
with or endorsed by the Scratch Foundation or TurboWarp.
