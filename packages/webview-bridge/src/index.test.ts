import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeError,
  PROTOCOL_VERSION,
  WebViewBridge,
  type BridgeEnvelope,
  type Transport,
  type WebViewBridgeOptions,
} from './index';

type Host = Window & {
  webkit?: {
    messageHandlers: Record<string, { postMessage: (message: unknown) => void } | undefined>;
  };
  Bridge?: { postMessage: (message: string) => void };
  ReactNativeWebView?: { postMessage: (message: string) => void };
  __webviewBridgeReceive?: (input: unknown) => void;
  nativePing?: (input: unknown) => void;
};

interface Recorder {
  posts: BridgeEnvelope[];
  transport: Transport;
}

const bridges: WebViewBridge[] = [];

function host(): Host {
  return window as Host;
}

function recording(): Recorder {
  const posts: BridgeEnvelope[] = [];
  return {
    posts,
    transport: {
      name: 'custom',
      post(envelope) {
        posts.push(envelope);
      },
    },
  };
}

function create(options: WebViewBridgeOptions = {}): WebViewBridge {
  const bridge = new WebViewBridge(options);
  bridges.push(bridge);
  return bridge;
}

function envelope(
  partial: Partial<BridgeEnvelope> & Pick<BridgeEnvelope, 'id' | 'kind' | 'name'>,
): BridgeEnvelope {
  return { version: PROTOCOL_VERSION, ...partial };
}

function settle<T>(promise: Promise<T>): Promise<T | BridgeError> {
  return promise.then(
    (value) => value,
    (error: unknown) => {
      if (error instanceof BridgeError) return error;
      throw error;
    },
  );
}

beforeEach(() => {
  const win = host();
  delete win.webkit;
  delete win.Bridge;
  delete win.ReactNativeWebView;
  delete (win as Host & { AndroidBridge?: unknown }).AndroidBridge;
  delete win.__webviewBridgeReceive;
  delete win.nativePing;
});

