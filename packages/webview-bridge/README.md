# @my-tools/webview-bridge

A page inside a WebView talks to the host app with one JSON envelope. This package is the web side. It has no runtime dependencies. Copy the folder into a workspace and depend on it.

The native side is not a library. It is the small Swift or Kotlin snippet below, speaking the same envelope.

```ts
import { WebViewBridge, type MethodDef } from '@my-tools/webview-bridge';

type Methods = {
  'storage.get': MethodDef<{ key: string }, { value: string | null }>;
  'ui.close': MethodDef<void, void>;
};

type Events = {
  'theme.changed': { mode: 'light' | 'dark' };
  resume: void;
};

type HostMethods = {
  'auth.token': MethodDef<void, { token: string }>;
};

const bridge = new WebViewBridge<Methods, Events, HostMethods>();

const { value } = await bridge.request('storage.get', { key: 'token' });
await bridge.request('ui.close', undefined, { timeout: 1_000 });

const stop = bridge.on('theme.changed', ({ mode }) => {
  document.documentElement.dataset.theme = mode;
});
bridge.emit('resume');

bridge.handle('auth.token', () => ({ token: '…' }));

// later
stop();
bridge.destroy();
```

Generics are `(outbound methods, events, inbound methods)`. Each defaults to a loose map, so `new WebViewBridge()` also works. `request(method, payload, { timeout })` — timeout is the third argument. Omit the payload only when that method's payload is `void`.

Create one bridge per page. A second instance replaces `window.__webviewBridgeReceive` and logs a warning. Call `destroy()` on teardown so in-flight `request`s reject and the listeners come off.

## Protocol spec

Every message in either direction is one envelope. Unknown versions and malformed messages are ignored, not thrown.

```json
{
  "version": 1,
  "id": "8b1c1e4a-3d0e-4f1a-9c2b-6a0d5e7f1234",
  "kind": "request",
  "name": "storage.get",
  "payload": { "key": "token" }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `version` | yes | Number `1`. Any other value is ignored by the web side. |
| `id` | yes | Non-empty string. A response copies the request id. Events still get a fresh id so logs can point at one message. |
| `kind` | yes | `"request"`, `"response"`, or `"event"`. |
| `name` | yes | Non-empty string. Method name for request and response (the response repeats it). Event name for event. |
| `payload` | no | Any JSON value, including `0`, `false`, `null`, and `""`. Omit the key when there is no payload. |
| `error` | no | Only legal on `kind: "response"`. Shape is `{ "code": string, "message": string }`. `code` is a non-empty string. When `error` is present it is the result, and `payload` is ignored. |

`kind` decides what the message means. A request is never completed by another message that merely reuses its id.

| `kind` | Sender | Receiver does |
| --- | --- | --- |
| `request` | either side | Run `name`, then send one `response` with the same `id` and `name`. |
| `response` | either side | Complete the pending call for `id`. Ignore unknown ids. |
| `event` | either side | Deliver `name` / `payload`. Do not reply. |

Web → native calls from this package:

| Host | Call | Body |
| --- | --- | --- |
| iOS WKWebView | `window.webkit.messageHandlers.<iosHandler>.postMessage(envelope)` | Object. Default handler name `bridge`. |
| Android WebView | `window.<androidInterface>.postMessage(json)` | JSON string. Default interface name `Bridge`. |
| React Native WebView | `window.ReactNativeWebView.postMessage(json)` | JSON string. Used only when the iOS and Android handlers are absent. |

The first match is cached on the instance. Until one exists, each send looks again, so the bridge may be constructed before the host injects its interface. Pass `transport` to skip detection (tests, or a host that is neither of the three).

Native → web, either of these, not both for one message:

- `evaluateJavascript` / `evaluateJavaScript` of `window.__webviewBridgeReceive(<json or json-string>)`.
- A `message` event whose `data` is the envelope object or a JSON string. React Native's `postMessage` arrives this way. On Android that event is dispatched on `document`, so the bridge listens on `window` and `document`.

`receive` accepts an object or a string. A string that parses to another string is parsed once more, so a host that quotes JSON twice still works. Anything that is not a valid version-1 envelope is dropped.

Override the defaults with `iosHandler`, `androidInterface`, `receiveName`, `reactNative: false`, `listen: false`, and `timeout` (default `10000` ms).

### Errors raised on the web side

`request` rejects with `BridgeError` (`error.code`, `error.message`). `handle` callbacks may throw `BridgeError` to choose the code that goes back to native. Any other throw is sent as `HANDLER_ERROR`.

| `code` | When |
| --- | --- |
| `TIMEOUT` | No response before the timeout. The pending entry is already gone; a late response is ignored. |
| `DESTROYED` | `destroy()` ran, or a method was used after that. |
| `TRANSPORT_UNAVAILABLE` | No iOS handler, Android interface, or React Native bridge. |
| `POST_FAILED` | The transport threw (Android `JSON.stringify` on a cycle, for example). |
| `INVALID_TIMEOUT` | `timeout` was not a finite number greater than 0. |
| `METHOD_NOT_FOUND` | Native called a method that has no `handle`. |
| `HANDLER_ERROR` | A `handle` callback threw something other than `BridgeError`. |

Codes on a response envelope are passed through unchanged. `pendingCount` is `0` after resolve, reject, timeout, post failure, and `destroy`.

This channel is visible to every script on the page. Treat `handle` methods as a public API.

## iOS

Register the handler before the page loads. The name must match `iosHandler` (`bridge` by default). `WKScriptMessageHandler` is retained by the content controller; keep only a weak reference to the web view.

`message.body` for a call from this package is the envelope dictionary, not a string. Replies go out through `evaluateJavaScript`. Compact JSON from `JSONSerialization` is a JavaScript literal, which `receive` accepts as an object.

```swift
import WebKit

