import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createDesktopAuth, ProfileSyncCoordinator } from "./auth";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Rootline mount point is missing.");

const auth = createDesktopAuth();
const syncCoordinator = new ProfileSyncCoordinator(auth);

createRoot(root).render(<StrictMode><App auth={auth} syncCoordinator={syncCoordinator} /></StrictMode>);
