import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startUiServer, type UiServer } from '../src/ui/server.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () =>
        resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const TOKEN = 'test-token-0123456789abcdef';
let server: UiServer;
let workspace: string;
let savedWorkspace: string | undefined;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'mmc-ui-lan-test-'));
  savedWorkspace = process.env.MAKEMYCLIP_WORKSPACE;
  process.env.MAKEMYCLIP_WORKSPACE = workspace;
  server = await startUiServer({ openBrowser: false, host: '0.0.0.0', token: TOKEN });
});

afterAll(async () => {
  await server.stop();
  if (savedWorkspace === undefined) delete process.env.MAKEMYCLIP_WORKSPACE;
  else process.env.MAKEMYCLIP_WORKSPACE = savedWorkspace;
  await rm(workspace, { recursive: true, force: true });
});

describe('clip ui LAN access', () => {
  it('refuses to bind to the network without a token', async () => {
    await expect(startUiServer({ openBrowser: false, host: '0.0.0.0', token: '' })).rejects.toThrow(
      /MAKEMYCLIP_UI_TOKEN/,
    );
    await expect(
      startUiServer({ openBrowser: false, host: '0.0.0.0', token: 'short' }),
    ).rejects.toThrow(/at least 16/);
  });

  it('rejects requests without credentials', async () => {
    const reply = await send(server.port, '/api/workspace', { host: '192.168.1.5:5573' });
    expect(reply.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const reply = await send(server.port, '/?token=nope', { host: '192.168.1.5:5573' });
    expect(reply.status).toBe(401);
  });

  it('exchanges the token for a cookie that unlocks the API from a LAN host', async () => {
    const login = await send(server.port, `/?token=${TOKEN}`, { host: '192.168.1.5:5573' });
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe('/');
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(';')[0] ?? '';
    const reply = await send(server.port, '/api/workspace', {
      host: '192.168.1.5:5573',
      cookie,
    });
    expect(reply.status).toBe(200);
  });

  it('accepts a bearer token', async () => {
    const reply = await send(server.port, '/api/workspace', {
      host: '192.168.1.5:5573',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(reply.status).toBe(200);
  });
});