afterEach(() => {
  for (const bridge of bridges) bridge.destroy();
  bridges.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transport detection', () => {
  it('prefers iOS, then Android, then React Native, and posts in each platform shape', () => {
    const iosPost = vi.fn();
    const androidPost = vi.fn();
    const reactNativePost = vi.fn();
    host().webkit = { messageHandlers: { bridge: { postMessage: iosPost } } };
    host().Bridge = { postMessage: androidPost };
    host().ReactNativeWebView = { postMessage: reactNativePost };

    const iosBridge = create();
    iosBridge.emit('ready', { ok: true });
    expect(iosBridge.transportName).toBe('ios');
    expect(iosPost).toHaveBeenCalledTimes(1);
    expect(androidPost).not.toHaveBeenCalled();
    expect(reactNativePost).not.toHaveBeenCalled();
    const iosBody: unknown = iosPost.mock.calls[0]?.[0];
    expect(typeof iosBody).toBe('object');
    expect(iosBody).toMatchObject({
      version: 1,
      kind: 'event',
      name: 'ready',
      payload: { ok: true },
    });

    iosBridge.destroy();
    delete host().webkit;
    const androidBridge = create();
    void settle(androidBridge.request('storage.get', { key: 'token' }));
    expect(androidBridge.transportName).toBe('android');
    const androidRaw: unknown = androidPost.mock.calls[0]?.[0];
    expect(typeof androidRaw).toBe('string');
    expect(JSON.parse(androidRaw as string)).toMatchObject({
      kind: 'request',
      name: 'storage.get',
      payload: { key: 'token' },
    });

    androidBridge.destroy();
    delete host().Bridge;
    const reactNativeBridge = create();
    reactNativeBridge.emit('ready', { ok: true });
    expect(reactNativeBridge.transportName).toBe('react-native');
    const reactNativeRaw: unknown = reactNativePost.mock.calls[0]?.[0];
    expect(typeof reactNativeRaw).toBe('string');
    expect(JSON.parse(reactNativeRaw as string)).toMatchObject({ kind: 'event', name: 'ready' });
  });

  it('uses configured handler names', () => {
    const iosPost = vi.fn();
    const androidPost = vi.fn();
    host().webkit = { messageHandlers: { app: { postMessage: iosPost } } };
    host().Bridge = { postMessage: vi.fn() };

    const bridge = create({ iosHandler: 'app', androidInterface: 'AndroidBridge' });
    bridge.emit('ready', { ok: true });
    expect(iosPost).toHaveBeenCalledTimes(1);
    bridge.destroy();

    delete host().webkit;
    (host() as Host & { AndroidBridge?: { postMessage: (message: string) => void } }).AndroidBridge = {
      postMessage: androidPost,
    };
    const androidBridge = create({ androidInterface: 'AndroidBridge' });
    androidBridge.emit('ready', { ok: true });
    expect(androidBridge.transportName).toBe('android');
    expect(androidPost).toHaveBeenCalledTimes(1);
  });

  it('caches the first transport it finds', () => {
    const iosPost = vi.fn();
    const androidPost = vi.fn();
    host().webkit = { messageHandlers: { bridge: { postMessage: iosPost } } };
    const bridge = create();
    bridge.emit('ready', { ok: true });

    delete host().webkit;
    host().Bridge = { postMessage: androidPost };
    bridge.emit('ready', { ok: false });

    expect(bridge.transportName).toBe('ios');
    expect(iosPost).toHaveBeenCalledTimes(2);
    expect(androidPost).not.toHaveBeenCalled();
  });

  it('keeps looking until a transport exists, then stops', () => {
    const bridge = create();
    expect(bridge.transportName).toBeNull();
    expect(() => bridge.emit('ready', { ok: true })).toThrow(BridgeError);

    const androidPost = vi.fn();
    host().Bridge = { postMessage: androidPost };
    bridge.emit('ready', { ok: true });
    expect(bridge.transportName).toBe('android');
    expect(androidPost).toHaveBeenCalledTimes(1);
  });

  it('skips React Native when that fallback is disabled', () => {
    host().ReactNativeWebView = { postMessage: vi.fn() };
    const bridge = create({ reactNative: false });
    expect(() => bridge.emit('ready', 1)).toThrow(expect.objectContaining({ code: 'TRANSPORT_UNAVAILABLE' }));
    expect(bridge.transportName).toBeNull();
  });

  it('uses an injected transport and does not touch the page', () => {
    const iosPost = vi.fn();
    host().webkit = { messageHandlers: { bridge: { postMessage: iosPost } } };
    const { posts, transport } = recording();
    const bridge = create({ transport });

    bridge.emit('ready', { ok: true });

    expect(bridge.transportName).toBe('custom');
    expect(posts).toHaveLength(1);
    expect(iosPost).not.toHaveBeenCalled();
  });

  it('rejects the request and clears it when nothing can post', async () => {
    const bridge = create();
    await expect(bridge.request('ping')).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
    expect(bridge.pendingCount).toBe(0);
  });

  it('clears the pending request when serialization throws', async () => {
    host().Bridge = { postMessage: vi.fn() };
    const bridge = create();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(bridge.request('save', circular)).rejects.toMatchObject({ code: 'POST_FAILED' });
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('request/response correlation', () => {
  it('resolves each call with the response that echoes its id', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });

    const first = bridge.request('storage.get', { key: 'a' });
    const second = bridge.request('storage.get', { key: 'b' });

    expect(posts.map((message) => message.kind)).toEqual(['request', 'request']);
    expect(posts[0]).toMatchObject({ version: 1, name: 'storage.get', payload: { key: 'a' } });
    expect(posts[0]?.id).toEqual(expect.any(String));
    expect(posts[0]?.id).not.toBe(posts[1]?.id);
    expect(bridge.pendingCount).toBe(2);

    bridge.receive(
      envelope({ id: posts[1]!.id, kind: 'response', name: 'storage.get', payload: { value: 'b' } }),
    );
    await expect(second).resolves.toEqual({ value: 'b' });
    expect(bridge.pendingCount).toBe(1);

    bridge.receive(
      JSON.stringify(
        envelope({ id: posts[0]!.id, kind: 'response', name: 'storage.get', payload: { value: 'a' } }),
      ),
    );
    await expect(first).resolves.toEqual({ value: 'a' });
    expect(bridge.pendingCount).toBe(0);

    bridge.receive(
      envelope({ id: posts[0]!.id, kind: 'response', name: 'storage.get', payload: { value: 'late' } }),
    );
    await expect(first).resolves.toEqual({ value: 'a' });
  });

  it('does not treat an inbound request as the response, even with the same id', () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    void settle(bridge.request('ping', { n: 1 }));
    const id = posts[0]!.id;

    bridge.receive(envelope({ id, kind: 'request', name: 'ping', payload: { n: 1 } }));

    expect(bridge.pendingCount).toBe(1);
    expect(posts.at(-1)).toMatchObject({
      kind: 'response',
      id,
      name: 'ping',
      error: { code: 'METHOD_NOT_FOUND' },
    });
  });

  it('ignores a response whose id is unknown', async () => {
    const { transport } = recording();
    const bridge = create({ transport });
    const pending = settle(bridge.request('ping'));

    bridge.receive(envelope({ id: 'someone-else', kind: 'response', name: 'ping', payload: 1 }));
    await Promise.resolve();

    expect(bridge.pendingCount).toBe(1);
    bridge.destroy();
    await expect(pending).resolves.toMatchObject({ code: 'DESTROYED' });
  });
});

