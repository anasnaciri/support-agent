import { once } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  imapClientOptions,
  makeImapSmtpOps,
  smtpTransportOptions,
  type ImapSmtpConfig,
} from "../src/imap-smtp.js";

// S7 — TLS downgrade. `secure: false` used to mean *opportunistic* STARTTLS:
// against a server (or MITM) that doesn't offer the upgrade, imapflow and
// nodemailer would happily continue in cleartext and send the app password.
// The fix makes STARTTLS mandatory (fail before any credentials leave the
// socket) and floors both transports at TLS 1.2 with cert verification on.

const config = (overrides: Partial<ImapSmtpConfig> = {}): ImapSmtpConfig => ({
  imapHost: "imap.example.com",
  imapPort: 143,
  imapSecure: false,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
  user: "user@example.com",
  password: "app-password",
  ...overrides,
});

describe("imapClientOptions", () => {
  it("requires the STARTTLS upgrade when secure is false", () => {
    const opts = imapClientOptions(config({ imapSecure: false }));
    expect(opts.secure).toBe(false);
    expect(opts.doSTARTTLS).toBe(true);
  });

  it("does not set doSTARTTLS on an implicit-TLS connection (invalid combo)", () => {
    const opts = imapClientOptions(config({ imapSecure: true, imapPort: 993 }));
    expect(opts.secure).toBe(true);
    expect("doSTARTTLS" in opts).toBe(false);
  });

  it("floors TLS at 1.2 with certificate verification on", () => {
    for (const secure of [true, false]) {
      const opts = imapClientOptions(config({ imapSecure: secure }));
      expect(opts.tls).toMatchObject({
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      });
    }
  });
});

describe("smtpTransportOptions", () => {
  it("sets requireTLS whenever secure is false", () => {
    const opts = smtpTransportOptions(config({ smtpSecure: false }));
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
  });

  it("floors TLS at 1.2 with certificate verification on", () => {
    for (const secure of [true, false]) {
      const opts = smtpTransportOptions(config({ smtpSecure: secure }));
      expect(opts.tls).toMatchObject({
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      });
    }
  });
});

// ============================================================
// Live downgrade attempts against fake cleartext servers
// ============================================================

const servers: Array<Server> = [];
const sockets: Array<Socket> = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(
    servers.splice(0).map(
      (srv) => new Promise<void>((resolve) => srv.close(() => resolve())),
    ),
  );
});

const listen = async (srv: Server): Promise<number> => {
  servers.push(srv);
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  return (srv.address() as AddressInfo).port;
};

/** Minimal IMAP server that does NOT support STARTTLS. Records every line. */
const fakeImapServer = (received: Array<string>): Server =>
  createServer((socket) => {
    sockets.push(socket);
    socket.write("* OK fake IMAP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);
        const tag = line.split(" ")[0] ?? "*";
        const cmd = (line.split(" ")[1] ?? "").toUpperCase();
        if (cmd === "CAPABILITY") {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        } else if (cmd === "STARTTLS") {
          socket.write(`${tag} NO STARTTLS not supported\r\n`);
        } else if (cmd === "LOGOUT") {
          socket.write(`* BYE\r\n${tag} OK bye\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} NO nope\r\n`);
        }
      }
    });
  });

/** Minimal SMTP server that does NOT support STARTTLS but offers AUTH. */
const fakeSmtpServer = (received: Array<string>): Server =>
  createServer((socket) => {
    sockets.push(socket);
    socket.write("220 fake.test ESMTP\r\n");
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write("250 queued\r\n");
      }
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);
        const cmd = line.split(" ")[0]?.toUpperCase() ?? "";
        if (cmd === "EHLO" || cmd === "HELO") {
          socket.write("250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (cmd === "STARTTLS") {
          socket.write("502 STARTTLS not supported\r\n");
        } else if (cmd === "AUTH") {
          socket.write("235 ok\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });

describe("makeImapSmtpOps TLS enforcement", () => {
  it("aborts an IMAP connection without STARTTLS before sending credentials", async () => {
    const received: Array<string> = [];
    const port = await listen(fakeImapServer(received));
    const ops = makeImapSmtpOps(
      config({ imapHost: "127.0.0.1", imapPort: port, imapSecure: false }),
    );
    await expect(ops.latestUid()).rejects.toThrow(/STARTTLS|secure/i);
    // The whole point: the app password never crossed the cleartext socket.
    expect(received.join("\n")).not.toMatch(/\bLOGIN\b|\bAUTHENTICATE\b/i);
  }, 15000);

  it("aborts an SMTP send without STARTTLS before authenticating", async () => {
    const received: Array<string> = [];
    const port = await listen(fakeSmtpServer(received));
    const ops = makeImapSmtpOps(
      config({ smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false }),
    );
    await expect(
      ops.send({
        from: { name: null, email: "user@example.com" },
        to: [{ name: null, email: "customer@example.com" }],
        subject: "hello",
        text: "hi",
        html: null,
        inReplyTo: null,
        references: [],
      }),
    ).rejects.toThrow(/STARTTLS|TLS/i);
    expect(received.join("\n")).not.toMatch(/^AUTH\b/im);
  }, 15000);
});
