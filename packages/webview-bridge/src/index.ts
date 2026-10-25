/**
 * Web ↔ native envelope for a page running inside a WebView.
 *
 * The wire format is documented in README.md. This file is the whole runtime.
 */

export const PROTOCOL_VERSION = 1 as const;

export const DEFAULT_IOS_HANDLER = 'bridge';
export const DEFAULT_ANDROID_INTERFACE = 'Bridge';
export const DEFAULT_RECEIVE_NAME = '__webviewBridgeReceive';
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Reserved web → native event sent by `announceReady()`.
 * Native must queue anything it wants to send to the page until this arrives.
 * Without it, messages native sends before the page script runs are lost
 * (the bug people usually call a "timing issue").
 */
export const READY_EVENT = 'bridge.ready';

export type MessageKind = 'request' | 'response' | 'event';

export interface BridgeErrorBody {
  code: string;
  message: string;
}

export interface BridgeEnvelope<TPayload = unknown> {
  version: typeof PROTOCOL_VERSION;
  id: string;
  kind: MessageKind;
  name: string;
  payload?: TPayload;
  error?: BridgeErrorBody;
}

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * One method the other side can call.
 * Use `void` for a side that carries no data.
 */
export interface MethodDef<TPayload = unknown, TResult = unknown> {
  payload: TPayload;
  result: TResult;
}

/**
 * `any` is the constraint that lets a concrete map be passed as a generic.
 * Call sites still see the concrete payload and result types.
 */
export type MethodMap = Record<string, MethodDef<any, any>>;

/** Event name → payload. Use `void` when the event has no payload. */
export type EventMap = Record<string, any>;

export interface Transport {
  /** `ios`, `android`, `react-native`, or any label you use in tests. */
  readonly name: string;
  post(envelope: BridgeEnvelope): void;
}

export interface RequestOptions {
  /** Milliseconds before the promise rejects with code `TIMEOUT`. */
  timeout?: number;
}

export interface WebViewBridgeOptions {
  /** `window.webkit.messageHandlers[iosHandler]`. Default `bridge`. */
  iosHandler?: string;
  /** `window[androidInterface].postMessage(json)`. Default `Bridge`. */
  androidInterface?: string;
  /**
   * Fall back to `window.ReactNativeWebView` when no iOS or Android handler exists.
   * Default `true`.
   */
  reactNative?: boolean;
  /** Skip detection and post every outbound envelope here. */
  transport?: Transport;
  /** Default timeout for `request`. Default `10_000`. */
  timeout?: number;
  /** Global native calls. Default `__webviewBridgeReceive`. */
  receiveName?: string;
  /**
   * Call `announceReady()` right after construction. Default `false`.
   * Turn it on in the real app; leave it off in tests that count posts.
   */
  announceReady?: boolean;
  /**
   * Subscribe to `message` on `window` and `document`.
   * `document` is what React Native WebView uses on Android.
   * Default `true`.
   */
  listen?: boolean;
}

type DefaultMethods = Record<string, MethodDef<any, any>>;
type DefaultEvents = Record<string, any>;

type PayloadOf<TMethods extends MethodMap, K extends keyof TMethods> = TMethods[K]['payload'];
type ResultOf<TMethods extends MethodMap, K extends keyof TMethods> = TMethods[K]['result'];

/** `any` and `void` (and types that include `undefined`) may omit the payload argument. */
type OptionalPayload<P> = 0 extends 1 & P
  ? true
  : [P] extends [void]
    ? true
    : undefined extends P
      ? true
      : false;

type RequestArgs<P> = OptionalPayload<P> extends true
  ? [payload?: P, options?: RequestOptions]
  : [payload: P, options?: RequestOptions];

type EmitArgs<P> = OptionalPayload<P> extends true ? [payload?: P] : [payload: P];

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ResolvedOptions {
  iosHandler: string;
  androidInterface: string;
  reactNative: boolean;
  transport: Transport | undefined;
  timeout: number;
  receiveName: string;
  listen: boolean;
  announceReady: boolean;
}

type InboundHandler = (payload: unknown) => unknown;
type EventHandler = (payload: unknown) => void;

interface Postable {
  postMessage: (message: unknown) => void;
}

const KINDS: readonly MessageKind[] = ['request', 'response', 'event'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is MessageKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Objects pass through. Strings are parsed once.
 * A second parse runs only when the first parse is itself a string,
 * which is the usual "quoted the JSON twice" native bug.
 * `undefined` means the text was not JSON. JSON cannot encode `undefined`.
 */
function decodeMessage(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const parsed = tryParseJson(input);
  if (typeof parsed !== 'string') return parsed;
  const reparsed = tryParseJson(parsed);
  return reparsed === undefined ? parsed : reparsed;
}

/** `undefined` = field absent. `null` = present but not `{ code, message }`. */
function parseError(value: unknown): BridgeErrorBody | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (typeof value.code !== 'string' || value.code.length === 0) return null;
  if (typeof value.message !== 'string') return null;
  return { code: value.code, message: value.message };
}

