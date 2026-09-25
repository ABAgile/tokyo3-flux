# Attachments

- Cards show attachments in a compact Asana-like collapsed file dropdown at the bottom of the card, separated by a divider and using a fixed-size open/close cue with a paperclip/count cue; opening it reveals a vertical quick-download list with single-line file-type marks, truncated names and sizes, saving card space without page-level scroll; file-type marks expose the MIME type in the tile hover/focus description.
  The dropdown and editor action menus close when clicking elsewhere.
  The item editor uses the same compact file tiles and an Asana-like Add attachment action that opens the file picker and uploads the selected file; files can also be dropped onto the section.
  Editor tiles expose removal from an overflow action menu, and cancelling the picker leaves the card open.
  Uploads show a determinate progress bar beside Add attachment and a percentage in the section status; an indeterminate bar is used when the browser cannot measure the request.
  Files may also be dropped directly onto a Kanban card or List row, which uploads to that card without opening the editor and reports progress through the shared status line.
  Only transfers carrying files are intercepted, so planning drags are unaffected, and archived cards reject file drops.
  Members and admins can upload or remove files from active cards; viewers can download them.
  The attachment section appears before comments.
