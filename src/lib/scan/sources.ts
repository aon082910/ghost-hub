import { ImapFlow } from "imapflow";
import { findConnection, getAccessToken, getImapCredentials } from "../mailboxes";
import { GmailSource } from "./gmail";
import { GraphSource } from "./graph";
import { ImapSource, type ImapScanClient } from "./imap-source";
import type { MailSource } from "./types";

/** Build the right header reader for a connected mailbox. */
export async function createSource(mailbox: string): Promise<MailSource> {
  const conn = await findConnection(mailbox);
  if (!conn) throw new Error(`No connection for ${mailbox}`);

  const getToken = () => getAccessToken(mailbox);
  switch (conn.provider) {
    case "google":
      return new GmailSource({ getToken });
    case "microsoft":
      return new GraphSource({ getToken });
    case "imap": {
      const c = await getImapCredentials(mailbox);
      const client = new ImapFlow({
        host: c.host,
        port: c.port,
        secure: true,
        auth: { user: c.user, pass: c.pass },
        logger: false,
        greetingTimeout: 15_000,
        socketTimeout: 5 * 60_000,
      });
      // Socket errors also reject the in-flight command; without a listener Node treats 'error' as fatal.
      client.on("error", () => {});
      return new ImapSource(client as unknown as ImapScanClient);
    }
    default:
      throw new Error(`Unsupported provider ${conn.provider}`);
  }
}
