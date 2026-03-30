import React from "react";
import ReactDOM from "react-dom/client";
import { RegionSelector } from "@/components/overlay/RegionSelector";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RegionSelector />
  </React.StrictMode>
);
