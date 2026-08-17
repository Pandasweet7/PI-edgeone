// Generated from pi-web-plugins/workspace-tasks/taskRunner.ts. Do not edit directly.
export function runWorkspaceTaskInTerminal(terminal, task) {
    return terminal.runCommand({
        title: task.title,
        command: task.command,
        open: true,
        metadata: {
            "pi.plugin": "workspace-tasks",
            "task.id": task.id,
        },
    });
}
