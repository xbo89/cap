import React from "react";
import ReactDOM from "react-dom/client";
import { FloatingToolbar } from "@/components/recording/FloatingToolbar";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FloatingToolbar />
  </React.StrictMode>
);
