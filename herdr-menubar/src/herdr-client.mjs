// herdr JSON Lines API over unix socket 的极简客户端(协议见 herdr docs/next/api)
import net from "node:net";

export function defaultSocketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  return `${process.env.HOME}/.config/herdr/herdr.sock`;
}

export class HerdrClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
  }

  /** 单次请求:发一行 JSON,读一行响应。每次请求独立连接(服务端应答后关闭)。 */
  request(id, method, params, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buf = "";
      const done = (fn, v) => {
        sock.destroy();
        fn(v);
      };
      sock.setTimeout(timeoutMs, () =>
        done(reject, new Error(`timeout: ${method}`)),
      );
      sock.on("connect", () =>
        sock.write(`${JSON.stringify({ id, method, params })}\n`),
      );
      sock.on("data", (c) => {
        buf += c.toString();
        if (!buf.includes("\n")) return;
        const line = buf.slice(0, buf.indexOf("\n"));
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        msg.error
          ? done(reject, new Error(msg.error.message))
          : done(resolve, msg.result);
      });
      sock.on("error", (e) => done(reject, e));
    });
  }

  /**
   * 订阅:独立长连接。服务端先回 {id, result:{type:"subscription_started"}},
   * 之后持续推送 {event, data} 事件,直到连接断开。
   * 返回 socket(监听 close/error 做重连)。
   */
  subscribe(subscriptions, onEvent) {
    const sock = net.createConnection(this.socketPath);
    let buf = "";
    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: "sub",
          method: "events.subscribe",
          params: { subscriptions },
        })}\n`,
      );
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === "sub") continue; // subscription_started ack
        if (msg.event) onEvent(msg);
      }
    });
    return sock;
  }
}
