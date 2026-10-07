# PilotSwarm TUI — Keybinding Reference

This document matches the current terminal UI behavior in [`run.sh`](../../run.sh) and [`packages/app/tui/src/app.js`](../../packages/app/tui/src/app.js).

## Global Navigation

These keys work whenever focus is not in the prompt editor.

| Key | Action |
|-----|--------|
| `q` | Quit |
| `Ctrl+C` | Quit immediately |
| `Esc` | Return focus to Sessions |
| `Tab` / `Shift+Tab` | Cycle focus between panes |
| `h` / `l` | Move focus left / right |
| `p` | Focus the prompt editor |
| `n` | Create a generic session immediately when generic sessions are allowed; otherwise open the model-first creation flow when models are available, or the agent picker |
| `Shift+N` | Pick model/reasoning first, then choose generic or a named agent |
| `r` | Refresh sessions and visible data |
| `a` | Open the linked-item picker for current chat artifacts and visible URLs |
| `Shift+A` | Open or close the Admin Console (model providers, defaults, agent packages, and workers) |
| `m` | Cycle inspector tab (`sequence` → `logs` → `nodes` → `history` → `files` → `stats`) |
| `[` / `]` | Resize the main split |
| `c` | Cancel the selected session |
| `d` | Mark the selected session done |
| `Shift+D` | Delete the selected session |

## Sessions Pane

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down |
| `k` / `↑` | Move selection up |
| `Ctrl+D` / `PageDown` | Page down |
| `Ctrl+U` / `PageUp` | Page up |
| `Ctrl+G` | Place the selected top-level non-system session(s) in one of your private groups; the picker includes `[New Group]` and `[No Group]`. Any readable session can be placed; placement is visible only to you |
| `f` | Open the session owner filter (includes the "Shared with me" bucket) |
| `+` / `=` | Expand the selected parent session |
| `-` | Collapse the selected session |
| `t` | Rename the selected session |
| `P` | Pin or unpin the selected top-level session (system and child sessions cannot be pinned) |
| `v` | Cycle the selected owned session tree through `private` → `shared_read` → `shared_write` |
| `Shift+S` | Open targeted user sharing for the selected owned session tree |
| `V` | Toggle multi-select mode (seeds the selection with the active session) |
| `Space` | (in multi-select mode) Toggle selection on the active row |
| `c` | (in multi-select mode) Cancel every selected session in one confirmation; system sessions are skipped |
| `Esc` | (in multi-select mode) Exit multi-select and clear the selection |

## Chat, Activity, Sequence, Logs, and Node Map

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `Ctrl+D` / `PageDown` | Page down |
| `Ctrl+U` / `PageUp` | Page up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `s` | Toggle chat transcript / session summary (chat pane only) |
| `e` | Expand older chat history (chat pane only) |
| mouse wheel | Scroll the focused pane |
| drag with mouse | Select text and copy it to the clipboard |

### Logs-only

| Key | Action |
|-----|--------|
| `t` | Toggle tail mode |
| `f` | Open the log-filter dialog |

## Stats Inspector

| Key | Action |
|-----|--------|
| `f` | Cycle between `session`, `fleet`, and `users` stats views |

## Files Inspector

### File list

| Key | Action |
|-----|--------|
| `j` / `k` | Move file selection |
| `f` | Open the files-filter dialog (`Selected session` vs `All sessions`) |
| `x` | Delete the selected artifact (with confirmation) |
| `v` | Toggle fullscreen files mode |
| `o` | Open the selected file in the OS default app |

### Preview

| Key | Action |
|-----|--------|
| `j` / `k` | Scroll preview |
| `Ctrl+D` / `Ctrl+U` | Page preview down / up |
| `g` / `G` | Jump to preview top / bottom |
| `x` | Delete the selected artifact (with confirmation) |
| `v` | Toggle fullscreen files mode |
| `Esc` | Exit fullscreen files mode |
| `o` | Open the selected file in the OS default app |

## Prompt Editor

| Key | Action |
|-----|--------|
| `Enter` | Send the current message, or queue it behind pending prompts for busy/system sessions |
| `Option+Enter` / `Alt+Enter` | Insert a newline |
| `Ctrl+J` | Insert a newline |
| `Ctrl+A` | Attach a local file to the draft |
| `Tab` | Accept reference autocomplete; otherwise focus the Send/Steer/Stop action row when steering is available |
| Action row: `Left` / `Right`, `Enter` | Select and activate Send, Steer, Stop, or Guidance (when receipts exist) |
| Action row: `Shift+Tab` / `Esc` | Return to the prompt without submitting |
| Action row: `Tab` | Continue normal next-pane traversal |
| `Esc` | Leave prompt mode and return to Sessions, or cancel the selected queued pending prompt |
| `←` / `→` | Move cursor by character |
| `↑` / `↓` | On the first/last draft line, recall the outbox first, then your own current-session input history; elsewhere move the caret normally |
| `Option+←` / `Option+→` | Move cursor by word |
| `Backspace` / `Delete` | Delete one character |
| `Option+Backspace` / `Option+Delete` | Delete the previous word |

Notes:

- Steering is explicit and text-only. Enter still sends or queues ordinary
  input; it never silently changes to steering. The portal also offers
  `Ctrl+S` only while its textarea has focus. The native terminal uses its
  focusable action row; the terminal `Ctrl+S` chord is not enabled until its
  raw-mode host compatibility gate is satisfied.