struct BridgeEnvelope {
    let id: String
    let kind: String
    let name: String
    let payload: Any?
    let error: [String: String]?
}

final class WebBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let envelope = Self.parse(message.body) else { return }
        switch envelope.kind {
        case "request":
            handle(envelope)
        case "response":
            break // complete the native call stored under envelope.id
        case "event":
            break // deliver envelope.name / envelope.payload, do not reply
        default:
            break
        }
    }

    private func handle(_ request: BridgeEnvelope) {
        if request.name == "ping" {
            reply(to: request, payload: ["pong": true])
            return
        }
        reply(to: request, errorCode: "METHOD_NOT_FOUND", errorMessage: "No handler for \(request.name)")
    }

    private func reply(
        to request: BridgeEnvelope,
        payload: Any? = nil,
        errorCode: String? = nil,
        errorMessage: String? = nil
    ) {
        var body: [String: Any] = [
            "version": 1,
            "id": request.id,
            "kind": "response",
            "name": request.name,
        ]
        if let errorCode, let errorMessage {
            body["error"] = ["code": errorCode, "message": errorMessage]
        } else if let payload {
            body["payload"] = payload
        }
        deliver(body)
    }

    private func deliver(_ body: [String: Any]) {
        guard
            let webView,
            JSONSerialization.isValidJSONObject(body),
            let data = try? JSONSerialization.data(withJSONObject: body),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("window.__webviewBridgeReceive(\(json))")
    }

    private static func parse(_ body: Any) -> BridgeEnvelope? {
        guard
            let object = body as? [String: Any],
            (object["version"] as? Int) == 1,
            let id = object["id"] as? String, !id.isEmpty,
            let kind = object["kind"] as? String,
            let name = object["name"] as? String, !name.isEmpty
        else { return nil }
        return BridgeEnvelope(
            id: id,
            kind: kind,
            name: name,
            payload: object["payload"],
            error: object["error"] as? [String: String]
        )
    }
}

// configuration.userContentController.add(bridge, name: "bridge")
```

To push an event, `deliver` the same fields with `"kind": "event"` and a new id.

## Android

Enable JavaScript and add the interface before `loadUrl`. The object name must match `androidInterface` (`Bridge` by default). The method name must be `postMessage`. On API 17+ the method needs `@JavascriptInterface`.

Calls from JavaScript arrive on a binder thread. Parse there if you want, but call `evaluateJavascript` on the WebView thread. `JSONObject.quote` produces a JavaScript string literal, which avoids breaking out of the surrounding script.

```kotlin
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

class WebBridge(private val webView: WebView) {
    @JavascriptInterface
    fun postMessage(raw: String) {
        val body = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }
        if (body.optInt("version") != 1) return
        val id = body.optString("id")
        val kind = body.optString("kind")
        val name = body.optString("name")
        if (id.isEmpty() || name.isEmpty()) return

        when (kind) {
            "request" -> onRequest(id, name, if (body.has("payload")) body.get("payload") else null)
            "response" -> Unit // complete the native call stored under id
            "event" -> Unit // deliver name / payload, do not reply
        }
    }

    private fun onRequest(id: String, name: String, payload: Any?) {
        if (name == "ping") {
            reply(id, name, JSONObject().put("pong", true))
        } else {
            replyError(id, name, "METHOD_NOT_FOUND", "No handler for $name")
        }
    }

    private fun reply(id: String, name: String, payload: Any?) {
        val body = base(id, name)
        if (payload != null) body.put("payload", payload)
        deliver(body)
    }

    private fun replyError(id: String, name: String, code: String, message: String) {
        deliver(base(id, name).put("error", JSONObject().put("code", code).put("message", message)))
    }

    private fun base(id: String, name: String): JSONObject {
        return JSONObject()
            .put("version", 1)
            .put("id", id)
            .put("kind", "response")
            .put("name", name)
    }

    private fun deliver(body: JSONObject) {
        val quoted = JSONObject.quote(body.toString())
        webView.post {
            webView.evaluateJavascript("window.__webviewBridgeReceive($quoted)", null)
        }
    }
}

// webView.settings.javaScriptEnabled = true
// webView.addJavascriptInterface(WebBridge(webView), "Bridge")
```

`optInt("version")` is `0` when the field is missing or not a number, so a string `"1"` is rejected, matching the web parser.

## React Native

The web bridge finds `window.ReactNativeWebView` on its own. No native module is required.

```tsx
import { useRef } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

export function Screen() {
  const ref = useRef<WebView>(null);

  function onMessage(event: WebViewMessageEvent) {
    const message = JSON.parse(event.nativeEvent.data) as {
      version: number;
      id: string;
      kind: string;
      name: string;
      payload?: unknown;
    };
    if (message.version !== 1 || message.kind !== 'request') return;

    ref.current?.postMessage(
      JSON.stringify({
        version: 1,
        id: message.id,
        kind: 'response',
        name: message.name,
        payload: { ok: true },
      }),
    );
  }

  return <WebView ref={ref} source={{ uri: 'https://app.example' }} onMessage={onMessage} />;
}
```

`postMessage` from React Native arrives as a `message` event. This package already listens for it.

## Build

The package compiles to ESM plus `.d.ts` in `dist/`. Tests are Vitest.

```bash
pnpm --filter @my-tools/webview-bridge test
pnpm --filter @my-tools/webview-bridge build
```
