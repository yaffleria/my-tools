# @my-tools/webview-bridge

앱(iOS·Android·React Native) 안의 WebView에서 도는 웹 페이지와 앱이 **메시지 한 가지 형식(envelope)**으로 주고받게 해 주는 웹 쪽 라이브러리입니다. 런타임 의존성이 없어서 폴더째 복사해 써도 됩니다.

- 처음이라면: [5분 개념](#5분-개념) → [빠른 시작](#빠른-시작) → 플레이그라운드에서 직접 눌러 보기
- 업무에 쓸 때: [빠른 시작](#빠른-시작) + [네이티브가 해야 할 일](#네이티브가-해야-할-일-체크리스트)
- AI에게 맡길 때: [AI에게 줄 지시문](#ai에게-줄-지시문)

## 5분 개념

**왜 필요한가.** WebView 통신은 비동기인데, 양쪽이 준비됐는지 확인하는 약속이 없으면 "가끔 안 된다"는 버그가 생깁니다. 앱이 페이지 스크립트가 뜨기 전에 보낸 메시지는 그냥 사라지고, 응답이 어느 요청의 것인지 짝지을 방법이 없으면 늦게 온 응답이 엉뚱한 곳에 들어갑니다. 흔히 "타이밍 이슈"라고 부르는 문제입니다.

**이 패키지의 약속은 세 가지입니다.**

1. **준비 신호(handshake)**: 웹이 듣기 시작하면 `bridge.ready` 이벤트를 보냅니다. 앱은 그 전까지 보낼 메시지를 큐에 쌓아 둡니다.
2. **봉투(envelope) 하나**: 모든 메시지는 `{ version, id, kind, name, payload?, error? }` 형식입니다.
3. **세 종류(kind)**: `request`(응답을 기다림) · `response`(같은 `id`로 답함) · `event`(보내고 끝).

```
웹(WebView)                                   앱(네이티브)
  │  new WebViewBridge(...)                      │
  │  on / handle 등록                            │
  │── event  bridge.ready ──────────────────────▶│  큐에 쌓아 둔 메시지 전송 시작
  │                                              │
  │── request  storage.get  id=A ───────────────▶│  처리
  │◀─ response storage.get  id=A  payload ───────│  → await가 풀림
  │                                              │
  │◀─ event    theme.changed  payload ───────────│  → on 콜백 실행
  │◀─ request  auth.token    id=B ───────────────│
  │── response auth.token    id=B  payload ─────▶│  ← handle 콜백 결과
```

- `request`마다 타임아웃이 있어서 앱이 답을 안 줘도 `TIMEOUT`으로 끝납니다. 영원히 기다리지 않습니다.
- 형식이 깨진 메시지나 모르는 `id`의 응답은 조용히 버립니다. 예외를 던지지 않습니다.

## 빠른 시작

```ts
import { WebViewBridge, type MethodDef } from '@my-tools/webview-bridge';

// 1. 주고받을 것을 타입으로 정의 (이게 곧 앱과의 계약서)
type WebToApp = {
  'storage.get': MethodDef<{ key: string }, { value: string | null }>;
  'ui.close': MethodDef<void, void>;
};
type Events = {
  'theme.changed': { mode: 'light' | 'dark' };
};
type AppToWeb = {
  'auth.token': MethodDef<void, { token: string }>;
};

// 2. 페이지당 하나 만들기
const bridge = new WebViewBridge<WebToApp, Events, AppToWeb>();

// 3. 듣기 등록을 먼저 하고
bridge.on('theme.changed', ({ mode }) => {
  document.documentElement.dataset.theme = mode;
});
bridge.handle('auth.token', () => ({ token: getToken() }));

// 4. 준비됐다고 알리기 (일반 브라우저에서는 false를 돌려줄 뿐 에러 없음)
bridge.announceReady();

// 5. 요청하기
const { value } = await bridge.request('storage.get', { key: 'lang' });
await bridge.request('ui.close', undefined, { timeout: 1_000 });
```

React에서는 `useEffect`에서 만들고 cleanup에서 `destroy()`합니다. 진행 중인 요청은 `DESTROYED`로 끝나고 리스너도 정리됩니다.

```tsx
useEffect(() => {
  const bridge = new WebViewBridge<WebToApp, Events, AppToWeb>();
  const off = bridge.on('theme.changed', ({ mode }) => setMode(mode));
  bridge.announceReady();
  bridgeRef.current = bridge;
  return () => {
    off();
    bridge.destroy();
  };
}, []);
```

### API 요약

| 메서드 | 방향 | 설명 |
| --- | --- | --- |
| `request(name, payload?, { timeout }?)` | 웹 → 앱 | 응답 payload로 resolve. 실패하면 `BridgeError`로 reject |
| `emit(name, payload?)` | 웹 → 앱 | 보내고 끝. 같은 페이지의 `on`은 부르지 않음 |
| `on(name, handler)` | 앱 → 웹 | 이벤트 구독. 해제 함수를 돌려줌 |
| `handle(name, handler)` | 앱 → 웹 | 앱의 요청에 답할 함수 등록. async 가능. `BridgeError`를 던지면 그 code가 앱으로 감 |
| `announceReady()` | 웹 → 앱 | `bridge.ready` 이벤트 전송. 호스트가 없으면 `false` |
| `destroy()` | — | 리스너·전역 함수 제거, 진행 중 요청 reject |

- 제네릭 순서는 `(웹 → 앱 메서드, 이벤트, 앱 → 웹 메서드)`입니다. 생략하면 느슨한 타입이 됩니다.
- payload가 `void`인 메서드만 payload를 생략할 수 있습니다. timeout은 **세 번째** 인자입니다.
- 페이지당 인스턴스는 하나입니다. 두 번째 인스턴스는 `window.__webviewBridgeReceive`를 덮어쓰고 경고를 남깁니다.

### 옵션

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `iosHandler` | `'bridge'` | `window.webkit.messageHandlers.<이름>` |
| `androidInterface` | `'Bridge'` | `window.<이름>.postMessage(json)` |
| `reactNative` | `true` | iOS·Android 핸들러가 없을 때 `window.ReactNativeWebView`로 대체 |
| `receiveName` | `'__webviewBridgeReceive'` | 앱이 `evaluateJavascript`로 부를 전역 함수 이름 |
| `listen` | `true` | `window`와 `document`의 `message` 이벤트를 들음 (React Native·Android 경로) |
| `timeout` | `10000` | `request` 기본 타임아웃(ms) |
| `announceReady` | `false` | 생성 직후 `announceReady()` 호출 |
| `transport` | 자동 탐지 | 직접 보낼 곳을 지정. 테스트나 다른 호스트용 |

## 네이티브가 해야 할 일 (체크리스트)

앱 개발자에게 이 표를 그대로 전달하면 됩니다. 아래 [프로토콜 스펙](#프로토콜-스펙)과 플랫폼별 예시 코드가 상세입니다.

- [ ] 페이지 로드 **전에** 핸들러 등록 (iOS `bridge`, Android `Bridge`)
- [ ] 웹에서 `event` `bridge.ready`가 오기 전까지 앱이 먼저 보내는 `event`·`request`를 **큐에 쌓아 두기**. 오면 순서대로 보내기. 웹의 요청에 대한 `response`는 큐를 거치지 않고 바로 보내기. 페이지가 새로 로드되면 다시 "준비 안 됨"으로 돌리기
- [ ] 받은 `request`에는 같은 `id`와 `name`으로 `response`를 **반드시 하나** 보내기. 처리할 수 없으면 `error: { code: "METHOD_NOT_FOUND", message }`
- [ ] 웹으로 보낼 때는 `window.__webviewBridgeReceive(<json>)` 또는 `postMessage` 중 **하나만** 쓰기
- [ ] `version`이 1이 아니면 무시하기

## AI에게 줄 지시문

이 패키지로 기능을 만들게 할 때 아래를 그대로 붙여 넣으면 됩니다.

```text
WebView 통신은 @my-tools/webview-bridge를 쓴다. 규칙은 packages/webview-bridge/README.md를 따른다.
- 주고받을 메서드와 이벤트를 먼저 MethodDef 타입 map으로 정의한다: (웹→앱 메서드, 이벤트, 앱→웹 메서드).
- 브리지는 페이지당 하나. React에서는 useEffect에서 만들고 cleanup에서 destroy한다.
- on/handle 등록 후 announceReady()를 호출한다.
- request는 timeout을 세 번째 인자로 주고, BridgeError의 code(TIMEOUT, METHOD_NOT_FOUND 등)로 분기한다.
- 앱 쪽 코드가 필요하면 README의 iOS/Android/React Native 예시와 "네이티브가 해야 할 일" 체크리스트를 따른다.
```

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

### 준비 신호 (예약된 이벤트)

| 이름 | 방향 | payload | 규칙 |
| --- | --- | --- | --- |
| `bridge.ready` | 웹 → 앱 | `{ "version": 1 }` | 웹이 `announceReady()`를 부를 때 보낸다. 앱은 이걸 받기 전까지 앱이 먼저 보내는 `event`·`request`를 큐에 쌓고, 받으면 순서대로 보낸다. 웹 요청에 대한 `response`는 바로 보낸다(웹은 생성 시점부터 듣고 있다). 페이지가 새로 로드되면 다시 받을 때까지 쌓는다. |

`bridge.`로 시작하는 이름은 이 패키지가 예약한다. 앱의 메서드·이벤트 이름으로 쓰지 않는다.

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

기본값은 위 [옵션](#옵션) 표에 있다. `reactNative`와 `listen`의 기본값은 `true`다.

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
    // 웹이 bridge.ready를 보내기 전까지 웹으로 보낼 메시지를 쌓아 둔다.
    private var isWebReady = false
    private var outbox: [[String: Any]] = []

    /// 새 페이지를 로드할 때 호출 (WKNavigationDelegate didStartProvisionalNavigation 등)
    func pageWillLoad() {
        isWebReady = false
    }

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
            if envelope.name == "bridge.ready" {
                isWebReady = true
                let queued = outbox
                outbox.removeAll()
                queued.forEach(deliver)
                return
            }
            // 그 밖의 envelope.name / envelope.payload를 전달. 응답하지 않음
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
        // 응답은 웹이 보낸 요청에 대한 것이라 웹이 이미 듣고 있다. 큐에 넣지 않는다.
        guard isWebReady || (body["kind"] as? String) == "response" else {
            outbox.append(body)
            return
        }
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
    // 웹이 bridge.ready를 보내기 전까지 웹으로 보낼 메시지를 쌓아 둔다. WebView 스레드에서만 만진다.
    private var isWebReady = false
    private val outbox = ArrayDeque<JSONObject>()

    /** 새 페이지를 로드할 때 호출 (WebViewClient.onPageStarted 등) */
    fun pageWillLoad() {
        webView.post { isWebReady = false }
    }

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
            "event" -> if (name == "bridge.ready") {
                webView.post {
                    isWebReady = true
                    while (outbox.isNotEmpty()) send(outbox.removeFirst())
                }
            } // 그 밖의 name / payload를 전달. 응답하지 않음
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
        webView.post {
            // 응답은 웹이 보낸 요청에 대한 것이라 웹이 이미 듣고 있다. 큐에 넣지 않는다.
            if (isWebReady || body.optString("kind") == "response") send(body) else outbox.addLast(body)
        }
    }

    private fun send(body: JSONObject) {
        val quoted = JSONObject.quote(body.toString())
        webView.evaluateJavascript("window.__webviewBridgeReceive($quoted)", null)
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
  // 웹이 bridge.ready를 보내기 전까지 웹으로 보낼 메시지를 쌓아 둔다.
  const ready = useRef(false);
  const outbox = useRef<string[]>([]);

  // 앱이 먼저 보내는 event/request는 이 함수로 보낸다.
  function send(json: string) {
    if (ready.current) ref.current?.postMessage(json);
    else outbox.current.push(json);
  }
  // 예: send(JSON.stringify({ version: 1, id: uuid(), kind: 'event', name: 'theme.changed', payload: { mode: 'dark' } }))

  function onMessage(event: WebViewMessageEvent) {
    const message = JSON.parse(event.nativeEvent.data) as {
      version: number;
      id: string;
      kind: string;
      name: string;
      payload?: unknown;
    };
    if (message.version !== 1) return;
    if (message.kind === 'event' && message.name === 'bridge.ready') {
      ready.current = true;
      outbox.current.splice(0).forEach((json) => ref.current?.postMessage(json));
      return;
    }
    if (message.kind !== 'request') return;

    // 응답은 웹이 이미 듣고 있으니 큐를 거치지 않고 바로 보낸다.
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

  return (
    <WebView
      ref={ref}
      source={{ uri: 'https://app.example' }}
      onMessage={onMessage}
      onLoadStart={() => {
        ready.current = false; // 새 페이지는 다시 준비 신호를 기다린다
      }}
    />
  );
}
```

React Native의 `postMessage`는 `message` 이벤트로 도착한다. 이 패키지가 이미 듣고 있다.

## 빌드

패키지는 ESM과 `dist/`의 `.d.ts`로 컴파일된다. 테스트는 Vitest다.

```bash
pnpm --filter @my-tools/webview-bridge test
pnpm --filter @my-tools/webview-bridge build
```
