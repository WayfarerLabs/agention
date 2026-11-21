// A local stub of an OpenAI-compatible transcription provider, for the tests:
// it records what each request carried and answers as it is told. No test
// ever calls a real provider.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ProviderRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  fields: Record<string, string>;
  file: { name: string; type: string; size: number } | undefined;
}

// How the stub answers a request: a status with a body, or never.
export type StubAnswer =
  { status: number; body: string; headers?: Record<string, string> } | { hang: true };

export class StubProvider {
  readonly requests: ProviderRequest[] = [];
  // Whether each request's connection closed before the stub answered it.
  readonly abandoned: boolean[] = [];
  answer: (request: ProviderRequest) => StubAnswer = () => ({
    status: 200,
    body: JSON.stringify({ text: "Hello from the stub." }),
  });
  readonly #server: Server;
  readonly #open = new Set<ServerResponse>();

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<StubProvider> {
    let stub: StubProvider | undefined;
    const server = createServer((request, response) => void stub?.handle(request, response));
    stub = new StubProvider(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return stub;
  }

  // The stub's base URL, as Settings or the environment would give it.
  get baseUrl(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    const form = await new Response(body, {
      headers: { "content-type": request.headers["content-type"] ?? "" },
    })
      .formData()
      .catch(() => undefined);
    const fields: Record<string, string> = {};
    let file: ProviderRequest["file"];
    for (const [name, value] of form?.entries() ?? []) {
      if (typeof value === "string") {
        fields[name] = value;
      } else {
        file = { name: value.name, type: value.type, size: value.size };
      }
    }
    const recorded: ProviderRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      fields,
      file,
    };
    const index = this.requests.push(recorded) - 1;
    this.abandoned[index] = false;
    response.once("close", () => {
      if (!response.writableFinished) {
        this.abandoned[index] = true;
      }
      this.#open.delete(response);
    });
    this.#open.add(response);
    const answer = this.answer(recorded);
    if ("hang" in answer) {
      return;
    }
    response.writeHead(answer.status, {
      "content-type": "application/json",
      ...answer.headers,
    });
    response.end(answer.body);
  }

  async close(): Promise<void> {
    for (const response of this.#open) {
      response.destroy();
    }
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

// A recording the API takes: past the smallest size, of no real audio, since
// the stub reads none.
export function recording(size = 4000): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).fill(7);
}
