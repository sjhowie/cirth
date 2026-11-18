import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("index.html has no #app element");

// Tauri's native drag-drop is off (tauri.conf.json, dragDropEnabled) because on Windows it swallows every drop,
// text included. The WebView then handles drops itself, and a file dropped anywhere would navigate the page
// to that file, losing unsaved work.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

export default mount(App, { target });