describe('timeout', () => {
  it('rejects with TIMEOUT and ignores a late response', async () => {
    vi.useFakeTimers();
    const { posts, transport } = recording();
    const bridge = create({ transport });
    const pending = settle(bridge.request('storage.get', { key: 'a' }, { timeout: 25 }));

    await vi.advanceTimersByTimeAsync(24);
    expect(bridge.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('storage.get') as string,
    });
    expect(bridge.pendingCount).toBe(0);

    bridge.receive(
      envelope({ id: posts[0]!.id, kind: 'response', name: 'storage.get', payload: { value: 'late' } }),
    );
    expect(bridge.pendingCount).toBe(0);
  });

  it('defaults to 10 seconds', async () => {
    vi.useFakeTimers();
    const { transport } = recording();
    const bridge = create({ transport });
    const pending = settle(bridge.request('ping'));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(bridge.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ code: 'TIMEOUT' });
    expect(bridge.pendingCount).toBe(0);
  });

  it('rejects an invalid timeout without sending', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });

    await expect(bridge.request('ping', undefined, { timeout: 0 })).rejects.toMatchObject({
      code: 'INVALID_TIMEOUT',
    });
    await expect(bridge.request('ping', undefined, { timeout: -1 })).rejects.toMatchObject({
      code: 'INVALID_TIMEOUT',
    });
    await expect(bridge.request('ping', undefined, { timeout: Number.POSITIVE_INFINITY })).rejects.toMatchObject({
      code: 'INVALID_TIMEOUT',
    });
    expect(posts).toHaveLength(0);
    expect(bridge.pendingCount).toBe(0);
    expect(() => create({ timeout: 0 })).toThrow(BridgeError);
  });
});

