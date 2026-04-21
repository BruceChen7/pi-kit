import type { BootstrapResponse } from "./types";

export async function waitForBootstrapReady(input: {
  bootstrap: () => Promise<BootstrapResponse>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Extract<BootstrapResponse, { status: "ready" }>> {
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while (true) {
    const response = await input.bootstrap();
    if (response.status === "ready") {
      return response;
    }

    if (response.status === "failed") {
      throw new Error(response.error);
    }

    await sleep(response.retryAfterMs);
  }
}
