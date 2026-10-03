import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./style.css";

const element = document.getElementById("root");
if (!element) throw new Error("Missing application root");
createRoot(element).render(<App />);