describe('error envelope', () => {
  it('rejects with the native code and message and drops the pending entry', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    const pending = settle(bridge.request('storage.get', { key: 'missing' }));

    bridge.receive(
      envelope({
        id: posts[0]!.id,
        kind: 'response',
        name: 'storage.get',
        payload: { value: 'ignored' },
        error: { code: 'NOT_FOUND', message: 'missing' },
      }),
    );

    const error = await pending;
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'missing' });
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('invalid messages', () => {
  it('ignores malformed input and leaves pending requests and listeners alone', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    const handler = vi.fn();
    bridge.on('ready', handler);
    const pending = settle(bridge.request('ping'));

    const junk: unknown[] = [
      'not json',
      '{',
      '"just a string"',
      '',
      null,
      undefined,
      1,
      true,
      [],
      {},
      { version: 1 },
      { version: '1', id: 'x', kind: 'event', name: 'ready' },
      { version: 2, id: 'x', kind: 'event', name: 'ready' },
      { version: 1, id: '', kind: 'event', name: 'ready' },
      { version: 1, id: 'x', kind: 'event', name: '' },
      { version: 1, id: 'x', kind: 'reply', name: 'ready' },
      { version: 1, id: 'x', kind: 'event', name: 'ready', error: { code: 'X', message: 'nope' } },
      { version: 1, id: 'x', kind: 'response', name: 'ping', error: { code: '', message: 'x' } },
      { version: 1, id: 'x', kind: 'response', name: 'ping', error: { code: 'X' } },
      { version: 1, id: 'x', kind: 'response', name: 'ping', error: 'X' },
      { version: 1, id: 'x', kind: 'response', name: 'ping', error: { code: 1, message: 'x' } },
    ];

    for (const input of junk) {
      bridge.receive(input);
      window.dispatchEvent(new MessageEvent('message', { data: input }));
    }

    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(bridge.pendingCount).toBe(1);
    expect(posts).toHaveLength(1);

    bridge.destroy();
    await expect(pending).resolves.toMatchObject({ code: 'DESTROYED' });
  });
});

describe('string and object payloads', () => {
  it('accepts an object, a JSON string, and a double-encoded JSON string', () => {
    const bridge = create({ transport: recording().transport });
    const handler = vi.fn();
    bridge.on('ready', handler);

    const body = envelope({ id: 'e1', kind: 'event', name: 'ready', payload: { n: 1 } });
    bridge.receive(body);
    bridge.receive(JSON.stringify(envelope({ id: 'e2', kind: 'event', name: 'ready', payload: 0 })));
    bridge.receive(
      JSON.stringify(JSON.stringify(envelope({ id: 'e3', kind: 'event', name: 'ready', payload: false }))),
    );

    expect(handler).toHaveBeenNthCalledWith(1, { n: 1 });
    expect(handler).toHaveBeenNthCalledWith(2, 0);
    expect(handler).toHaveBeenNthCalledWith(3, false);
  });

  it('preserves null and empty string payloads', () => {
    const bridge = create({ transport: recording().transport });
    const handler = vi.fn();
    bridge.on('ready', handler);

    bridge.receive(envelope({ id: 'e1', kind: 'event', name: 'ready', payload: null }));
    bridge.receive(JSON.stringify(envelope({ id: 'e2', kind: 'event', name: 'ready', payload: '' })));

    expect(handler).toHaveBeenNthCalledWith(1, null);
    expect(handler).toHaveBeenNthCalledWith(2, '');
  });

  it('reads window messages, document messages, and the global function', () => {
    const { transport } = recording();
    const bridge = create({ transport });
    const handler = vi.fn();
    bridge.on('ready', handler);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: envelope({ id: 'e1', kind: 'event', name: 'ready', payload: 'window-object' }),
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify(envelope({ id: 'e2', kind: 'event', name: 'ready', payload: 'window-string' })),
      }),
    );
    (document as EventTarget).dispatchEvent(
      new MessageEvent('message', {
        data: envelope({ id: 'e3', kind: 'event', name: 'ready', payload: 'document' }),
      }),
    );
    host().__webviewBridgeReceive?.(
      envelope({ id: 'e4', kind: 'event', name: 'ready', payload: 'global-object' }),
    );
    host().__webviewBridgeReceive?.(
      JSON.stringify(envelope({ id: 'e5', kind: 'event', name: 'ready', payload: 'global-string' })),
    );

    expect(handler.mock.calls.map((call) => call[0])).toEqual([
      'window-object',
      'window-string',
      'document',
      'global-object',
      'global-string',
    ]);
    expect(host().__webviewBridgeReceive).toBe(bridge.receive);
  });

  it('can rename the global and ignore window messages when listen is off', () => {
    const bridge = create({ transport: recording().transport, receiveName: 'nativePing', listen: false });
    const handler = vi.fn();
    bridge.on('ready', handler);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: envelope({ id: 'e1', kind: 'event', name: 'ready', payload: 1 }),
      }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(host().__webviewBridgeReceive).toBeUndefined();

    host().nativePing?.(JSON.stringify(envelope({ id: 'e2', kind: 'event', name: 'ready', payload: 2 })));
    expect(handler).toHaveBeenCalledWith(2);
  });
});

