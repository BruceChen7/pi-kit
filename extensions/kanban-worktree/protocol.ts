import { createConnection } from "node:net";

export type RpcId = string | number | null;

export type RpcRequest = {
  id?: RpcId;
  method: string;
  params?: unknown;
};

export type RpcSuccess = {
  id: RpcId;
  result: unknown;
};

export type RpcError = {
  id: RpcId;
  error: {
    message: string;
  };
};

export class JsonLineCodec {
  private buffered = "";

  push(chunk: Buffer | string): unknown[] {
    this.buffered += chunk.toString();
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    return parseJsonLines(lines);
  }

  encode(message: unknown): string {
    return `${JSON.stringify(message)}\n`;
  }
}

function parseJsonLines(lines: string[]): unknown[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export function createSuccess(id: RpcId, result: unknown): RpcSuccess {
  return { id, result };
}

export function createError(id: RpcId, message: string): RpcError {
  return { id, error: { message } };
}

export async function sendJsonLineRequest(
  socketPath: string,
  message: unknown,
): Promise<unknown> {
  const codec = new JsonLineCodec();
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(codec.encode(message)));
    socket.on("data", (chunk) => {
      const [response] = codec.push(chunk);
      if (response) {
        socket.end();
        resolve(response);
      }
    });
  });
}
