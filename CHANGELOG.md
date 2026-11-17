# Changelog
What changed in each Cirth release, newest first.

## 0.3.1 - 2026-11-17
### Fixed
- Fixed Format XML slowing to a crawl on a tag with tens of thousands of attributes.

## 0.3.0 - 2026-11-17
### New
- Added Help > About Cirth, with the version, build and a link to the source code.
- Added Help > What's New, which also opens once after Cirth updates to a new version.
### Improved
- Stopped publishing the MSI installer; the per-user installer updates itself.
### Fixed
- Fixed closing the window a second time while the "Unsaved changes" prompt was open, which closed Cirth without saving.
- Fixed pressing `Ctrl+W` twice on an edited tab and choosing Save in both prompts, which wrote the original text back over your changes.
- Fixed files with bytes that aren't valid in their encoding being saved with replacement characters; Cirth now warns when such a file opens, asks before saving it, and Replace in Folder skips it.
- Fixed saving dropping a file's hard links, permissions, hidden attribute and attached data such as the downloaded-from-internet mark; saving now keeps them, and works while another program has the file open.
- Fixed Replace in Folder with a pattern such as `\s+$` joining lines; replacements now match line by line, exactly like the search preview.
- Fixed Help > Check for Updates finding an update without offering to install it.
- Fixed edits made while an update downloaded being lost; Cirth now downloads first and asks about unsaved files right before installing.
- Fixed two quick saves of a large file sometimes leaving the older version on disk.
- Fixed one invalid value in `settings.json` resetting every setting.
- Fixed renaming a file to change only its letter case failing with "already exists".
- Fixed AltGr characters such as ś and µ running Save All or Minify instead of typing.
- Fixed pressing Enter on an item in the status-bar pickers choosing the first item.
- Fixed Markdown previews loading remote images; previews now load only local images.
- Fixed "Open with Cirth" on the background of a drive root opening the wrong path.
- Fixed files with classic Mac (CR) line endings being saved with LF; CR is now kept and selectable in the status bar.
- Fixed Go to Line showing the wrong shortcut; it is `Ctrl+Alt+G`.
- Fixed new names with characters Windows doesn't allow, such as `:`, not being refused.
- Fixed renaming an expanded folder collapsing it.
- Fixed Quick Open after switching folders quickly.
- Fixed the right-click menu opening partly off screen.
- Fixed Whole Word missing terms that start or end with punctuation.
- Fixed searches inside very large files not being cancellable.
- Fixed stale folder-search results jumping to the wrong line.
- Fixed the XML formatter accepting malformed or duplicate attributes; it now reports them.
- Fixed light mode hiding invisible control characters; it now shows them.
- Fixed Enter while choosing an IME candidate picking a palette item.

## 0.2.1 - 2026-11-17
### Improved
- Changed the release process to push the release tag on its own, so releases are published more reliably.

## 0.2.0 - 2026-11-17
### New
- Renamed the app to Cirth (formerly SimpleEditor); your settings and recent files carry over.
- Added updates from GitHub Releases: the status bar shows "Update to X.Y.Z" when one is out, and Help > Check for Updates checks now.
- Added the version number to Settings.
- Added tabs and a folder sidebar where you can create, rename and delete files, with changes on disk picked up automatically.
- Added syntax highlighting for about 100 languages.
- Added Format and Minify for JSON and XML, with errors shown at their line and column.
- Added a live Markdown preview, on its own or side by side with synced scrolling.
- Added a command palette (`Ctrl+Shift+P`), Quick Open (`Ctrl+P`) and Go to Line.
- Added Find and Replace across a folder (`Ctrl+Shift+F`).
- Added box selection with `Alt`+drag and `Shift+Alt`+arrow keys.
- Added detection of encodings and line endings, which are kept on save and switchable from the status bar.
- Added editing of files of 100 MB and more, with a light mode from 10 MB that turns off highlighting, folding and wrapping.
- Added light, dark and system themes.
- Added "Open with Cirth" to the Windows Explorer menu for files, folders and folder backgrounds.
- Added indenting and outdenting selected lines with `Tab` and `Shift+Tab`.
- Added renaming a sidebar item with `Alt`+click.
- Added Copy Full Path to the sidebar's right-click menu.
### Fixed
- Fixed a white flash when Cirth opens in the dark theme.
