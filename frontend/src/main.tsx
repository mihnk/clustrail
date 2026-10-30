import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./app/App";
import { detectBackend } from "./backend/client";
import { setMockMode } from "./data/mock";

// Decide once, before the first render, whether real clusters or mock data back the UI.
void detectBackend().then((desktop) => {
  setMockMode(!desktop);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
