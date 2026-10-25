import React from "react";
import ReactDOM from "react-dom/client";
import { PwaUpdateBanner, startPwa } from "./pwa";
import { ThemeBridge } from "../components/builder/theme";

/**
 * Second entry module in index.html, independent of App.tsx: registers the service worker,
 * applies the saved theme to the whole document (public site and console) and shows the
 * "new version" banner in its own small React root.
 */
startPwa();

const host = document.createElement("div");
host.id = "np-global-chrome";
document.body.appendChild(host);
ReactDOM.createRoot(host).render(
  <React.StrictMode>
    <ThemeBridge />
    <PwaUpdateBanner />
  </React.StrictMode>
);
