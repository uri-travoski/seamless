import { SESv2Client, SendEmailCommand, GetAccountCommand } from '@aws-sdk/client-sesv2';
import { TransportError, type OutboundTransport } from '../types.ts';
import { simpleTest, need } from './common.ts';

export interface SesLikeClient { send(cmd: any): Promise<any> }

function mapSesError(err: any): TransportError {
  if (err instanceof TransportError) return err;
  const status = Number(err?.$metadata?.httpStatusCode ?? 0);
  const name = String(err?.name ?? '');
  const throttled = /Throttl|TooManyRequests|LimitExceeded|ServiceUnavailable|InternalFailure/i.test(name);
  const network = !status; // never got an HTTP answer
  return new TransportError(`Amazon SES: ${err?.message ?? name ?? 'send failed'}`,
    { retryable: throttled || network || status === 429 || status >= 500, status: status || undefined });
}

export function sesFromConfig(cfg: Record<string, any>, client?: SesLikeClient): OutboundTransport {
  need(cfg, 'region');
  if (!client) need(cfg, 'accessKeyId', 'secretAccessKey');
  const c: SesLikeClient = client ?? new SESv2Client({
    region: String(cfg.region), credentials: { accessKeyId: String(cfg.accessKeyId), secretAccessKey: String(cfg.secretAccessKey) },
    ...(cfg.endpoint ? { endpoint: String(cfg.endpoint) } : {}),
  });
  return {
    kind: 'ses',
    async send(raw, env) {
      try {
        const out = await c.send(new SendEmailCommand({
          FromEmailAddress: env.from,
          Destination: { ToAddresses: env.to },
          Content: { Raw: { Data: new Uint8Array(raw) } },
          ...(cfg.configurationSet ? { ConfigurationSetName: String(cfg.configurationSet) } : {}),
        }));
        return { providerMessageId: out?.MessageId };
      } catch (err) { throw mapSesError(err); }
    },
    test: () => simpleTest('Credentials accepted', async () => {
      try { await c.send(new GetAccountCommand({})); } catch (err) { throw mapSesError(err); }
    }),
  };
}
