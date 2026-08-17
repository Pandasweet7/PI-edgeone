// Generated from pi-web-plugins/git/browser/pi-web-plugin.ts. Do not edit directly.
import { createGitBrowserContributions } from "./git-panel.js";
const plugin = {
    apiVersion: 2,
    name: "Git",
    activate: ({ pluginId, runtimePluginId, html, svg }) => ({
        contributions: createGitBrowserContributions(pluginId, runtimePluginId, html, svg),
    }),
};
export default plugin;
