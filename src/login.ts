import { showForLogin } from "./chrome.js";

// Opens the dedicated Chrome window, visibly, so the user can sign in by hand. This program never types credentials.
await showForLogin();
console.log("The Flow Chrome window is open.");
console.log("1. Sign in to Google there yourself.");
console.log("2. Leave that window open (Claude opens or creates the project with flow_project).");
console.log("You can close this terminal.");
process.exit(0);