describe('events', () => {
  it('supports on, off, and the unsubscribe function', () => {
    const bridge = create({ transport: recording().transport });
    const first = vi.fn();
    const second = vi.fn();
    const stop = bridge.on('ready', first);
    bridge.on('ready', second);

    bridge.receive(envelope({ id: 'e1', kind: 'event', name: 'ready', payload: 1 }));
    expect(first).toHaveBeenCalledWith(1);
    expect(second).toHaveBeenCalledWith(1);

    stop();
    bridge.off('ready', second);
    bridge.off('ready', second);
    bridge.receive(envelope({ id: 'e2', kind: 'event', name: 'ready', payload: 2 }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('still calls later handlers when an earlier one unsubscribes or throws', () => {
    const bridge = create({ transport: recording().transport });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let firstCalls = 0;
    const stop = bridge.on('ready', () => {
      firstCalls += 1;
      stop();
    });
    bridge.on('ready', () => {
      throw new Error('bad subscriber');
    });
    const third = vi.fn();
    bridge.on('ready', third);

    bridge.receive(envelope({ id: 'e1', kind: 'event', name: 'ready', payload: { ok: true } }));
    bridge.receive(envelope({ id: 'e2', kind: 'event', name: 'ready', payload: { ok: true } }));

    expect(firstCalls).toBe(1);
    expect(third).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('emits to native without calling local subscribers', () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    const handler = vi.fn();
    bridge.on('ready', handler);
    bridge.on('tick', handler);

    bridge.emit('ready', { ok: true });
    bridge.emit('tick');

    expect(handler).not.toHaveBeenCalled();
    expect(posts[0]).toMatchObject({ kind: 'event', name: 'ready', version: 1, payload: { ok: true } });
    expect(posts[1]).toMatchObject({ kind: 'event', name: 'tick', version: 1 });
    expect(posts[1]).not.toHaveProperty('payload');
    expect(posts[0]?.id).not.toBe(posts[1]?.id);
  });
});

describe('destroy', () => {
  it('rejects pending work, removes listeners, and is idempotent', async () => {
    vi.useFakeTimers();
    const { transport } = recording();
    const bridge = create({ transport });
    const handler = vi.fn();
    bridge.on('ready', handler);
    const pending = settle(bridge.request('ping', { n: 1 }, { timeout: 5_000 }));

    bridge.destroy();

    await expect(pending).resolves.toMatchObject({
      code: 'DESTROYED',
      message: expect.stringContaining('ping') as string,
    });
    expect(bridge.pendingCount).toBe(0);
    expect(host().__webviewBridgeReceive).toBeUndefined();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: envelope({ id: 'e', kind: 'event', name: 'ready', payload: 1 }),
      }),
    );
    bridge.receive(envelope({ id: 'e', kind: 'event', name: 'ready', payload: 1 }));
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(bridge.pendingCount).toBe(0);

    expect(() => bridge.destroy()).not.toThrow();
    await expect(bridge.request('ping')).rejects.toMatchObject({ code: 'DESTROYED' });
    expect(() => bridge.emit('ready', 1)).toThrow(expect.objectContaining({ code: 'DESTROYED' }));
    expect(() => bridge.on('ready', handler)).toThrow(expect.objectContaining({ code: 'DESTROYED' }));
    expect(bridge.pendingCount).toBe(0);
  });

  it('does not remove a global installed by a newer bridge', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = create();
    const second = create();

    expect(warn).toHaveBeenCalled();
    expect(host().__webviewBridgeReceive).toBe(second.receive);

    first.destroy();
    expect(host().__webviewBridgeReceive).toBe(second.receive);
    second.destroy();
    expect(host().__webviewBridgeReceive).toBeUndefined();
  });
});

describe('native to web requests', () => {
  it('replies with the handler result, including falsy payloads', () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    bridge.handle('echo', (payload: unknown) => payload);

    bridge.receive(envelope({ id: 'n1', kind: 'request', name: 'echo', payload: { a: 2, b: 3 } }));
    bridge.receive(envelope({ id: 'n2', kind: 'request', name: 'echo', payload: 0 }));
    bridge.receive(envelope({ id: 'n3', kind: 'request', name: 'echo', payload: false }));
    bridge.receive(envelope({ id: 'n4', kind: 'request', name: 'echo', payload: null }));

    expect(posts.map((message) => message.payload)).toEqual([{ a: 2, b: 3 }, 0, false, null]);
    expect(posts.every((message) => message.kind === 'response' && message.error === undefined)).toBe(true);
  });

  it('waits for an async handler', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    bridge.handle('add', async (payload: { a: number; b: number }) => {
      await Promise.resolve();
      return payload.a + payload.b;
    });

    bridge.receive(envelope({ id: 'n1', kind: 'request', name: 'add', payload: { a: 2, b: 3 } }));
    expect(posts).toHaveLength(0);

    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ id: 'n1', kind: 'response', name: 'add', payload: 5 });
    });
  });

  it('turns handler failures into error envelopes', () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });

    bridge.handle('boom', () => {
      throw new BridgeError('BAD_INPUT', 'nope');
    });
    bridge.receive(envelope({ id: 'n1', kind: 'request', name: 'boom' }));

    bridge.handle('boom', () => {
      throw new Error('explode');
    });
    bridge.receive(envelope({ id: 'n2', kind: 'request', name: 'boom' }));

    bridge.handle('boom', () => {
      throw 'plain';
    });
    bridge.receive(envelope({ id: 'n3', kind: 'request', name: 'boom' }));

    expect(posts.map((message) => message.error)).toEqual([
      { code: 'BAD_INPUT', message: 'nope' },
      { code: 'HANDLER_ERROR', message: 'explode' },
      { code: 'HANDLER_ERROR', message: 'plain' },
    ]);
    expect(posts.every((message) => message.payload === undefined)).toBe(true);
  });

  it('rejects an async handler and omits a void success payload', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    bridge.handle('void', async () => undefined);
    bridge.handle('fail', () => Promise.reject(new BridgeError('DENIED', 'no')));

    bridge.receive(envelope({ id: 'ok', kind: 'request', name: 'void' }));
    bridge.receive(envelope({ id: 'no', kind: 'request', name: 'fail' }));

    await vi.waitFor(() => {
      expect(posts).toHaveLength(2);
    });
    expect(posts[0]).toMatchObject({ id: 'ok', kind: 'response', name: 'void' });
    expect(posts[0]).not.toHaveProperty('payload');
    expect(posts[1]).toMatchObject({
      id: 'no',
      error: { code: 'DENIED', message: 'no' },
    });
  });

  it('reports METHOD_NOT_FOUND and honors handler replacement', () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });

    bridge.receive(envelope({ id: 'missing', kind: 'request', name: 'nope' }));
    expect(posts[0]).toMatchObject({
      id: 'missing',
      kind: 'response',
      name: 'nope',
      error: { code: 'METHOD_NOT_FOUND', message: 'No handler for "nope"' },
    });

    const stopFirst = bridge.handle('echo', () => 1);
    const stopSecond = bridge.handle('echo', () => 2);
    stopFirst();
    bridge.receive(envelope({ id: 'n1', kind: 'request', name: 'echo' }));
    expect(posts.at(-1)?.payload).toBe(2);

    stopSecond();
    bridge.receive(envelope({ id: 'n2', kind: 'request', name: 'echo' }));
    expect(posts.at(-1)?.error).toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('does not reply after destroy resolves an in-flight handler', async () => {
    const { posts, transport } = recording();
    const bridge = create({ transport });
    let resolve: ((value: number) => void) | undefined;
    bridge.handle(
      'slow',
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );

    bridge.receive(envelope({ id: 'n1', kind: 'request', name: 'slow' }));
    bridge.destroy();
    resolve?.(1);
    await Promise.resolve();

    expect(posts).toHaveLength(0);
  });
});
