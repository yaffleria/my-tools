# @my-tools/mobile-web

모바일 웹(그리고 앱 WebView 안 페이지)에서 자주 만드는 화면 부품입니다. 런타임 의존성은 `react`(18 이상)뿐입니다.

| export | 용도 |
| --- | --- |
| `useCameraStream(options?)` | 카메라를 `<video>`에 띄우고, 화면을 떠나면 끄기 |
| `captureFrame(video, options?)` | 지금 화면을 캔버스로 캡처해 압축된 Blob으로 |
| `isCameraSupported()` | `getUserMedia`를 쓸 수 있는 환경인지 |
| `<SignaturePad ref>` | 손가락·마우스·펜 서명 패드 |

플레이그라운드의 "카메라", "서명" 페이지에서 휴대폰으로 직접 써 볼 수 있습니다.

## 카메라

```tsx
import { captureFrame, useCameraStream } from '@my-tools/mobile-web';

function IdCapture({ onShot }: { onShot: (blob: Blob) => void }) {
  const { videoRef, status, start, stop } = useCameraStream({ facingMode: 'environment' });

  return (
    <>
      {status !== 'live' && <button onClick={start}>카메라 켜기</button>}
      {status === 'denied' && <FallbackInputCapture />}
      {/* iOS는 playsInline이 없으면 전체 화면으로 튀어나감 */}
      <video ref={videoRef} autoPlay playsInline muted hidden={status !== 'live'} />
      {status === 'live' && (
        <button
          onClick={async () => {
            onShot(await captureFrame(videoRef.current!, { maxWidth: 1280, quality: 0.8 }));
            stop();
          }}
        >
          촬영
        </button>
      )}
    </>
  );
}
```

`status`는 `'idle' | 'starting' | 'live' | 'denied' | 'unsupported' | 'error'`입니다. 권한이 거부되거나(`denied`) 지원되지 않으면(`unsupported`) 아래 input 방식으로 대체하세요.

```tsx
<input type="file" accept="image/*" capture="environment" onChange={(e) => onShot(e.target.files![0])} />
```

### 꼭 알아 둘 것

- `getUserMedia`는 **HTTPS**(또는 localhost)에서만 동작합니다.
- 언마운트되면 훅이 트랙을 `stop()`해서 카메라 표시등이 꺼집니다.
- **WebView 안이라면 앱 쪽 작업이 필요합니다.**
  - Android: 앱이 `WebChromeClient.onShowFileChooser`(input 방식)와 `onPermissionRequest`(getUserMedia)를 구현해야 합니다. 안 하면 눌러도 아무 반응이 없습니다.
  - iOS: Info.plist에 `NSCameraUsageDescription`이 필요합니다. WKWebView의 getUserMedia는 iOS 14.3부터입니다.
- 신분증 같은 개인정보는 메모리에서만 다루고, localStorage나 로그에 남기지 마세요. 업로드할 땐 암호화를 고려하세요.

## 서명

```tsx
import { SignaturePad, type SignaturePadHandle } from '@my-tools/mobile-web';

function SignStep({ onDone }: { onDone: (png: Blob) => void }) {
  const pad = useRef<SignaturePadHandle>(null);
  const [empty, setEmpty] = useState(true);

  return (
    <>
      <SignaturePad ref={pad} height={200} color="#111" onEmptyChange={setEmpty} style={{ background: '#fff' }} />
      <button onClick={() => pad.current?.clear()}>다시 쓰기</button>
      <button disabled={empty} onClick={async () => onDone((await pad.current!.toBlob())!)}>
        서명 완료
      </button>
    </>
  );
}
```

| prop | 기본값 | 설명 |
| --- | --- | --- |
| `height` | `200` | CSS 높이. 너비는 부모를 따름 |
| `lineWidth` | `2.5` | 선 굵기(CSS px) |
| `color` | 요소의 CSS `color` | 잉크 색. 다크 모드에서도 흰 바탕에 검정이 필요하면 지정 |
| `onEmptyChange` | — | 비었을 때 `true`, 첫 획 뒤 `false` |

ref 핸들: `clear()`, `isEmpty()`, `toBlob(type?, quality?)`, `toDataURL(type?, quality?)`. 비어 있으면 `null`을 돌려줍니다.

### 모바일에서 동작하는 이유 (학습용)

- **Pointer Events** 하나로 마우스·터치·펜을 같이 처리합니다.
- **`touch-action: none`**으로 서명하는 동안 페이지 스크롤·확대·당겨서 새로고침을 막습니다.
- **`setPointerCapture`**로 손가락이 캔버스 밖으로 나가도 획이 끊기지 않습니다.
- 캔버스 해상도를 **`devicePixelRatio`**만큼 키워 레티나에서 선이 흐려지지 않습니다.
- 모바일은 주소창이 접힐 때 `resize`가 납니다. `canvas.width`를 다시 설정하면 그림이 지워지므로, **크기가 실제로 바뀔 때만** 맞추고 그때도 기존 그림을 복사해 뒀다가 다시 그립니다.
- 획을 그리는 동안의 상태는 ref에 둬서 포인터가 움직일 때마다 리렌더되지 않습니다.

## AI에게 줄 지시문

```text
모바일 웹 카메라·서명은 @my-tools/mobile-web을 쓴다 (packages/mobile-web/README.md).
- 카메라: useCameraStream + captureFrame. denied/unsupported면 <input type="file" accept="image/*" capture="environment">로 대체한다.
- video에는 autoPlay playsInline muted를 붙인다. WebView라면 README의 Android/iOS 앱 쪽 요구사항을 함께 안내한다.
- 서명: <SignaturePad ref>와 핸들(clear, isEmpty, toBlob). 빈 서명은 제출을 막는다.
- 개인정보 이미지는 메모리에서만 다루고 저장·로그 금지.
```
