# @my-tools/webview-bridge

WebView 안의 페이지와 호스트 앱이 JSON envelope 하나로 통신한다. 이 패키지는 웹 쪽이다. 런타임 의존성은 없다. 폴더를 workspace에 복사해서 의존성으로 두면 된다.

네이티브 쪽은 아래 Swift 또는 Kotlin 스니펫이다. 같은 envelope를 말하면 된다.

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

// 해제할 때
stop();
bridge.destroy();
```

제네릭 순서는 `(나가는 메서드, 이벤트, 들어오는 메서드)`다. 각각 느슨한 map이 기본값이라 `new WebViewBridge()`도 된다. `request(method, payload, { timeout })`에서 timeout은 세 번째 인자다. payload가 `void`인 메서드만 payload를 생략한다.

페이지당 인스턴스는 하나다. 두 번째 인스턴스는 `window.__webviewBridgeReceive`를 덮어쓰고 경고를 남긴다. 정리할 때 `destroy()`를 호출하면 진행 중인 `request`는 reject되고 리스너는 제거된다.

## 프로토콜 스펙

양방향 메시지는 모두 envelope 하나다. version이 1이 아니거나 형식이 깨진 메시지는 무시한다. 예외는 던지지 않는다.

```json
{
  "version": 1,
  "id": "8b1c1e4a-3d0e-4f1a-9c2b-6a0d5e7f1234",
  "kind": "request",
  "name": "storage.get",
  "payload": { "key": "token" }
}
```

| 필드 | 필수 | 규칙 |
| --- | --- | --- |
| `version` | 예 | 숫자 `1`. 그 외 값은 웹에서 무시한다. |
| `id` | 예 | 비어 있지 않은 문자열. response는 request의 id를 그대로 복사한다. event도 로그에서 메시지를 집어낼 수 있게 새 id를 갖는다. |
| `kind` | 예 | `"request"`, `"response"`, `"event"`. |
| `name` | 예 | 비어 있지 않은 문자열. request와 response의 메서드 이름이다. response는 같은 이름을 반복한다. event는 이벤트 이름이다. |
| `payload` | 아니오 | JSON 값. `0`, `false`, `null`, `""`도 유지한다. payload가 없으면 키를 뺀다. |
| `error` | 아니오 | `kind: "response"`에서만 허용. 형태는 `{ "code": string, "message": string }`. `code`는 비어 있지 않은 문자열이다. `error`가 있으면 그것이 결과이고 `payload`는 무시한다. |

의미를 정하는 것은 `kind`다. id만 같다고 request가 완료되지는 않는다.

| `kind` | 보낸 쪽 | 받는 쪽 |
| --- | --- | --- |
| `request` | 어느 쪽이든 | `name`을 실행하고, 같은 `id`와 `name`으로 `response`를 하나 보낸다. |
| `response` | 어느 쪽이든 | 그 `id`의 대기 중인 호출을 완료한다. 모르는 id는 무시한다. |
| `event` | 어느 쪽이든 | `name` / `payload`를 전달한다. 응답하지 않는다. |

이 패키지가 네이티브로 보내는 호출:

| 호스트 | 호출 | 본문 |
| --- | --- | --- |
| iOS WKWebView | `window.webkit.messageHandlers.<iosHandler>.postMessage(envelope)` | 객체. 기본 핸들러 이름은 `bridge`. |
| Android WebView | `window.<androidInterface>.postMessage(json)` | JSON 문자열. 기본 인터페이스 이름은 `Bridge`. |
| React Native WebView | `window.ReactNativeWebView.postMessage(json)` | JSON 문자열. iOS와 Android 핸들러가 둘 다 없을 때만 쓴다. |

처음 찾은 transport는 인스턴스에 캐시한다. 하나도 없으면 보낼 때마다 다시 찾으므로, 호스트가 인터페이스를 주입하기 전에 브리지를 만들어도 된다. 탐색을 건너뛰려면 `transport`를 넘긴다. 테스트나, 위 세 가지가 아닌 호스트에 쓴다.

네이티브에서 웹으로는 아래 중 하나만 쓴다. 한 메시지에 둘 다 쓰지 않는다.

- `window.__webviewBridgeReceive(<json 또는 json 문자열>)`를 `evaluateJavascript` / `evaluateJavaScript`로 실행한다.
- `data`가 envelope 객체이거나 JSON 문자열인 `message` 이벤트. React Native의 `postMessage`는 이 경로로 온다. Android에서는 이 이벤트가 `document`로 오므로, 브리지는 `window`와 `document`를 둘 다 듣는다.

`receive`는 객체와 문자열을 받는다. 파싱 결과가 다시 문자열이면 한 번 더 파싱한다. 네이티브가 JSON을 두 번 감싸도 동작한다. version 1 envelope가 아니면 버린다.

기본값은 `iosHandler`, `androidInterface`, `receiveName`, `reactNative: false`, `listen: false`, `timeout`(기본 `10000`ms)으로 덮어쓴다.

### 웹에서 나는 에러

`request`는 `BridgeError`(`error.code`, `error.message`)로 reject된다. `handle` 콜백이 `BridgeError`를 던지면 그 code가 네이티브로 돌아간다. 그 외 예외는 `HANDLER_ERROR`로 보낸다.

| `code` | 언제 |
| --- | --- |
| `TIMEOUT` | timeout 안에 응답이 없다. pending 항목은 이미 제거되어 있고, 늦은 응답은 무시한다. |
| `DESTROYED` | `destroy()`가 이미 호출됐거나, 그 뒤에 메서드를 호출했다. |
| `TRANSPORT_UNAVAILABLE` | iOS 핸들러, Android 인터페이스, React Native 브리지가 없다. |
| `POST_FAILED` | transport가 예외를 던졌다. 예: Android에서 순환 참조를 `JSON.stringify`할 때. |
| `INVALID_TIMEOUT` | `timeout`이 0보다 큰 유한 수가 아니다. |
| `METHOD_NOT_FOUND` | 네이티브가 `handle`이 없는 메서드를 호출했다. |
| `HANDLER_ERROR` | `handle` 콜백이 `BridgeError`가 아닌 값을 던졌다. |

response envelope에 실린 code는 그대로 전달된다. resolve, reject, timeout, 전송 실패, `destroy` 이후 `pendingCount`는 `0`이다.

이 채널은 페이지의 모든 스크립트에 보인다. `handle` 메서드는 공개 API로 둔다.

## iOS

페이지를 로드하기 전에 핸들러를 등록한다. 이름은 `iosHandler`와 같아야 한다. 기본값은 `bridge`. `WKScriptMessageHandler`는 content controller가 붙잡으므로, web view는 weak 참조만 둔다.

이 패키지가 보낸 호출의 `message.body`는 문자열이 아니라 envelope dictionary다. 응답은 `evaluateJavaScript`로 보낸다. `JSONSerialization`의 compact JSON은 JavaScript 리터럴이라 `receive`가 객체로 받는다.

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
            break // envelope.id로 저장해 둔 네이티브 호출을 완료
        case "event":
            break // envelope.name / envelope.payload를 전달. 응답하지 않음
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

이벤트를 보낼 때는 같은 필드로 `deliver`하되 `"kind": "event"`와 새 id를 쓴다.

## Android

`loadUrl` 전에 JavaScript를 켜고 인터페이스를 붙인다. 객체 이름은 `androidInterface`와 같아야 한다. 기본값은 `Bridge`. 메서드 이름은 `postMessage`다. API 17 이상은 `@JavascriptInterface`가 필요하다.

JavaScript 호출은 binder 스레드로 들어온다. 파싱은 그 스레드에서 해도 된다. `evaluateJavascript`는 WebView 스레드에서 호출한다. `JSONObject.quote`는 JavaScript 문자열 리터럴을 만들므로, 감싼 스크립트가 깨지지 않는다.

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
            "response" -> Unit // id로 저장해 둔 네이티브 호출을 완료
            "event" -> Unit // name / payload를 전달. 응답하지 않음
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

필드가 없거나 숫자가 아니면 `optInt("version")`은 `0`이다. 문자열 `"1"`은 거절되며, 웹 파서와 같다.

## React Native

웹 브리지는 `window.ReactNativeWebView`를 스스로 찾는다. 네이티브 모듈은 필요 없다.

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

React Native의 `postMessage`는 `message` 이벤트로 도착한다. 이 패키지가 이미 듣고 있다.

## 빌드

패키지는 ESM과 `dist/`의 `.d.ts`로 컴파일된다. 테스트는 Vitest다.

```bash
pnpm --filter @my-tools/webview-bridge test
pnpm --filter @my-tools/webview-bridge build
```
