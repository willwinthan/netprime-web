import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { startPreviewBridge } from "./site/preview";

// Inside the website builder's preview iframe only (site/preview.ts).
startPreviewBridge();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