function parseEnvelope(input: unknown): BridgeEnvelope | null {
  const value = decodeMessage(input);
  if (!isRecord(value)) return null;
  if (value.version !== PROTOCOL_VERSION) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (!isKind(value.kind)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0) return null;

  const error = parseError(value.error);
  if (error === null) return null;
  // `error` is only meaningful on a response. Anywhere else the message is malformed.
  if (error && value.kind !== 'response') return null;

  const envelope: BridgeEnvelope = {
    version: PROTOCOL_VERSION,
    id: value.id,
    kind: value.kind,
    name: value.name,
  };
  if ('payload' in value) envelope.payload = value.payload;
  if (error) envelope.error = error;
  return envelope;
}

function createEnvelope(
  kind: MessageKind,
  id: string,
  name: string,
  payload: unknown,
  error?: BridgeErrorBody,
): BridgeEnvelope {
  const envelope: BridgeEnvelope = {
    version: PROTOCOL_VERSION,
    id,
    kind,
    name,
  };
  if (payload !== undefined) envelope.payload = payload;
  if (error) envelope.error = error;
  return envelope;
}

let fallbackSeq = 0;

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  fallbackSeq += 1;
  return `m.${Date.now().toString(36)}.${fallbackSeq.toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

function toBridgeError(value: unknown, fallbackCode: string): BridgeError {
  if (value instanceof BridgeError) return value;
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return new BridgeError(fallbackCode, message || fallbackCode);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

function readPostable(value: unknown): Postable | null {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (typeof (value as { postMessage?: unknown }).postMessage !== 'function') return null;
  return value as Postable;
}

/**
 * First match wins and is cached by the instance:
 * iOS WKWebView handler, then the Android JavascriptInterface, then React Native.
 * An injected `transport` never reaches this function.
 */
function detectTransport(options: ResolvedOptions): Transport | null {
  if (typeof window === 'undefined') return null;

  const webkit = (
    window as Window & {
      webkit?: { messageHandlers?: Record<string, unknown> };
    }
  ).webkit;
  const ios = readPostable(webkit?.messageHandlers?.[options.iosHandler]);
  if (ios) {
    const postMessage = ios.postMessage.bind(ios);
    return {
      name: 'ios',
      post(envelope) {
        postMessage(envelope);
      },
    };
  }

  const android = readPostable((window as unknown as Record<string, unknown>)[options.androidInterface]);
  if (android) {
    const postMessage = android.postMessage.bind(android);
    return {
      name: 'android',
      post(envelope) {
        postMessage(JSON.stringify(envelope));
      },
    };
  }

  if (options.reactNative) {
    const reactNative = readPostable(
      (window as Window & { ReactNativeWebView?: unknown }).ReactNativeWebView,
    );
    if (reactNative) {
      const postMessage = reactNative.postMessage.bind(reactNative);
      return {
        name: 'react-native',
        post(envelope) {
          postMessage(JSON.stringify(envelope));
        },
      };
    }
  }

  return null;
}

function assertPositiveTimeout(timeout: number): void {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new BridgeError('INVALID_TIMEOUT', 'timeout must be a finite number greater than 0');
  }
}

function resolveOptions(options: WebViewBridgeOptions): ResolvedOptions {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  assertPositiveTimeout(timeout);
  return {
    iosHandler: options.iosHandler ?? DEFAULT_IOS_HANDLER,
    androidInterface: options.androidInterface ?? DEFAULT_ANDROID_INTERFACE,
    reactNative: options.reactNative ?? true,
    transport: options.transport,
    timeout,
    receiveName: options.receiveName ?? DEFAULT_RECEIVE_NAME,
    listen: options.listen ?? true,
    announceReady: options.announceReady ?? false,
  };
}

function globalHost(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  return window as unknown as Record<string, unknown>;
}

export class WebViewBridge<
  TOut extends MethodMap = DefaultMethods,
  TEvents extends EventMap = DefaultEvents,
  TIn extends MethodMap = DefaultMethods,
> {
  readonly #options: ResolvedOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Map<string, Set<EventHandler>>();
  readonly #handlers = new Map<string, InboundHandler>();
  #detected: Transport | null = null;
  #destroyed = false;

  /** Bound once so `window` listeners and the global can be removed exactly. */
  readonly #onMessage = (event: Event): void => {
    this.receive((event as MessageEvent).data);
  };

  constructor(options: WebViewBridgeOptions = {}) {
    this.#options = resolveOptions(options);
    this.#attach();
    if (this.#options.announceReady) this.announceReady();
  }

  /** In-flight requests. Returns to 0 on settle, timeout, post failure, and `destroy`. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Injected transport name, or the detected name after the first successful send.
   * `null` until detection succeeds.
   */
  get transportName(): string | null {
    return this.#options.transport?.name ?? this.#detected?.name ?? null;
  }

  /**
   * Ask native to run `method` and resolve with the matching response payload.
   * The promise rejects with `BridgeError` on timeout, an error envelope, or post failure.
   * Pass timeout options as the third argument: `request(method, payload, { timeout })`.
   * For a `void` payload, omit it or pass `undefined`: `request('ui.close', undefined, { timeout })`.
   */
  request<K extends keyof TOut & string>(
    method: K,
    ...args: RequestArgs<PayloadOf<TOut, K>>
  ): Promise<ResultOf<TOut, K>> {
    const payload = args[0];
    const options = (args as unknown[])[1] as RequestOptions | undefined;
    return this.#request(String(method), payload, options) as Promise<ResultOf<TOut, K>>;
  }

  /**
   * Tell native the page is listening: emits `READY_EVENT` with `{ version }`.
   * Call it once after your `on` / `handle` registrations.
   * Returns `false` instead of throwing when no host is present (a normal browser),
   * so the same code runs inside and outside the app.
   */
  announceReady(): boolean {
    if (this.#destroyed) return false;
    try {
      this.#post(createEnvelope('event', createId(), READY_EVENT, { version: PROTOCOL_VERSION }));
      return true;
    } catch {
      return false;
    }
  }

  /** Subscribe to a native → web event. The returned function is `off` for this handler. */
  on<K extends keyof TEvents & string>(name: K, handler: (payload: TEvents[K]) => void): () => void {
    this.#assertActive();
    const key = String(name);
    const set = this.#bucket(key);
    set.add(handler as EventHandler);
    return () => this.off(name, handler);
  }

  /** Remove one subscriber. No-op when that function was not registered. */
  off<K extends keyof TEvents & string>(name: K, handler: (payload: TEvents[K]) => void): void {
    const key = String(name);
    const set = this.#listeners.get(key);
    if (!set) return;
    set.delete(handler as EventHandler);
    if (set.size === 0) this.#listeners.delete(key);
  }

  /** Fire-and-forget web → native event. Does not call local `on` subscribers. */
  emit<K extends keyof TEvents & string>(name: K, ...args: EmitArgs<TEvents[K]>): void {
    const payload = args[0];
    this.#post(createEnvelope('event', createId(), String(name), payload));
  }

  /**
   * Handle a native → web request. Replaces any previous handler for `method`.
   * The returned function unregisters this handler only if it is still current.
   * Throw `BridgeError` to choose the error code sent back to native.
   */
  handle<K extends keyof TIn & string>(
    method: K,
    handler: (payload: PayloadOf<TIn, K>) => ResultOf<TIn, K> | Promise<ResultOf<TIn, K>>,
  ): () => void {
    this.#assertActive();
    const key = String(method);
    const wrapped: InboundHandler = (payload) => handler(payload as PayloadOf<TIn, K>);
    this.#handlers.set(key, wrapped);
    return () => {
      if (this.#handlers.get(key) === wrapped) this.#handlers.delete(key);
    };
  }

  /**
   * Native → web entry point. Accepts an envelope object or a JSON string.
   * Invalid messages are ignored. Also installed as `window[receiveName]`.
   */
  readonly receive = (input: unknown): void => {
    if (this.#destroyed) return;
    const envelope = parseEnvelope(input);
    if (!envelope) return;

    if (envelope.kind === 'response') {
      this.#settleResponse(envelope);
      return;
    }
    if (envelope.kind === 'event') {
      this.#dispatchEvent(envelope);
      return;
    }
    this.#dispatchRequest(envelope);
  };

  /** Drop listeners, remove the global, and reject every in-flight request. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    const host = globalHost();
    if (host) {
      if (host[this.#options.receiveName] === this.receive) {
        delete host[this.#options.receiveName];
      }
      if (this.#options.listen) {
        window.removeEventListener('message', this.#onMessage);
        (document as EventTarget).removeEventListener('message', this.#onMessage);
      }
    }

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BridgeError('DESTROYED', `Bridge destroyed before "${pending.method}" completed`),
      );
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#handlers.clear();
    this.#detected = null;
  }

  #bucket(name: string): Set<EventHandler> {
    let set = this.#listeners.get(name);
    if (!set) {
      set = new Set();
      this.#listeners.set(name, set);
    }
    return set;
  }

  #attach(): void {
    const host = globalHost();
    if (!host || typeof document === 'undefined') return;

    const previous = host[this.#options.receiveName];
    if (typeof previous === 'function') {
      console.warn(
        `[webview-bridge] Replacing window.${this.#options.receiveName}. Use one bridge per page.`,
      );
    }
    host[this.#options.receiveName] = this.receive;

    if (!this.#options.listen) return;
    window.addEventListener('message', this.#onMessage);
    (document as EventTarget).addEventListener('message', this.#onMessage);
  }

  #request(method: string, payload: unknown, options: RequestOptions | undefined): Promise<unknown> {
    if (this.#destroyed) {
      return Promise.reject(new BridgeError('DESTROYED', 'Bridge has been destroyed'));
    }

    let timeout: number;
    try {
      timeout = options?.timeout ?? this.#options.timeout;
      assertPositiveTimeout(timeout);
    } catch (error) {
      return Promise.reject(toBridgeError(error, 'INVALID_TIMEOUT'));
    }

    const id = createId();
    const envelope = createEnvelope('request', id, method, payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#rejectPending(
          id,
          new BridgeError('TIMEOUT', `Request "${method}" timed out after ${timeout}ms`),
        );
      }, timeout);

      this.#pending.set(id, { method, resolve, reject, timer });

      try {
        this.#post(envelope);
      } catch (error) {
        this.#rejectPending(id, toBridgeError(error, 'POST_FAILED'));
      }
    });
  }

  #settleResponse(envelope: BridgeEnvelope): void {
    if (!this.#pending.has(envelope.id)) return;
    if (envelope.error) {
      this.#rejectPending(envelope.id, new BridgeError(envelope.error.code, envelope.error.message));
      return;
    }
    this.#resolvePending(envelope.id, envelope.payload);
  }

  #dispatchEvent(envelope: BridgeEnvelope): void {
    const set = this.#listeners.get(envelope.name);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(envelope.payload);
      } catch (error) {
        console.error(`[webview-bridge] event handler for "${envelope.name}" threw`, error);
      }
    }
  }

  #dispatchRequest(envelope: BridgeEnvelope): void {
    const handler = this.#handlers.get(envelope.name);
    if (!handler) {
      this.#reply(envelope, undefined, {
        code: 'METHOD_NOT_FOUND',
        message: `No handler for "${envelope.name}"`,
      });
      return;
    }

    let result: unknown;
    try {
      result = handler(envelope.payload);
    } catch (error) {
      const bridgeError = toBridgeError(error, 'HANDLER_ERROR');
      this.#reply(envelope, undefined, { code: bridgeError.code, message: bridgeError.message });
      return;
    }

    if (!isThenable(result)) {
      this.#reply(envelope, result);
      return;
    }

    void Promise.resolve(result).then(
      (value) => {
        if (this.#destroyed) return;
        this.#reply(envelope, value);
      },
      (error: unknown) => {
        if (this.#destroyed) return;
        const bridgeError = toBridgeError(error, 'HANDLER_ERROR');
        this.#reply(envelope, undefined, { code: bridgeError.code, message: bridgeError.message });
      },
    );
  }

  #reply(request: BridgeEnvelope, payload: unknown, error?: BridgeErrorBody): void {
    if (this.#destroyed) return;
    try {
      this.#post(
        createEnvelope('response', request.id, request.name, error ? undefined : payload, error),
      );
    } catch (error) {
      console.error('[webview-bridge] failed to deliver response', error);
    }
  }

  #post(envelope: BridgeEnvelope): void {
    this.#assertActive();
    this.#transport().post(envelope);
  }

  #transport(): Transport {
    if (this.#options.transport) return this.#options.transport;
    if (this.#detected) return this.#detected;
    const detected = detectTransport(this.#options);
    if (!detected) {
      const fallback = this.#options.reactNative ? ', and ReactNativeWebView' : '';
      throw new BridgeError(
        'TRANSPORT_UNAVAILABLE',
        `No WebView transport found. Looked for iOS handler "${this.#options.iosHandler}", Android interface "${this.#options.androidInterface}"${fallback}.`,
      );
    }
    this.#detected = detected;
    return detected;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new BridgeError('DESTROYED', 'Bridge has been destroyed');
    }
  }

  #take(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    return pending;
  }

  #resolvePending(id: string, payload: unknown): void {
    this.#take(id)?.resolve(payload);
  }

  #rejectPending(id: string, error: BridgeError): void {
    this.#take(id)?.reject(error);
  }
}
