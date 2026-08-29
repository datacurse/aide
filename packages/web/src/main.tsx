import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { takeHeldReloads } from "./reload.js"
import "./index.css"

// Before the first render, so a reload the dev server held while a turn was
// answering is already waiting on somebody being here rather than lost.
takeHeldReloads()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
