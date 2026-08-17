# Reviewed files

Session-only reviewed-file workflow for Hunk extension API v6 or newer.

## Behavior

- `v` marks or unmarks the selected file.
- `V` enters or exits file-by-file review mode.
- In file-by-file mode, the left pane keeps every file visible while the right review stream shows only the active file.
- Clicking a file in the left pane changes the focused file, including previously reviewed files.
- Marking the active file reviewed opens the next unreviewed file.
- Reviewing the final file automatically exits file-by-file mode and restores the full stream.
- Reviewed files stay in the files pane outside file-by-file mode.
- A reviewed file uses a minimal alternate presentation that hides its diff lines while preserving Hunk's file header.
- `[` and `]` skip reviewed files after the first reviewed-file toggle activates the extension's navigation mode.
- Reviewed paths reconcile across ordinary reloads and renames for the lifetime of the process.

## Extension API limitation

Hunk does not expose its host-owned file-header component to extensions. This extension therefore cannot add the requested clickable toggle inside the right-side header. The reviewed marker lives in the replacement files pane, and `v` is the toggle.

The alternate file-view contract requires one host row per parsed hunk. Those rows are intentionally blank, so the diff content is hidden but the body is not literally zero rows for textual files. Visible or draft notes can also make Hunk temporarily choose its raw-diff fallback when it cannot place them safely.

File-by-file mode uses a changeset transform plus Hunk's public refresh command. It is available only for review inputs Hunk can reload.
