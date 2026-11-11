/** Outbound transport interface (T3 F-22). SMTP and API providers all look like this. */
export interface TransportTestStep { name: string; ok: boolean; detail?: string }

export interface OutboundTransport {
  kind: string;
  send(raw: Buffer, env: { from: string; to: string[] }): Promise<{ providerMessageId?: string }>;
  test(): Promise<{ ok: boolean; steps: TransportTestStep[] }>;
}

export class TransportError extends Error {
  retryable: boolean;
  status?: number;
  constructor(message: string, opts: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'TransportError';
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}
