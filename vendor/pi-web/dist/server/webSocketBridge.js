import { WebSocket } from "ws";
export function bridgeSockets(client, upstream) {
    const sendToClient = createBufferedSender(client);
    const sendToUpstream = createBufferedSender(upstream);
    client.on("message", (data) => { sendToUpstream(data); });
    upstream.on("message", (data) => { sendToClient(data); });
    client.on("close", () => { upstream.close(); });
    upstream.on("close", () => { client.close(); });
    upstream.on("error", () => { client.close(); });
    client.on("error", () => { upstream.close(); });
}
export function createBufferedSender(socket) {
    const queue = [];
    const flush = () => {
        while (socket.readyState === WebSocket.OPEN) {
            const data = queue.shift();
            if (data === undefined)
                return;
            socket.send(data);
        }
    };
    socket.on("open", flush);
    return (data) => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(data);
            return;
        }
        if (socket.readyState === WebSocket.CONNECTING)
            queue.push(data);
    };
}
//# sourceMappingURL=webSocketBridge.js.map