- Guidance receipts distinguish acceptance, waiting for a safe point,
  delivery, retention, Stop, and uncertainty. Delivery does not mean compliance.
  A missed steer does not automatically run next turn.
- In Guidance receipts, Up/Down selects a request and PageUp/PageDown scrolls
  its text. Enter refreshes or reconciles acceptance; `w` withdraws,
  `r` sends as a new message and `c` reuses undelivered/withdrawn/uncertain
  guidance in an empty draft or appends it on a new line. Delivered receipts
  have no draft action; text remains selectable.
  Escape closes the receipt view. The server decides which mutations are allowed.
  `m` loads the next receipt page when a partial-list notice is present.
- The prompt grows to a three-line viewport and then scrolls as you keep adding lines.
- Attached files are uploaded immediately and inserted into the outgoing prompt as `artifact://...` references when the message is sent.
- Every send first lands in a per-session local outbox, then transitions through three durability states shown next to each user message in chat:
  - `○` pending — client-only, not yet acknowledged by the runtime
  - `✓` queued — durably enqueued to the orchestration, waiting to be processed
  - `✓✓` sent — persisted as a `user.message` in the durable transcript; the LLM has it
- Multiple synchronous sends coalesce into a single durable enqueue. Pressing `Enter` on an empty draft forces an immediate dispatch of any still-pending items.
- Up on the first line (or an empty draft) visits pending and queued outbox
  inputs first, newest to oldest, with their existing edit/read-only and cancel
  controls. Beyond the oldest queue item, it recalls up to ten executed inputs.
  Down on the last line walks back through history, then the outbox, and finally
  restores the unsaved draft and attachments. The same queued message is not
  repeated in executed history. Other people's inputs, assistant output and system messages
  are excluded; delivered steering counts as your input. Consecutive duplicates
  are skipped. A newly accepted send is available immediately.
- Editing a recalled entry ends navigation; the next Up starts from newest and
  Down no longer restores the old draft. Sending or switching sessions resets
  navigation. Menus and reference autocomplete retain priority. Tablet hardware
  arrows work in the touch layout too; phone typing and touch-keyboard behavior
  are unchanged.
- When an outbox item is selected, its existing controls still apply;
  Escape cancels that item before it becomes durable.
- Partial input history exposes **More history** in the native prompt action
  row and **Load more input history** in the portal. Each explicit load is
  bounded; it continues the saved cursor without changing viewer filtering.

## Modals and Dialogs

| Context | Keys |
|---------|------|
| model picker | `j/k`, arrows, `Enter`, `Esc` |
| session agent picker | `j/k`, arrows, `Enter`, `Esc` |
| session owner filter | `j/k`, arrows, `Space`, `Esc` |
| linked-item picker | `j/k`, arrows, `Enter`, `Esc`, `a` |
| log/files filters | `Tab` / `Shift+Tab`, `j/k`, arrows, `Enter`, `Esc` |
| rename dialog | type text, `←/→`, `Home`, `End`, `Backspace`, `Enter`, `Esc` |
| attach-file dialog | type path, `←/→`, `Home`, `End`, `Backspace`, `Enter`, `Esc` |

## Admin Console (`Shift+A`)

The Admin Console takes over the workspace until you press `Esc` to close it. While the console is visible the normal workspace shortcuts are suppressed.

| Key | Action |
|-----|--------|
| `m` | Show My Providers |
| `M` | Show Shared Providers (administrators only) |
| `a` | Show Agent Packages |
| `w` | Show Workers (administrators only) |
| `e` | Add a personal provider |
| `U` | Update the selected personal provider's credential (input is masked) |
| `E` | Add a shared model provider (administrators only) |
| `d` | Confirm-delete the selected personal or shared provider |
| `u` | Cycle My Session Default through usable choices and automatic fallback |
| `l` | Cycle Cluster Session Default through shared providers (administrators only) |
| `s` | Cycle System Session Default for future starts (administrators only) |
| `C` / `T` / `H` | Apply the next system default and Complete / Terminate / Hard Delete & Restart inheriting system sessions |
| `Tab` | On Shared Providers, switch between providers and system-agent overrides |
| `j` / `k` | Move the selected personal provider or system agent |
| `t` | Toggle system-session use for the selected admin-owned personal provider |
| `o` | Cycle the selected system-agent override; automatic clears it to inherit |
| `r` | Refresh providers and defaults (or the active Agents/Workers section) |
| `Esc` | Close the console and return to the workspace |

While the provider-creation wizard is open the console behaves like a modal:

| Key | Action |
|-----|--------|
| type text, `←/→`, `Home`, `End`, `Backspace` | Edit the provider name, then the credential (credential input is masked) |
| `Tab` (name step) | Cycle the catalog's provider types; personal creation starts on GitHub Copilot |
| `Enter` | Continue from name to credential, then create the provider; in update mode, replace the credential |
| `Esc` | Cancel and clear the draft |

Personal-provider system use permits PilotSwarm's system machinery to use that
credential. It never exposes the provider to another user and is not a cluster
use grant. Per-agent override changes use a durable model switch; restart the
system session separately when a fresh session is required.
