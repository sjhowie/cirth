//! Opens files and folders dropped on the window.
//!
//! Tauri's own drop handler is off (`dragDropEnabled: false`) because on Windows it also swallows text drops.
//! Without it the page sees dropped files only as browser `File` objects, which carry no path. WebView2's
//! documented way to get the path is for the page to post the files back with
//! `chrome.webview.postMessageWithAdditionalObjects` (src/main.ts); this handler reads each file's path from the
//! message and sends the paths through `app://open-paths`, like a second launch from Explorer.
//!
//! The message has to be a string: wry's IPC handler, registered first, fails on anything else, and WebView2 then
//! stops calling later handlers (measured: object messages never arrived here). Every string also goes to Tauri's
//! IPC, so the page sends a well-formed IPC message with an empty invoke key: Tauri rejects the key and drops the
//! message with a line on stderr, where any other string would log a console error in the page.

#[cfg(windows)]
pub fn open_dropped_files(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let target = window.clone();
    window.with_webview(move |wv| {
        // SAFETY: called on the UI thread with the window's live controller, as WebView2 requires.
        if let Err(e) = unsafe { win::listen(&wv.controller(), target) } {
            log::error!("drop: cannot listen for dropped files: {e}");
        }
    })
}

#[cfg(not(windows))]
pub fn open_dropped_files(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

/// The `cmd` of the page's "files were dropped" message (src/main.ts). No such command is registered.
#[cfg_attr(not(windows), allow(dead_code))]
const DROP_CMD: &str = "cirth:open-dropped";

/// Whether a web message is the page's "files were dropped" message.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_drop_message(message: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(message).is_ok_and(|v| v.get("cmd").and_then(|c| c.as_str()) == Some(DROP_CMD))
}

#[cfg(windows)]
mod win {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2File, ICoreWebView2ObjectCollectionView, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows_core::{Interface, PWSTR};

    pub unsafe fn listen(controller: &ICoreWebView2Controller, window: tauri::WebviewWindow) -> windows_core::Result<()> {
        unsafe {
            let core = controller.CoreWebView2()?;
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut message = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut message).is_err() || !super::is_drop_message(&take_pwstr(message)) {
                    return Ok(());
                }
                match paths(&args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?.AdditionalObjects()?) {
                    Ok(paths) => crate::send_open_paths(&window, paths),
                    Err(e) => log::error!("drop: cannot read the dropped files' paths: {e}"),
                }
                Ok(())
            }));
            let mut token = 0i64;
            core.add_WebMessageReceived(&handler, &mut token)
        }
    }

    unsafe fn paths(objects: &ICoreWebView2ObjectCollectionView) -> windows_core::Result<Vec<String>> {
        unsafe {
            let mut count = 0u32;
            objects.Count(&mut count)?;
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let Ok(file) = objects.GetValueAtIndex(i)?.cast::<ICoreWebView2File>() else { continue };
                let mut path = PWSTR::null();
                file.Path(&mut path)?;
                out.push(take_pwstr(path));
            }
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_drop_message;

    #[test]
    fn recognises_only_the_drop_message() {
        assert!(is_drop_message(r#"{"cmd":"cirth:open-dropped","callback":0,"error":0,"payload":null,"__TAURI_INVOKE_KEY__":""}"#));
        assert!(!is_drop_message(r#""cirth:open-dropped""#));
        assert!(!is_drop_message(r#"{"cmd":"read_file"}"#));
        assert!(!is_drop_message("not json"));
    }
}
