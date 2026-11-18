import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("index.html has no #app element");

// Tauri's native drag-drop is off (tauri.conf.json, dragDropEnabled) because on Windows it swallows every drop,
// text included. The WebView then handles drops itself: a file dropped anywhere would navigate the page to that
// file, losing unsaved work, so file drops are cancelled here. Their paths aren't visible to the page; WebView2
// hands them to Rust when the files are posted back (src-tauri/src/file_drop.rs), which opens them.
interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: FileList): void;
}
const webview = (window as Window & { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
// A string shaped like a Tauri IPC message with an empty invoke key, so Tauri drops it quietly (file_drop.rs says why).
const DROP_MESSAGE = JSON.stringify({ cmd: "cirth:open-dropped", callback: 0, error: 0, payload: null, __TAURI_INVOKE_KEY__: "" });
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  e.preventDefault();
  if (webview) webview.postMessageWithAdditionalObjects(DROP_MESSAGE, files);
  else console.warn("Opening dropped files is only supported on Windows (WebView2)");
});

export default mount(App, { target });
